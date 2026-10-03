import { Inject, Injectable } from '@nestjs/common';
import type { PaymentCreateInput } from '@fin/contracts';
import { allocate, Allocation, AllocationLine, AllocationRule, EngineError, OpenInstallment } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { DB_TOKEN, Db, Executor, isUniqueViolation, pgConstraint, Tx } from '../db/db';
import { GL, LedgerService, PostingLine } from '../ledger/ledger.service';
import { accrueInterest, rollStatuses } from '../lending/dues';
import { LoansService } from '../lending/loans.service';
import { fmtAmount, fmtDate, MessagingService } from '../messaging/messaging.service';
import { NumberingService } from '../numbering/numbering.service';
import { receiptPdf, ReceiptSnapshot, rupeesInWords } from './receipt';

const FAR_FUTURE = '9999-12-31';
const COMPONENT_ACCOUNT = { PENALTY: GL.PENAL_RECEIVABLE, FEE: GL.FEES_RECEIVABLE, INTEREST: GL.INTEREST_RECEIVABLE, PRINCIPAL: GL.LOAN_RECEIVABLE, ADVANCE: GL.CUSTOMER_ADVANCE } as const;
const COMPONENT_COLUMN = { PENALTY: 'penalty_paid', FEE: 'fees_paid', INTEREST: 'interest_paid', PRINCIPAL: 'principal_paid' } as const;
const DUPLICATE_WINDOW_MIN = 30;

type LoanRow = Awaited<ReturnType<PaymentsService['lockLoan']>>;
type Components = { penalty: Money; fee: Money; interest: Money; principal: Money; advance: Money };

function totals(lines: Pick<AllocationLine, 'component' | 'amount'>[]): Components {
  const t: Components = { penalty: Money.zero(), fee: Money.zero(), interest: Money.zero(), principal: Money.zero(), advance: Money.zero() };
  for (const l of lines) {
    const k = l.component.toLowerCase() as keyof Components;
    t[k] = t[k].plus(Money.of(l.amount));
  }
  return t;
}
const asStrings = (c: Components) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.toString()])) as Record<keyof Components, string>;

/**
 * Payments, allocation, receipts and reversals (docs 07 E4/E5/E10, 08).
 *
 * Every payment runs in one transaction under a row lock on its loan: allocation → installment
 * updates → journal → receipt → balances → closure check → messages. Either all of it is recorded
 * or none of it is. Payments are never edited; a wrong payment is reversed (two people) and
 * recorded again.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly ledger: LedgerService,
    private readonly loans: LoansService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
  ) {}

  private async lockLoan(tx: Tx, auth: AuthContext, id: string) {
    const loan = await this.loans
      .scoped(tx, auth)
      .selectAll('l')
      .select(['c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code', 'b.name as branch_name'])
      .where('l.id', '=', id)
      .forUpdate('l')
      .executeTakeFirst();
    if (!loan) throw notFound('Loan');
    return loan;
  }

  /** Unpaid amounts per installment and component. */
  private async openItems(db: Executor, loanId: string): Promise<OpenInstallment[]> {
    const rows = await db
      .selectFrom('loan_installments')
      .select(['id', 'installment_no', 'due_date', 'penalty_due', 'penalty_paid', 'fees_due', 'fees_paid', 'interest_due', 'interest_paid', 'principal_due', 'principal_paid'])
      .where('loan_id', '=', loanId)
      .where('status', 'not in', ['WAIVED', 'RESCHEDULED'])
      .where(sql<boolean>`total_paid < total_due`)
      .orderBy('due_date')
      .orderBy('installment_no')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      no: r.installment_no,
      dueDate: r.due_date,
      penalty: Money.of(r.penalty_due).minus(Money.of(r.penalty_paid)).toString(),
      fee: Money.of(r.fees_due).minus(Money.of(r.fees_paid)).toString(),
      interest: Money.of(r.interest_due).minus(Money.of(r.interest_paid)).toString(),
      principal: Money.of(r.principal_due).minus(Money.of(r.principal_paid)).toString(),
    }));
  }

  private remaining(items: OpenInstallment[]): Money {
    return Money.sum(items.flatMap((i) => [i.penalty, i.fee, i.interest, i.principal].map((x) => Money.of(x))));
  }

  private rule(loan: { allocation_rule: unknown }): AllocationRule {
    const r = loan.allocation_rule as AllocationRule;
    return { mode: r.mode, order: r.order, excessHandling: r.excessHandling };
  }

  /**
   * What a payment would do, without recording anything. Paying exactly the full remaining
   * balance settles the loan (all remaining scheduled dues ⚖); more than that is refused.
   */
  private plan(loan: LoanRow, items: OpenInstallment[], amount: string, today: string) {
    const remaining = this.remaining(items);
    const advance = Money.of(loan.advance_balance);
    const max = remaining.minus(advance);
    const amt = Money.of(amount);
    if (amt.gt(max)) {
      throw unprocessable(
        'EXCEEDS_BALANCE',
        max.isPositive() ? `The most this loan can accept is ₹${max.format({ symbol: false })} (full settlement)` : 'Nothing remains to be paid on this loan',
        { maxAmount: max.toString() },
      );
    }
    const fullSettlement = amt.eq(max) && max.isPositive();
    return { fullSettlement, asOf: fullSettlement ? FAR_FUTURE : today, remaining, advance };
  }

  async preview(auth: AuthContext, loanId: string, amount: string) {
    const loan = await this.loans
      .scoped(this.db, auth)
      .selectAll('l')
      .select(['c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code', 'b.name as branch_name'])
      .where('l.id', '=', loanId)
      .executeTakeFirst();
    if (!loan) throw notFound('Loan');
    if (loan.status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'Payments can only be recorded on active loans');
    const today = istToday();
    let items = await this.openItems(this.db, loanId);
    const p = this.plan(loan, items, amount, today);
    // On full settlement, any advance already held is applied first.
    if (p.fullSettlement && p.advance.isPositive()) items = this.simulate(items, allocate(items, p.advance.toString(), this.rule(loan), FAR_FUTURE).lines);
    const a = this.allocateOrExplain(items, amount, this.rule(loan), p.asOf);
    const after = this.simulate(items, a.lines);
    return {
      amount: Money.of(amount).toString(),
      fullSettlement: p.fullSettlement,
      lines: a.lines,
      components: asStrings(totals(a.lines)),
      ...this.describe(items, after, a, p.fullSettlement),
    };
  }

  private allocateOrExplain(items: OpenInstallment[], amount: string, rule: AllocationRule, asOf: string): Allocation {
    try {
      return allocate(items, amount, rule, asOf);
    } catch (e) {
      if (e instanceof EngineError) throw unprocessable(e.code, e.message);
      throw e;
    }
  }

  /** Apply allocation lines to an in-memory copy of the open items. */
  private simulate(items: OpenInstallment[], lines: AllocationLine[]): OpenInstallment[] {
    const out = items.map((i) => ({ ...i }));
    for (const l of lines) {
      if (l.component === 'ADVANCE') continue;
      const it = out.find((i) => i.id === l.installmentId)!;
      const key = ({ PENALTY: 'penalty', FEE: 'fee', INTEREST: 'interest', PRINCIPAL: 'principal' } as const)[l.component];
      it[key] = Money.of(it[key]).minus(Money.of(l.amount)).toString();
    }
    return out;
  }

  private describe(before: OpenInstallment[], after: OpenInstallment[], a: Allocation, full: boolean) {
    const touched = new Set(a.lines.filter((l) => l.installmentNo !== null).map((l) => l.installmentNo!));
    const left = (i: OpenInstallment) => Money.sum([i.penalty, i.fee, i.interest, i.principal].map((x) => Money.of(x)));
    // Fully paid installments may no longer be in `after` (it lists open installments only).
    const stillOpen = new Map(after.filter((i) => left(i).isPositive()).map((i) => [i.no, i]));
    const cleared = [...touched].filter((no) => !stillOpen.has(no)).sort((a, b) => a - b);
    const part = [...touched].filter((no) => stillOpen.has(no)).sort((a, b) => a - b);
    const next = after.find((i) => left(i).isPositive());
    return {
      installmentsCleared: cleared,
      installmentsPart: part,
      balanceAfter: Money.sum(after.map(left)).minus(Money.of(a.advance)).toString(),
      nextDue: !full && next ? { date: next.dueDate, amount: left(next).toString(), installmentNo: next.no } : null,
      wasDue: Money.sum(before.filter((i) => i.dueDate <= istToday()).map(left)).toString(),
    };
  }

  /** Where the money sits after this payment (doc 07 §3 `{coll}`). */
  private async debitAccount(tx: Tx, ctx: RequestContext, loan: LoanRow, input: PaymentCreateInput) {
    const branchAccount = async (prefix: string) => {
      const find = () => tx.selectFrom('accounts').select(['id', 'code']).where('code', '=', `${prefix}-${loan.branch_code}`).executeTakeFirst();
      let a = await find();
      if (!a) {
        // Branch created outside the normal path: create its standard accounts (idempotent).
        await this.ledger.ensureBranchAccounts(tx, { id: loan.branch_id, code: loan.branch_code, name: loan.branch_name });
        a = await find();
      }
      if (!a) throw unprocessable('ACCOUNT_MISSING', `Account ${prefix}-${loan.branch_code} does not exist. Ask an administrator to run setup.`);
      return a;
    };
    switch (input.method) {
      case 'CASH':
        if (input.atCounter) return { ...(await branchAccount('1110')), employeeId: null };
        if (!ctx.auth.employeeId) {
          throw unprocessable('NOT_AN_EMPLOYEE', 'Your sign-in is not linked to an employee, so field cash cannot be recorded against you. Record it as a branch counter collection.');
        }
        return { ...(await this.ledger.employeeCashAccount(tx, ctx.auth.employeeId)), employeeId: ctx.auth.employeeId };
      case 'UPI':
        return { ...(await branchAccount('1250')), employeeId: null };
      case 'CHEQUE':
        return { ...(await branchAccount('1130')), employeeId: null };
      case 'BANK_TRANSFER': {
        const a = await tx.selectFrom('accounts').select(['id', 'code']).where('id', '=', input.accountId!).where('subtype', '=', 'BANK').where('is_active', '=', true).executeTakeFirst();
        if (!a) throw unprocessable('ACCOUNT_MISMATCH', 'Choose one of the company bank accounts');
        return { ...a, employeeId: null };
      }
    }
  }

  /** Add (or, for a reversal, subtract) allocation amounts on the installments. */
  private async applyToInstallments(tx: Tx, lines: { installmentId: string | null; component: string; amount: string }[], sign: 1 | -1) {
    const per = new Map<string, Record<string, Money>>();
    for (const l of lines) {
      if (!l.installmentId || l.component === 'ADVANCE') continue;
      const col = COMPONENT_COLUMN[l.component as keyof typeof COMPONENT_COLUMN];
      const m = per.get(l.installmentId) ?? {};
      m[col] = (m[col] ?? Money.zero()).plus(Money.of(l.amount));
      per.set(l.installmentId, m);
    }
    for (const [id, cols] of per) {
      await tx
        .updateTable('loan_installments')
        .set((eb) => Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, eb(c as 'principal_paid', sign === 1 ? '+' : '-', v.toString())])))
        .where('id', '=', id)
        .execute();
    }
  }

  private creditLines(lines: AllocationLine[] | { component: string; amount: string }[], loan: { id: string; customer_id: string }): PostingLine[] {
    const t = totals(lines as AllocationLine[]);
    const memo = { penalty: 'Penal charges', fee: 'Fees', interest: 'Interest', principal: 'Principal', advance: 'Customer advance' };
    return (Object.keys(t) as (keyof Components)[])
      .filter((k) => t[k].isPositive())
      .map((k) => ({ account: COMPONENT_ACCOUNT[k.toUpperCase() as keyof typeof COMPONENT_ACCOUNT], credit: t[k], loanId: loan.id, customerId: loan.customer_id, memo: memo[k] }));
  }

  /* =========================== Record =========================== */

  async record(tx: Tx, ctx: RequestContext, loanId: string, input: PaymentCreateInput) {
    const loan = await this.lockLoan(tx, ctx.auth, loanId);
    if (loan.status !== 'ACTIVE') throw conflict('LOAN_NOT_ACTIVE', 'Payments can only be recorded on active loans');
    const today = istToday();
    const amount = Money.of(input.amount);

    // Interest falling due today must be on the books before a payment can settle it.
    await accrueInterest(tx, this.ledger, today, { loanIds: [loanId] });
    await rollStatuses(tx, today, [loanId]);

    if (input.method === 'UPI' || input.method === 'BANK_TRANSFER') {
      const dup = await tx
        .selectFrom('payments')
        .select(['payment_no'])
        .where('method', '=', input.method)
        .where(sql<boolean>`upper(reference_no) = ${input.reference!.toUpperCase()}`)
        .where('status', '<>', 'REVERSED')
        .executeTakeFirst();
      if (dup) throw conflict('DUPLICATE_REFERENCE', `This ${input.method === 'UPI' ? 'UPI transaction ID' : 'UTR'} was already recorded on payment ${dup.payment_no}`, { paymentNo: dup.payment_no });
    }
    if (input.method === 'CHEQUE') {
      const dup = await tx
        .selectFrom('payments')
        .select('payment_no')
        .where('loan_id', '=', loanId)
        .where('method', '=', 'CHEQUE')
        .where('reference_no', '=', input.reference!)
        .where('status', '<>', 'REVERSED')
        .executeTakeFirst();
      if (dup) throw conflict('DUPLICATE_REFERENCE', `Cheque ${input.reference} was already recorded on payment ${dup.payment_no}`, { paymentNo: dup.payment_no });
    }
    if (!input.confirmDuplicate) {
      const recent = await tx
        .selectFrom('payments')
        .select(['payment_no', 'received_at', 'method'])
        .where('loan_id', '=', loanId)
        .where('amount', '=', amount.toString())
        .where('status', '<>', 'REVERSED')
        .where('received_at', '>', new Date(Date.now() - DUPLICATE_WINDOW_MIN * 60_000))
        .executeTakeFirst();
      if (recent) {
        throw conflict('POSSIBLE_DUPLICATE', `₹${amount.format({ symbol: false })} was already recorded on this loan a few minutes ago (${recent.payment_no}). Is this a second, separate payment?`, {
          paymentNo: recent.payment_no,
          receivedAt: recent.received_at,
        });
      }
    }

    let items = await this.openItems(tx, loanId);
    const plan = this.plan(loan, items, amount.toString(), today);
    const rule = this.rule(loan);
    if (plan.fullSettlement) {
      // Full settlement: the remaining schedule's interest is due now. Book it, then use any advance held.
      await accrueInterest(tx, this.ledger, today, { loanIds: [loanId], throughDate: FAR_FUTURE, reason: 'Interest due on full settlement' });
      if (plan.advance.isPositive()) {
        await this.applyAdvance(tx, loan, today, FAR_FUTURE);
        items = await this.openItems(tx, loanId);
      }
    }
    const before = items;
    const a = this.allocateOrExplain(items, amount.toString(), rule, plan.asOf);
    const account = await this.debitAccount(tx, ctx, loan, input);

    const paymentNo = await this.numbering.next(tx, 'PAYMENT');
    let payment: { id: string; received_at: Date };
    try {
      payment = await tx
        .insertInto('payments')
        .values({
          payment_no: paymentNo,
          loan_id: loanId,
          customer_id: loan.customer_id,
          branch_id: loan.branch_id,
          collected_by: ctx.auth.employeeId,
          recorded_by: ctx.auth.userId,
          amount: amount.toString(),
          method: input.method,
          reference_no: input.reference ?? null,
          cheque_bank: input.method === 'CHEQUE' ? input.chequeBank! : null,
          cheque_date: input.method === 'CHEQUE' ? input.chequeDate! : null,
          cheque_status: input.method === 'CHEQUE' ? 'RECEIVED' : null,
          business_date: today,
          value_date: today,
          location_text: input.location ?? null,
          lat: input.lat !== undefined ? String(input.lat) : null,
          lng: input.lng !== undefined ? String(input.lng) : null,
          notes: input.notes ?? null,
          debit_account_id: account.id,
          advance_amount: a.advance,
        })
        .returning(['id', 'received_at'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e) && pgConstraint(e) === 'payments_reference_live_idx') throw conflict('DUPLICATE_REFERENCE', 'This transaction reference was already recorded');
      throw e;
    }

    const snapshot = { ruleVersion: rule, asOf: plan.asOf, fullSettlement: plan.fullSettlement };
    for (const l of a.lines) {
      await tx
        .insertInto('payment_allocations')
        .values({ payment_id: payment.id, loan_id: loanId, installment_id: l.installmentId, installment_no: l.installmentNo, component: l.component, amount: l.amount, seq: l.seq, rule_snapshot: JSON.stringify(snapshot) })
        .execute();
    }
    await this.applyToInstallments(tx, a.lines, 1);

    const methodText = { CASH: input.atCounter ? 'cash at counter' : 'cash', UPI: 'UPI', BANK_TRANSFER: 'bank transfer', CHEQUE: 'cheque' }[input.method];
    const entry = await this.ledger.post(tx, {
      entryType: 'PAYMENT',
      valueDate: today,
      branchId: loan.branch_id,
      sourceType: 'payment',
      sourceId: payment.id,
      narration: `Payment ${paymentNo} on loan ${loan.loan_no} (${methodText}${input.reference ? ` ${input.reference}` : ''})`,
      lines: [
        { account: account.id, debit: amount, loanId, customerId: loan.customer_id, employeeId: account.employeeId, memo: `${methodText}${input.reference ? ` ${input.reference}` : ''}` },
        ...this.creditLines(a.lines, loan),
      ],
      createdBy: ctx.auth.userId,
    });
    await tx.updateTable('payments').set({ journal_entry_id: entry.id }).where('id', '=', payment.id).execute();
    await tx
      .updateTable('loans')
      .set((eb) => ({
        advance_balance: eb('advance_balance', '+', a.advance),
        total_collected: eb('total_collected', '+', amount.toString()),
        last_payment_at: new Date(),
        version: eb('version', '+', 1),
        updated_at: new Date(),
      }))
      .where('id', '=', loanId)
      .execute();

    await rollStatuses(tx, today, [loanId]);
    await this.loans.refreshBalances(tx, [loanId], today);
    const closed = await this.closeIfSettled(tx, ctx, loanId, today, payment.id);

    const after = await this.openItems(tx, loanId);
    const d = this.describe(before, after, a, plan.fullSettlement || closed);
    const collector = ctx.auth.employeeId ? await tx.selectFrom('employees').select('full_name').where('id', '=', ctx.auth.employeeId).executeTakeFirst() : undefined;
    const company = await tx.selectFrom('companies').select(['legal_name', 'trade_name', 'address', 'phone', 'gstin', 'receipt_footer']).executeTakeFirstOrThrow();
    const receiptNo = await this.numbering.next(tx, 'RECEIPT', { branchCode: loan.branch_code });
    const comps = totals(a.lines);
    const snap: ReceiptSnapshot = {
      company: { name: company.trade_name ?? company.legal_name, address: company.address, phone: company.phone, gstin: company.gstin, footer: company.receipt_footer },
      branch: { code: loan.branch_code, name: loan.branch_name },
      receiptNo,
      paymentNo,
      issuedAt: payment.received_at.toISOString(),
      valueDate: today,
      customer: { name: loan.customer_name, customerNo: loan.customer_no },
      loan: { loanNo: loan.loan_no },
      amount: amount.toString(),
      amountInWords: rupeesInWords(amount.toString()),
      method: input.method,
      reference: input.reference ?? null,
      chequeBank: input.method === 'CHEQUE' ? input.chequeBank! : null,
      chequeDate: input.method === 'CHEQUE' ? input.chequeDate! : null,
      collectedBy: collector?.full_name ?? (input.atCounter ? `${loan.branch_name} branch counter` : null),
      components: asStrings(comps),
      installmentsCleared: d.installmentsCleared,
      installmentsPart: d.installmentsPart,
      balanceAfter: closed ? '0.00' : d.balanceAfter,
      nextDue: d.nextDue ? { date: d.nextDue.date, amount: d.nextDue.amount } : null,
      loanClosed: closed,
      fullSettlement: plan.fullSettlement,
    };
    const receipt = await tx
      .insertInto('receipts')
      .values({ receipt_no: receiptNo, payment_id: payment.id, verify_token: randomBytes(18).toString('base64url'), snapshot: JSON.stringify(snap) })
      .returning(['id', 'verify_token'])
      .executeTakeFirstOrThrow();

    const summary = `₹${amount.format({ symbol: false })} received by ${methodText} (receipt ${receiptNo})${d.installmentsCleared.length ? ` — installment ${d.installmentsCleared.join(', ')} cleared` : ''}`;
    await this.loans.event(tx, loan.customer_id, loanId, ctx.auth.userId, 'PAYMENT_RECEIVED', summary);
    await this.audit.record(tx, ctx, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: payment.id,
      branchId: loan.branch_id,
      newValues: { paymentNo, receiptNo, loan: loan.loan_no, amount: amount.toString(), method: input.method, reference: input.reference ?? null, account: account.code, journal: entry.entryNo, components: asStrings(comps), fullSettlement: plan.fullSettlement },
    });
    const messages = input.notify
      ? await this.messaging.notify(tx, {
          eventCode: 'PAYMENT_RECEIVED',
          customerId: loan.customer_id,
          loanId,
          paymentId: payment.id,
          vars: { name: loan.customer_name, amount: fmtAmount(amount), loan_no: loan.loan_no, date: fmtDate(today), receipt_no: receiptNo, balance: fmtAmount(snap.balanceAfter) },
          triggeredBy: 'AUTO',
          createdBy: ctx.auth.userId,
          dedupeKey: `PAY:${payment.id}`,
        })
      : [];
    return {
      id: payment.id,
      paymentNo,
      receiptNo,
      receiptId: receipt.id,
      verifyUrl: `${this.config.publicWebUrl}/r/${receipt.verify_token}`,
      amount: amount.toString(),
      method: input.method,
      components: asStrings(comps),
      installmentsCleared: d.installmentsCleared,
      installmentsPart: d.installmentsPart,
      balanceAfter: snap.balanceAfter,
      nextDue: d.nextDue,
      loanClosed: closed,
      fullSettlement: plan.fullSettlement,
      journalEntryNo: entry.entryNo,
      messages,
    };
  }

  /* =========================== Advances =========================== */

  /**
   * Use a customer's advance on installments now due (doc 08 §4d): Dr Customer Advances / Cr the
   * receivables. Returns null when nothing is due or no advance is held.
   */
  async applyAdvance(tx: Tx, loan: { id: string; loan_no: string; customer_id: string; branch_id: string; advance_balance: string; allocation_rule: unknown }, date: string, throughDate = date) {
    const advance = Money.of(loan.advance_balance);
    if (!advance.isPositive()) return null;
    const items = (await this.openItems(tx, loan.id)).filter((i) => i.dueDate <= throughDate);
    const due = this.remaining(items);
    const amount = advance.min(due);
    if (!amount.isPositive()) return null;
    const a = allocate(items, amount.toString(), this.rule(loan), throughDate);
    const app = await tx.insertInto('advance_applications').values({ loan_id: loan.id, applied_on: date, amount: amount.toString() }).returning('id').executeTakeFirstOrThrow();
    for (const l of a.lines) {
      await tx
        .insertInto('payment_allocations')
        .values({ advance_application_id: app.id, loan_id: loan.id, installment_id: l.installmentId, installment_no: l.installmentNo, component: l.component, amount: l.amount, seq: l.seq, rule_snapshot: JSON.stringify({ ruleVersion: this.rule(loan), asOf: throughDate }) })
        .execute();
    }
    await this.applyToInstallments(tx, a.lines, 1);
    const entry = await this.ledger.post(tx, {
      entryType: 'PAYMENT',
      valueDate: date,
      branchId: loan.branch_id,
      sourceType: 'advance_application',
      sourceId: app.id,
      narration: `Advance applied on loan ${loan.loan_no} (installment ${[...new Set(a.lines.map((l) => l.installmentNo))].join(', ')})`,
      lines: [{ account: GL.CUSTOMER_ADVANCE, debit: amount, loanId: loan.id, customerId: loan.customer_id, memo: 'Advance applied' }, ...this.creditLines(a.lines, loan)],
      createdBy: null,
    });
    await tx.updateTable('advance_applications').set({ journal_entry_id: entry.id }).where('id', '=', app.id).execute();
    await tx.updateTable('loans').set((eb) => ({ advance_balance: eb('advance_balance', '-', amount.toString()), updated_at: new Date() })).where('id', '=', loan.id).execute();
    return { id: app.id, amount: amount.toString() };
  }

  /** Nightly: apply held advances to installments that fell due. Closes loans that become fully paid. */
  async applyAdvancesDue(tx: Tx, date: string) {
    const loans = await tx
      .selectFrom('loans')
      .select(['id', 'loan_no', 'customer_id', 'branch_id', 'advance_balance', 'allocation_rule'])
      .where('status', '=', 'ACTIVE')
      .where('advance_balance', '>', '0')
      .forUpdate()
      .execute();
    let applied = 0;
    for (const l of loans) {
      if (await this.applyAdvance(tx, l, date)) {
        applied++;
        await rollStatuses(tx, date, [l.id]);
        await this.loans.refreshBalances(tx, [l.id], date);
        await this.closeIfSettled(tx, null, l.id, date, null);
      }
    }
    return applied;
  }

  private async unapplyAdvance(tx: Tx, app: { id: string; amount: string; journal_entry_id: string | null; loan_id: string }, userId: string, today: string) {
    const lines = await tx.selectFrom('payment_allocations').select(['installment_id as installmentId', 'component', 'amount']).where('advance_application_id', '=', app.id).execute();
    await this.applyToInstallments(tx, lines, -1);
    const rev = await this.ledger.reverse(tx, app.journal_entry_id!, { valueDate: today, narration: 'Advance application undone (payment reversed)', createdBy: userId, sourceType: 'advance_application', sourceId: app.id });
    await tx.updateTable('advance_applications').set({ status: 'REVERSED', reversed_at: new Date(), reversal_journal_entry_id: rev.id }).where('id', '=', app.id).execute();
    await tx.updateTable('loans').set((eb) => ({ advance_balance: eb('advance_balance', '+', app.amount) })).where('id', '=', app.loan_id).execute();
  }

  /* =========================== Closure =========================== */

  private async closeIfSettled(tx: Tx, ctx: RequestContext | null, loanId: string, date: string, paymentId: string | null): Promise<boolean> {
    const s = await tx
      .selectFrom('loan_installments')
      .select([
        sql<string>`coalesce(sum(total_due - total_paid), 0)::text`.as('remaining'),
        sql<string>`coalesce(sum(principal_paid), 0)::text`.as('pp'),
        sql<string>`coalesce(sum(interest_paid), 0)::text`.as('ip'),
        sql<string>`coalesce(sum(fees_paid), 0)::text`.as('fp'),
        sql<string>`coalesce(sum(penalty_paid), 0)::text`.as('pen'),
      ])
      .where('loan_id', '=', loanId)
      .where('status', '<>', 'RESCHEDULED')
      .executeTakeFirstOrThrow();
    if (Money.of(s.remaining).isPositive()) return false;
    const loan = await tx.selectFrom('loans').select(['loan_no', 'customer_id', 'branch_id', 'advance_balance', 'total_collected', 'status']).where('id', '=', loanId).executeTakeFirstOrThrow();
    if (loan.status !== 'ACTIVE') return false;
    await tx.updateTable('loans').set((eb) => ({ status: 'CLOSED', closed_at: new Date(), next_due_date: null, next_due_amount: null, version: eb('version', '+', 1), updated_at: new Date() })).where('id', '=', loanId).execute();
    const refund = Money.of(loan.advance_balance);
    await tx
      .insertInto('loan_closures')
      .values({
        loan_id: loanId,
        closed_on: date,
        closing_payment_id: paymentId,
        total_paid: Money.sum([s.pp, s.ip, s.fp, s.pen].map((x) => Money.of(x))).toString(),
        principal_paid: s.pp,
        interest_paid: s.ip,
        fees_paid: s.fp,
        penalty_paid: s.pen,
        advance_remaining: refund.toString(),
        checklist: JSON.stringify({ nocIssued: false, rcReturned: false, hypothecationRemoved: false, ...(refund.isPositive() ? { refundDue: refund.toString() } : {}) }),
      })
      .execute();
    const assets = await tx.selectFrom('assets').select(['id', 'status']).where('loan_id', '=', loanId).where('status', '=', 'ACTIVE').execute();
    for (const a of assets) {
      await tx.updateTable('assets').set({ status: 'CLOSED', updated_at: new Date() }).where('id', '=', a.id).execute();
      await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'ACTIVE', to_status: 'CLOSED', reason: 'Loan fully repaid', actor_id: ctx?.auth.userId ?? null }).execute();
    }
    const customer = await tx.selectFrom('customers').select('full_name').where('id', '=', loan.customer_id).executeTakeFirstOrThrow();
    await tx
      .insertInto('customer_events')
      .values({ customer_id: loan.customer_id, loan_id: loanId, actor_id: ctx?.auth.userId ?? null, event_type: 'LOAN_CLOSED', summary: `Loan ${loan.loan_no} fully repaid and closed${refund.isPositive() ? ` — ₹${refund.format({ symbol: false })} advance to refund` : ''}`, ref_type: 'loan', ref_id: loanId })
      .execute();
    const auditEntry = { action: 'loan.closed', entityType: 'loan', entityId: loanId, branchId: loan.branch_id, oldValues: { status: 'ACTIVE' }, newValues: { status: 'CLOSED', closedOn: date, advanceRemaining: refund.toString() } };
    if (ctx) await this.audit.record(tx, ctx, auditEntry);
    else await this.audit.recordAs(tx, { userId: null }, auditEntry);
    await this.messaging.notify(tx, { eventCode: 'LOAN_CLOSED', customerId: loan.customer_id, loanId, vars: { name: customer.full_name, loan_no: loan.loan_no }, triggeredBy: 'AUTO', dedupeKey: `CLOSE:${loanId}:${date}` });
    return true;
  }

  /* =========================== Reversal =========================== */

  private async paymentForUpdate(tx: Tx, auth: AuthContext, paymentId: string) {
    const p = await tx.selectFrom('payments').selectAll().where('id', '=', paymentId).forUpdate().executeTakeFirst();
    if (!p) throw notFound('Payment');
    const visible = await this.loans.scoped(tx, auth).select('l.id').where('l.id', '=', p.loan_id).executeTakeFirst();
    if (!visible) throw notFound('Payment');
    return p;
  }

  async requestReversal(ctx: RequestContext, paymentId: string, input: { reasonCode: string; reasonText: string }) {
    return this.db.transaction().execute(async (tx) => {
      const p = await this.paymentForUpdate(tx, ctx.auth, paymentId);
      if (p.status !== 'POSTED') throw conflict('INVALID_STATE', p.status === 'REVERSED' ? 'This payment is already reversed' : 'A reversal is already waiting for approval');
      if (p.reconciliation_status === 'MATCHED') {
        throw conflict('RECONCILED', 'This payment is confirmed on the bank statement. Undo the bank match first (Reconciliation), or record a refund instead.');
      }
      const r = await tx
        .insertInto('payment_reversals')
        .values({ payment_id: paymentId, reason_code: input.reasonCode, reason_text: input.reasonText, requested_by: ctx.auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.updateTable('payments').set({ status: 'REVERSAL_PENDING' }).where('id', '=', paymentId).execute();
      await this.loans.event(tx, p.customer_id, p.loan_id, ctx.auth.userId, 'PAYMENT_REVERSAL_REQUESTED', `Reversal of ${p.payment_no} requested: ${input.reasonText}`);
      await this.audit.record(tx, ctx, { action: 'payment.reversal_requested', entityType: 'payment', entityId: paymentId, branchId: p.branch_id, newValues: { reversalId: r.id, reasonCode: input.reasonCode, reason: input.reasonText } });
      return { id: r.id, status: 'REQUESTED' };
    });
  }

  async rejectReversal(ctx: RequestContext, reversalId: string, note: string) {
    return this.db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('payment_reversals').selectAll().where('id', '=', reversalId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Reversal request');
      const p = await this.paymentForUpdate(tx, ctx.auth, r.payment_id);
      if (r.status !== 'REQUESTED') throw conflict('INVALID_STATE', 'This request was already decided');
      await tx.updateTable('payment_reversals').set({ status: 'REJECTED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note }).where('id', '=', reversalId).execute();
      await tx.updateTable('payments').set({ status: 'POSTED' }).where('id', '=', p.id).execute();
      await this.loans.event(tx, p.customer_id, p.loan_id, ctx.auth.userId, 'PAYMENT_REVERSAL_REJECTED', `Reversal of ${p.payment_no} rejected: ${note}`);
      await this.audit.record(tx, ctx, { action: 'payment.reversal_rejected', entityType: 'payment', entityId: p.id, branchId: p.branch_id, newValues: { reversalId, note } });
      return { id: reversalId, status: 'REJECTED' };
    });
  }

  async approveReversal(ctx: RequestContext, reversalId: string, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const r = await tx.selectFrom('payment_reversals').selectAll().where('id', '=', reversalId).forUpdate().executeTakeFirst();
      if (!r) throw notFound('Reversal request');
      if (r.requested_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You asked for this reversal, so someone else must approve it');
      const visible = await tx.selectFrom('payments').select('loan_id').where('id', '=', r.payment_id).executeTakeFirstOrThrow();
      // Lock order: loan, then payment (same as recording a payment).
      const loan = await this.lockLoan(tx, ctx.auth, visible.loan_id);
      const p = await this.paymentForUpdate(tx, ctx.auth, r.payment_id);
      if (r.status !== 'REQUESTED' || p.status !== 'REVERSAL_PENDING') throw conflict('INVALID_STATE', 'This request was already decided');
      const result = await this.executeReversal(tx, ctx, loan, p, r.id, `${r.reason_code}: ${r.reason_text}`);
      await tx.updateTable('payment_reversals').set({ status: 'APPROVED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null, reversal_journal_entry_id: result.journalId }).where('id', '=', reversalId).execute();
      await this.audit.record(tx, ctx, {
        action: 'payment.reversed',
        entityType: 'payment',
        entityId: p.id,
        branchId: p.branch_id,
        oldValues: { status: 'REVERSAL_PENDING' },
        newValues: { status: 'REVERSED', reversalId, requestedBy: r.requested_by, journal: result.journalNo, loanReopened: result.reopened, advanceApplicationsUndone: result.undone },
      });
      return { id: reversalId, status: 'APPROVED', paymentId: p.id, journalEntryNo: result.journalNo, loanReopened: result.reopened };
    });
  }

  /** Undo a payment completely (doc 08 §6). Caller holds the loan and payment locks. */
  private async executeReversal(tx: Tx, ctx: RequestContext, loan: LoanRow, p: { id: string; payment_no: string; amount: string; advance_amount: string; journal_entry_id: string | null; customer_id: string; loan_id: string }, reversalId: string, reason: string) {
    const today = istToday();
    let reopened = false;
    if (loan.status === 'CLOSED') {
      await tx.updateTable('loans').set({ status: 'ACTIVE', closed_at: null }).where('id', '=', loan.id).execute();
      await tx.updateTable('loan_closures').set({ status: 'VOIDED', voided_at: new Date(), void_reason: `Payment ${p.payment_no} reversed` }).where('loan_id', '=', loan.id).where('status', '=', 'CLOSED').execute();
      const assets = await tx.selectFrom('assets').select('id').where('loan_id', '=', loan.id).where('status', '=', 'CLOSED').execute();
      for (const a of assets) {
        await tx.updateTable('assets').set({ status: 'ACTIVE', updated_at: new Date() }).where('id', '=', a.id).execute();
        await tx.insertInto('asset_events').values({ asset_id: a.id, from_status: 'CLOSED', to_status: 'ACTIVE', reason: `Loan reopened: payment ${p.payment_no} reversed`, actor_id: ctx.auth.userId }).execute();
      }
      reopened = true;
    }

    // If part of this payment was held as advance and has since been used, undo those uses first
    // (newest first) so the advance can be taken back.
    const needAdvance = Money.of(p.advance_amount);
    let held = Money.of((await tx.selectFrom('loans').select('advance_balance').where('id', '=', loan.id).executeTakeFirstOrThrow()).advance_balance);
    let undone = 0;
    if (held.lt(needAdvance)) {
      const apps = await tx.selectFrom('advance_applications').selectAll().where('loan_id', '=', loan.id).where('status', '=', 'APPLIED').orderBy('created_at', 'desc').execute();
      for (const app of apps) {
        if (held.gte(needAdvance)) break;
        await this.unapplyAdvance(tx, app, ctx.auth.userId, today);
        held = held.plus(Money.of(app.amount));
        undone++;
      }
    }

    const lines = await tx.selectFrom('payment_allocations').select(['installment_id as installmentId', 'component', 'amount']).where('payment_id', '=', p.id).execute();
    await this.applyToInstallments(tx, lines, -1);
    const rev = await this.ledger.reverse(tx, p.journal_entry_id!, {
      valueDate: today,
      narration: `Reversal of payment ${p.payment_no} on loan ${loan.loan_no} — ${reason}`.slice(0, 500),
      createdBy: ctx.auth.userId,
      sourceType: 'payment_reversal',
      sourceId: reversalId,
    });
    await tx
      .updateTable('loans')
      .set((eb) => ({ advance_balance: eb('advance_balance', '-', needAdvance.toString()), total_collected: eb('total_collected', '-', p.amount), version: eb('version', '+', 1), updated_at: new Date() }))
      .where('id', '=', loan.id)
      .execute();
    await tx.updateTable('payments').set({ status: 'REVERSED' }).where('id', '=', p.id).execute();
    const receipt = await tx.selectFrom('receipts').select(['id', 'receipt_no']).where('payment_id', '=', p.id).executeTakeFirst();
    if (receipt) await tx.updateTable('receipts').set({ status: 'CANCELLED', cancelled_at: new Date(), cancelled_by_reversal_id: reversalId }).where('id', '=', receipt.id).execute();

    // Any advance still held after undoing applications is re-applied to what is due today.
    if (undone) await this.applyAdvance(tx, { ...loan, advance_balance: (await tx.selectFrom('loans').select('advance_balance').where('id', '=', loan.id).executeTakeFirstOrThrow()).advance_balance }, today);
    await rollStatuses(tx, today, [loan.id]);
    await this.loans.refreshBalances(tx, [loan.id], today);
    await this.loans.event(tx, p.customer_id, loan.id, ctx.auth.userId, 'PAYMENT_REVERSED', `Payment ${p.payment_no} (₹${Money.of(p.amount).format({ symbol: false })}) reversed${receipt ? `; receipt ${receipt.receipt_no} cancelled` : ''}${reopened ? '; loan reopened' : ''}`);
    if (receipt) {
      await this.messaging.notify(tx, {
        eventCode: 'PAYMENT_REVERSED',
        customerId: p.customer_id,
        loanId: loan.id,
        paymentId: p.id,
        vars: { name: loan.customer_name, receipt_no: receipt.receipt_no, amount: fmtAmount(p.amount), loan_no: loan.loan_no },
        triggeredBy: 'AUTO',
        createdBy: ctx.auth.userId,
        dedupeKey: `REV:${p.id}`,
      });
    }
    return { journalId: rev.id, journalNo: rev.entryNo, reopened, undone };
  }

  /* =========================== Cheques (doc 07 E8) =========================== */

  private async chequeForUpdate(tx: Tx, auth: AuthContext, paymentId: string) {
    const head = await tx.selectFrom('payments').select(['loan_id', 'method']).where('id', '=', paymentId).executeTakeFirst();
    if (!head || head.method !== 'CHEQUE') throw notFound('Cheque');
    const loan = await this.lockLoan(tx, auth, head.loan_id);
    const p = await this.paymentForUpdate(tx, auth, paymentId);
    return { loan, p };
  }

  /** Cheque paid into the bank: Dr Bank / Cr Cheques in hand. The payment itself is unchanged. */
  async depositCheque(ctx: RequestContext, paymentId: string, input: { accountId: string; depositedOn: string }) {
    if (input.depositedOn > istToday()) throw unprocessable('FUTURE_DATE', 'The deposit date cannot be in the future');
    return this.db.transaction().execute(async (tx) => {
      const { loan, p } = await this.chequeForUpdate(tx, ctx.auth, paymentId);
      if (p.status !== 'POSTED' || p.cheque_status !== 'RECEIVED') throw conflict('INVALID_STATE', `This cheque is ${(p.cheque_status ?? '').toLowerCase()}${p.status !== 'POSTED' ? ` and the payment is ${p.status.toLowerCase().replace('_', ' ')}` : ''}`);
      if (input.depositedOn < p.value_date) throw unprocessable('VALIDATION_FAILED', 'A cheque cannot be deposited before it was received');
      const bank = await tx.selectFrom('accounts').select(['id', 'code']).where('id', '=', input.accountId).where('subtype', '=', 'BANK').where('is_active', '=', true).executeTakeFirst();
      if (!bank) throw unprocessable('ACCOUNT_MISMATCH', 'Choose one of the company bank accounts');
      const amount = Money.of(p.amount);
      const entry = await this.ledger.post(tx, {
        entryType: 'DEPOSIT',
        valueDate: input.depositedOn,
        branchId: p.branch_id,
        sourceType: 'cheque_deposit',
        sourceId: p.id,
        narration: `Cheque ${p.reference_no} (${p.payment_no}, loan ${loan.loan_no}) deposited`,
        lines: [
          { account: bank.id, debit: amount, loanId: loan.id, memo: `Cheque ${p.reference_no}` },
          { account: p.debit_account_id, credit: amount, loanId: loan.id, memo: `Cheque ${p.reference_no}` },
        ],
        createdBy: ctx.auth.userId,
      });
      await tx
        .updateTable('payments')
        .set({ cheque_status: 'DEPOSITED', cheque_deposit_account_id: bank.id, cheque_deposited_on: input.depositedOn, cheque_deposit_journal_id: entry.id })
        .where('id', '=', p.id)
        .execute();
      await this.audit.record(tx, ctx, { action: 'cheque.deposited', entityType: 'payment', entityId: p.id, branchId: p.branch_id, oldValues: { chequeStatus: 'RECEIVED' }, newValues: { chequeStatus: 'DEPOSITED', bank: bank.code, journal: entry.entryNo } });
      return { id: p.id, chequeStatus: 'DEPOSITED', journalEntryNo: entry.entryNo };
    });
  }

  async clearCheque(ctx: RequestContext, paymentId: string, clearedOn: string) {
    return this.db.transaction().execute(async (tx) => {
      const { p } = await this.chequeForUpdate(tx, ctx.auth, paymentId);
      if (p.cheque_status !== 'DEPOSITED') throw conflict('INVALID_STATE', 'Only deposited cheques can be marked cleared');
      if (clearedOn < p.cheque_deposited_on! || clearedOn > istToday()) throw unprocessable('VALIDATION_FAILED', 'The clearing date must be between the deposit date and today');
      await tx.updateTable('payments').set({ cheque_status: 'CLEARED', cheque_cleared_on: clearedOn }).where('id', '=', p.id).execute();
      await this.audit.record(tx, ctx, { action: 'cheque.cleared', entityType: 'payment', entityId: p.id, branchId: p.branch_id, oldValues: { chequeStatus: 'DEPOSITED' }, newValues: { chequeStatus: 'CLEARED', clearedOn } });
      return { id: p.id, chequeStatus: 'CLEARED' };
    });
  }

  /**
   * Bounced cheque: the money never arrived. Undo the bank deposit (if any), reverse the payment
   * exactly like an approved reversal (installments restored, receipt cancelled), then optionally
   * charge the bounce fee to the loan (Dr Fees receivable / Cr Other charges) ⚖.
   */
  async bounceCheque(ctx: RequestContext, paymentId: string, input: { bouncedOn: string; reason: string; charge?: string }) {
    return this.db.transaction().execute(async (tx) => {
      const { loan, p } = await this.chequeForUpdate(tx, ctx.auth, paymentId);
      if (!['RECEIVED', 'DEPOSITED'].includes(p.cheque_status ?? '')) throw conflict('INVALID_STATE', `This cheque is ${(p.cheque_status ?? '').toLowerCase()}`);
      if (p.status !== 'POSTED') throw conflict('INVALID_STATE', 'Decide the pending reversal of this payment first');
      if (input.bouncedOn > istToday()) throw unprocessable('FUTURE_DATE', 'The bounce date cannot be in the future');
      const today = istToday();
      if (p.cheque_status === 'DEPOSITED') {
        await this.ledger.reverse(tx, p.cheque_deposit_journal_id!, { valueDate: today, narration: `Cheque ${p.reference_no} bounced — bank deposit undone`, createdBy: ctx.auth.userId, sourceType: 'cheque_deposit', sourceId: p.id });
      }
      const rev = await tx
        .insertInto('payment_reversals')
        .values({ payment_id: p.id, reason_code: 'CHEQUE_BOUNCED', reason_text: input.reason, requested_by: ctx.auth.userId, status: 'APPROVED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: `Bounced on ${input.bouncedOn}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      const result = await this.executeReversal(tx, ctx, loan, p, rev.id, `Cheque ${p.reference_no} bounced: ${input.reason}`);
      await tx.updateTable('payment_reversals').set({ reversal_journal_entry_id: result.journalId }).where('id', '=', rev.id).execute();
      await tx.updateTable('payments').set({ cheque_status: 'BOUNCED', cheque_bounced_on: input.bouncedOn }).where('id', '=', p.id).execute();

      let chargeEntry: string | null = null;
      if (input.charge && Money.of(input.charge).isPositive()) {
        const charge = Money.of(input.charge);
        const target = await tx
          .selectFrom('loan_installments')
          .select(['id', 'installment_no'])
          .where('loan_id', '=', loan.id)
          .where('status', 'not in', ['WAIVED', 'RESCHEDULED'])
          .where(sql<boolean>`total_paid < total_due`)
          .orderBy('due_date')
          .executeTakeFirst();
        if (!target) throw unprocessable('NOTHING_OPEN', 'The loan has no open installment to add the charge to');
        const c = await tx
          .insertInto('loan_charges')
          .values({ loan_id: loan.id, installment_id: target.id, charge_type: 'FEE', code: 'CHEQUE_BOUNCE', description: `Cheque ${p.reference_no} bounced`, amount: charge.toString(), assessed_on: today, status: 'OPEN', collection_mode: 'ADD_TO_INSTALLMENT' })
          .returning('id')
          .executeTakeFirstOrThrow();
        const entry = await this.ledger.post(tx, {
          entryType: 'FEE',
          valueDate: today,
          branchId: p.branch_id,
          sourceType: 'loan_charge',
          sourceId: c.id,
          narration: `Cheque bounce charge on loan ${loan.loan_no} (cheque ${p.reference_no})`,
          lines: [
            { account: GL.FEES_RECEIVABLE, debit: charge, loanId: loan.id, customerId: loan.customer_id, memo: `Installment ${target.installment_no}` },
            { account: GL.feeIncome('OTHER'), credit: charge, loanId: loan.id, memo: 'Cheque bounce charge' },
          ],
          createdBy: ctx.auth.userId,
        });
        await tx.updateTable('loan_charges').set({ journal_entry_id: entry.id }).where('id', '=', c.id).execute();
        await tx.updateTable('loan_installments').set((eb) => ({ fees_due: eb('fees_due', '+', charge.toString()) })).where('id', '=', target.id).execute();
        await rollStatuses(tx, today, [loan.id]);
        await this.loans.refreshBalances(tx, [loan.id], today);
        chargeEntry = entry.entryNo;
      }
      await this.audit.record(tx, ctx, {
        action: 'cheque.bounced',
        entityType: 'payment',
        entityId: p.id,
        branchId: p.branch_id,
        oldValues: { chequeStatus: p.cheque_status, status: 'POSTED' },
        newValues: { chequeStatus: 'BOUNCED', status: 'REVERSED', reason: input.reason, reversal: result.journalNo, charge: input.charge ?? null, chargeJournal: chargeEntry },
      });
      return { id: p.id, chequeStatus: 'BOUNCED', reversalJournalNo: result.journalNo, chargeJournalNo: chargeEntry, loanReopened: result.reopened };
    });
  }

  async cheques(auth: AuthContext, status?: string) {
    let sel = this.loans
      .scoped(this.db, auth)
      .innerJoin('payments as p', 'p.loan_id', 'l.id')
      .leftJoin('accounts as a', 'a.id', 'p.cheque_deposit_account_id')
      .select([
        'p.id', 'p.payment_no', 'p.amount', 'p.reference_no', 'p.cheque_bank', 'p.cheque_date', 'p.cheque_status', 'p.status', 'p.received_at', 'p.value_date',
        'p.cheque_deposited_on', 'p.cheque_cleared_on', 'p.cheque_bounced_on', 'a.name as deposit_account',
        'l.id as loan_id', 'l.loan_no', 'c.full_name as customer_name', 'b.code as branch_code',
      ])
      .where('p.method', '=', 'CHEQUE')
      .orderBy('p.received_at', 'desc')
      .limit(300);
    if (status) sel = sel.where('p.cheque_status', '=', status);
    return sel.execute();
  }

  /* =========================== Reads =========================== */

  async list(auth: AuthContext, q: { limit: number; cursor?: string; loanId?: string; customerId?: string; collectorId?: string; branchId?: string; method?: string; status?: string; from?: string; to?: string; q?: string }) {
    let sel = this.loans
      .scoped(this.db, auth)
      .innerJoin('payments as p', 'p.loan_id', 'l.id')
      .leftJoin('receipts as r', 'r.payment_id', 'p.id')
      .leftJoin('employees as e', 'e.id', 'p.collected_by')
      .select([
        'p.id', 'p.payment_no', 'p.amount', 'p.method', 'p.reference_no', 'p.status', 'p.received_at', 'p.value_date', 'p.cheque_status', 'p.reconciliation_status', 'p.advance_amount',
        'l.id as loan_id', 'l.loan_no', 'c.id as customer_id', 'c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code',
        'r.receipt_no', 'r.status as receipt_status', 'e.full_name as collected_by_name',
      ])
      .orderBy('p.id', 'desc')
      .limit(q.limit + 1);
    if (q.cursor) sel = sel.where('p.id', '<', q.cursor);
    if (q.loanId) sel = sel.where('p.loan_id', '=', q.loanId);
    if (q.customerId) sel = sel.where('p.customer_id', '=', q.customerId);
    if (q.collectorId) sel = sel.where('p.collected_by', '=', q.collectorId);
    if (q.branchId) sel = sel.where('p.branch_id', '=', q.branchId);
    if (q.method) sel = sel.where('p.method', '=', q.method);
    if (q.status) sel = sel.where('p.status', '=', q.status);
    if (q.from) sel = sel.where('p.business_date', '>=', q.from);
    if (q.to) sel = sel.where('p.business_date', '<=', q.to);
    if (q.q) {
      const t = q.q.replace(/[%_\\]/g, '');
      sel = sel.where((eb) => eb.or([eb('p.payment_no', 'ilike', `%${t}%`), eb('r.receipt_no', 'ilike', `%${t}%`), eb('p.reference_no', 'ilike', `%${t}%`), eb('l.loan_no', 'ilike', `%${t}%`), eb('c.full_name', 'ilike', `%${t}%`)]));
    }
    const rows = await sel.execute();
    const data = rows.slice(0, q.limit);
    return { data, nextCursor: rows.length > q.limit ? data[data.length - 1]!.id : null };
  }

  async get(auth: AuthContext, id: string) {
    const p = await this.loans
      .scoped(this.db, auth)
      .innerJoin('payments as p', 'p.loan_id', 'l.id')
      .selectAll('p')
      .select(['l.loan_no', 'l.status as loan_status', 'c.full_name as customer_name', 'c.customer_no', 'b.code as branch_code', 'b.name as branch_name'])
      .where('p.id', '=', id)
      .executeTakeFirst();
    if (!p) throw notFound('Payment');
    const [allocations, receipt, reversals, account, people, journal] = await Promise.all([
      this.db.selectFrom('payment_allocations').select(['installment_no', 'component', 'amount', 'seq']).where('payment_id', '=', id).orderBy('seq').execute(),
      this.db.selectFrom('receipts').select(['id', 'receipt_no', 'issued_at', 'status', 'cancelled_at', 'verify_token', 'snapshot']).where('payment_id', '=', id).executeTakeFirst(),
      this.db
        .selectFrom('payment_reversals as r')
        .leftJoin('users as a', 'a.id', 'r.requested_by')
        .leftJoin('users as d', 'd.id', 'r.decided_by')
        .select(['r.id', 'r.reason_code', 'r.reason_text', 'r.status', 'r.requested_at', 'r.decided_at', 'r.decision_note', 'r.requested_by', 'a.full_name as requested_by_name', 'd.full_name as decided_by_name'])
        .where('r.payment_id', '=', id)
        .orderBy('r.requested_at', 'desc')
        .execute(),
      this.db.selectFrom('accounts').select(['code', 'name']).where('id', '=', p.debit_account_id).executeTakeFirst(),
      this.db
        .selectFrom('users as u')
        .leftJoin('employees as e', 'e.user_id', 'u.id')
        .select(['u.id', 'u.full_name'])
        .where('u.id', '=', p.recorded_by)
        .executeTakeFirst(),
      auth.permissions.has('ledger.view') ? this.journalFor(id) : Promise.resolve(null),
    ]);
    const collector = p.collected_by ? await this.db.selectFrom('employees').select('full_name').where('id', '=', p.collected_by).executeTakeFirst() : null;
    const pending = reversals.find((r) => r.status === 'REQUESTED');
    return {
      ...p,
      allocations,
      receipt: receipt ? { ...receipt, verify_token: undefined, verifyUrl: `${this.config.publicWebUrl}/r/${receipt.verify_token}` } : null,
      reversals,
      account: account ?? null,
      recordedByName: people?.full_name ?? null,
      collectedByName: collector?.full_name ?? null,
      journal,
      canRequestReversal: p.status === 'POSTED' && auth.permissions.has('payment.reverse_request'),
      canDecideReversal: !!pending && pending.requested_by !== auth.userId && auth.permissions.has('payment.reverse_approve'),
    };
  }

  private async journalFor(paymentId: string) {
    const entries = await this.db
      .selectFrom('journal_entries')
      .select(['id', 'entry_no', 'entry_type', 'value_date', 'narration'])
      .where((eb) =>
        eb.or([
          eb.and([eb('source_type', '=', 'payment'), eb('source_id', '=', paymentId)]),
          eb.and([eb('source_type', '=', 'payment_reversal'), eb('source_id', 'in', eb.selectFrom('payment_reversals').select(sql<string>`id::text`.as('id')).where('payment_id', '=', paymentId))]),
        ]),
      )
      .orderBy('posted_at')
      .execute();
    if (!entries.length) return [];
    const lines = await this.db
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['l.entry_id', 'l.line_no', 'a.code', 'a.name', 'l.debit', 'l.credit', 'l.memo'])
      .where('l.entry_id', 'in', entries.map((e) => e.id))
      .orderBy('l.line_no')
      .execute();
    return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) }));
  }

  async pendingReversals(auth: AuthContext) {
    return this.loans
      .scoped(this.db, auth)
      .innerJoin('payments as p', 'p.loan_id', 'l.id')
      .innerJoin('payment_reversals as r', 'r.payment_id', 'p.id')
      .leftJoin('users as u', 'u.id', 'r.requested_by')
      .select([
        'r.id', 'r.reason_code', 'r.reason_text', 'r.requested_at', 'r.requested_by', 'u.full_name as requested_by_name',
        'p.id as payment_id', 'p.payment_no', 'p.amount', 'p.method', 'p.received_at', 'l.loan_no', 'c.full_name as customer_name', 'b.code as branch_code',
      ])
      .where('r.status', '=', 'REQUESTED')
      .orderBy('r.requested_at')
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, canDecide: r.requested_by !== auth.userId && auth.permissions.has('payment.reverse_approve') })));
  }

  async receiptPdf(auth: AuthContext, paymentId: string) {
    const p = await this.get(auth, paymentId);
    if (!p.receipt) throw notFound('Receipt');
    const token = await this.db.selectFrom('receipts').select('verify_token').where('id', '=', p.receipt.id).executeTakeFirstOrThrow();
    const pdf = await receiptPdf(p.receipt.snapshot as unknown as ReceiptSnapshot, { cancelled: p.receipt.status === 'CANCELLED', verifyUrl: `${this.config.publicWebUrl}/r/${token.verify_token}` });
    return { pdf, filename: `${p.receipt.receipt_no.replace(/[^A-Za-z0-9-]/g, '_')}.pdf` };
  }

  /** Public receipt check (anyone with the QR link). Shows only what proves authenticity. */
  async verifyReceipt(token: string) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw notFound('Receipt');
    const r = await this.db.selectFrom('receipts').select(['receipt_no', 'issued_at', 'status', 'cancelled_at', 'snapshot']).where('verify_token', '=', token).executeTakeFirst();
    if (!r) throw notFound('Receipt');
    const s = r.snapshot as unknown as ReceiptSnapshot;
    const [first, ...rest] = s.customer.name.split(' ');
    return {
      receiptNo: r.receipt_no,
      issuedAt: r.issued_at,
      status: r.status,
      cancelledAt: r.cancelled_at,
      company: s.company.name,
      branch: s.branch.name,
      amount: s.amount,
      method: s.method,
      customer: [first, ...rest.map((w) => `${w.charAt(0)}.`)].join(' '),
      loanNo: s.loan.loanNo.replace(/.(?=.{4})/g, '•'),
    };
  }
}

