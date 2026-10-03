import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { CryptoService } from '../common/crypto.service';
import { notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx } from '../db/db';
import { NumberingService } from '../numbering/numbering.service';

export type EntryType = 'DISBURSEMENT' | 'FEE' | 'PAYMENT' | 'ACCRUAL' | 'PENALTY' | 'EXPENSE' | 'DEPOSIT' | 'TRANSFER' | 'ADJUSTMENT' | 'REVERSAL' | 'OPENING' | 'MANUAL' | 'WRITE_OFF' | 'SALE';

export interface PostingLine {
  /** Account code (e.g. '1310') or id. */
  account: string;
  debit?: Money;
  credit?: Money;
  loanId?: string | null;
  customerId?: string | null;
  employeeId?: string | null;
  memo?: string;
}

export interface Posting {
  entryType: EntryType;
  valueDate: string;
  branchId: string | null;
  sourceType: string;
  sourceId: string;
  narration: string;
  lines: PostingLine[];
  createdBy: string | null;
  approvedBy?: string | null;
  reversesEntryId?: string;
}

/** Account codes the posting rules use (doc 07 §2). */
export const GL = {
  LOAN_RECEIVABLE: '1310',
  INTEREST_RECEIVABLE: '1320',
  FEES_RECEIVABLE: '1330',
  PENAL_RECEIVABLE: '1340',
  CUSTOMER_ADVANCE: '2200',
  REPOSSESSED_ASSETS: '1500',
  BAD_DEBTS: '5600',
  BAD_DEBTS_RECOVERED: '4500',
  GST_OUTPUT: '2310',
  OPENING_EQUITY: '3900',
  INTEREST_INCOME: '4100',
  PENAL_INCOME: '4300',
  feeIncome(code: string): string {
    return code === 'PROCESSING' ? '4210' : code === 'DOCUMENTATION' ? '4220' : '4230';
  },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only writer of journal_entries / journal_lines (doc 02 §4). Business modules describe an
 * event; posting rules turn it into lines; this service validates and records them. The database
 * re-checks balance at commit, refuses edits, and refuses postings into locked periods.
 */
@Injectable()
export class LedgerService {
  private codeCache = new Map<string, string>();

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly crypto: CryptoService,
  ) {}

  async accountId(db: Executor, codeOrId: string): Promise<string> {
    if (UUID_RE.test(codeOrId)) return codeOrId;
    const cached = this.codeCache.get(codeOrId);
    if (cached) return cached;
    const row = await db.selectFrom('accounts').select('id').where('code', '=', codeOrId).executeTakeFirst();
    if (!row) throw new Error(`Account ${codeOrId} does not exist`);
    this.codeCache.set(codeOrId, row.id);
    return row.id;
  }

  async post(tx: Tx, p: Posting): Promise<{ id: string; entryNo: string }> {
    const lines = p.lines.filter((l) => (l.debit && !l.debit.isZero()) || (l.credit && !l.credit.isZero()));
    let dr = Money.zero();
    let cr = Money.zero();
    for (const l of lines) {
      if ((l.debit && l.credit) || (!l.debit && !l.credit)) throw new Error('Each line is either a debit or a credit');
      const amt = (l.debit ?? l.credit)!;
      if (!amt.isPositive()) throw new Error('Posting amounts must be positive');
      if (l.debit) dr = dr.plus(l.debit);
      else cr = cr.plus(l.credit!);
    }
    if (lines.length < 2 || !dr.eq(cr)) {
      throw new Error(`Unbalanced posting for ${p.sourceType}:${p.sourceId} (Dr ${dr.toString()} / Cr ${cr.toString()})`);
    }
    // The database refuses postings into locked months; say so clearly before it does.
    const period = await tx
      .selectFrom('accounting_periods')
      .select(['status', 'period_start'])
      .where('period_start', '<=', p.valueDate)
      .where('period_end', '>=', p.valueDate)
      .executeTakeFirst();
    if (period?.status === 'LOCKED') throw unprocessable('PERIOD_LOCKED', `The books for ${period.period_start.slice(0, 7)} are locked. Post it in an open month, or ask Management to reopen the month.`);
    if (period?.status === 'SOFT_LOCKED' && !['ADJUSTMENT', 'REVERSAL'].includes(p.entryType)) {
      throw unprocessable('PERIOD_SOFT_LOCKED', `The books for ${period.period_start.slice(0, 7)} are closed for new entries (only adjustments and reversals).`);
    }
    if (p.branchId && ['PAYMENT', 'DEPOSIT', 'EXPENSE', 'DISBURSEMENT', 'MANUAL', 'TRANSFER', 'FEE', 'SALE', 'WRITE_OFF'].includes(p.entryType)) {
      const day = await tx
        .selectFrom('business_days as d')
        .innerJoin('branches as b', 'b.id', 'd.branch_id')
        .select(['d.status', 'b.name'])
        .where('d.branch_id', '=', p.branchId)
        .where('d.business_date', '=', p.valueDate)
        .executeTakeFirst();
      if (day?.status === 'CLOSED') throw unprocessable('DAY_CLOSED', `${day.name}'s business day ${p.valueDate.split('-').reverse().join('/')} is closed. Ask the branch manager to reopen it, or record this on the next open day.`);
    }
    const entryNo = await this.numbering.next(tx, 'JOURNAL');
    const entry = await tx
      .insertInto('journal_entries')
      .values({
        entry_no: entryNo,
        entry_type: p.entryType,
        value_date: p.valueDate,
        branch_id: p.branchId,
        source_type: p.sourceType,
        source_id: p.sourceId,
        narration: p.narration,
        reverses_entry_id: p.reversesEntryId ?? null,
        created_by: p.createdBy,
        approved_by: p.approvedBy ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    let n = 1;
    for (const l of lines) {
      await tx
        .insertInto('journal_lines')
        .values({
          entry_id: entry.id,
          line_no: n++,
          account_id: await this.accountId(tx, l.account),
          debit: l.debit?.toString() ?? '0',
          credit: l.credit?.toString() ?? '0',
          branch_id: p.branchId,
          loan_id: l.loanId ?? null,
          customer_id: l.customerId ?? null,
          employee_id: l.employeeId ?? null,
          memo: l.memo ?? null,
        })
        .execute();
    }
    return { id: entry.id, entryNo };
  }

  /**
   * Post the exact mirror of an entry (doc 07 E10): every debit becomes a credit and vice versa,
   * linked by reverses_entry_id. The original stays untouched in its own date.
   */
  async reverse(tx: Tx, entryId: string, p: { valueDate: string; narration: string; createdBy: string | null; sourceType: string; sourceId: string; approvedBy?: string | null }) {
    const original = await tx.selectFrom('journal_entries').selectAll().where('id', '=', entryId).executeTakeFirstOrThrow();
    const lines = await tx.selectFrom('journal_lines').selectAll().where('entry_id', '=', entryId).orderBy('line_no').execute();
    return this.post(tx, {
      entryType: 'REVERSAL',
      valueDate: p.valueDate,
      branchId: original.branch_id,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      narration: p.narration,
      reversesEntryId: entryId,
      createdBy: p.createdBy,
      lines: lines.map((l) => ({
        account: l.account_id,
        ...(Money.of(l.debit).isPositive() ? { credit: Money.of(l.debit) } : { debit: Money.of(l.credit) }),
        loanId: l.loan_id,
        customerId: l.customer_id,
        employeeId: l.employee_id,
        memo: l.memo ? `Reversal: ${l.memo}` : 'Reversal',
      })),
    });
  }

  /** Cash-in-hand account for a collector (doc 07: 1120-{EMP}, decision D5). Idempotent. */
  async employeeCashAccount(db: Executor, employeeId: string): Promise<{ id: string; code: string }> {
    const existing = await db.selectFrom('accounts').select(['id', 'code']).where('employee_id', '=', employeeId).where('subtype', '=', 'EMPLOYEE_CASH').executeTakeFirst();
    if (existing) return existing;
    const e = await db.selectFrom('employees').select(['id', 'employee_code', 'full_name', 'branch_id']).where('id', '=', employeeId).executeTakeFirstOrThrow();
    const parent = await db.selectFrom('accounts').select('id').where('code', '=', '1100').executeTakeFirstOrThrow();
    await db
      .insertInto('accounts')
      .values({
        code: `1120-${e.employee_code}`,
        name: `Cash in Hand — ${e.full_name}`,
        type: 'ASSET',
        normal_balance: 'DEBIT',
        parent_id: parent.id,
        subtype: 'EMPLOYEE_CASH',
        branch_id: e.branch_id,
        employee_id: e.id,
        is_system: true,
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .execute();
    return db.selectFrom('accounts').select(['id', 'code']).where('code', '=', `1120-${e.employee_code}`).executeTakeFirstOrThrow();
  }

  /** Cash and cheque accounts every branch needs. Idempotent. */
  ensureBranchAccounts(db: Executor, branch: { id: string; code: string; name: string }) {
    return ensureBranchAccounts(db, branch);
  }

  async createBankAccount(
    tx: Tx,
    input: { name: string; bankName: string; branchName?: string; accountNumber?: string; ifsc?: string; upiVpa?: string; kind: string },
    userId: string,
  ) {
    const parent = await tx.selectFrom('accounts').select('id').where('code', '=', '1200').executeTakeFirstOrThrow();
    const n = await tx
      .selectFrom('accounts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('code', 'like', '1210-%')
      .executeTakeFirstOrThrow();
    const code = `1210-${String(Number(n.n) + 1).padStart(2, '0')}`;
    const acc = await tx
      .insertInto('accounts')
      .values({
        code,
        name: input.name,
        type: 'ASSET',
        normal_balance: 'DEBIT',
        parent_id: parent.id,
        subtype: 'BANK',
        created_by: userId,
      })
      .returning(['id', 'code', 'name'])
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('bank_accounts')
      .values({
        account_id: acc.id,
        bank_name: input.bankName,
        branch_name: input.branchName ?? null,
        account_no_enc: input.accountNumber ? this.crypto.encrypt(input.accountNumber, 'bank_accounts.account_no') : null,
        account_no_last4: input.accountNumber?.slice(-4) ?? null,
        ifsc: input.ifsc ?? null,
        upi_vpa: input.upiVpa ?? null,
        kind: input.kind,
        created_by: userId,
      })
      .execute();
    return acc;
  }

  /** Accounts that money can be paid out from, for a branch. */
  async payoutAccounts(db: Executor, branchId: string) {
    return db
      .selectFrom('accounts as a')
      .leftJoin('bank_accounts as b', 'b.account_id', 'a.id')
      .select(['a.id', 'a.code', 'a.name', 'a.subtype', 'b.bank_name', 'b.account_no_last4'])
      .where('a.is_active', '=', true)
      .where((eb) =>
        eb.or([eb.and([eb('a.subtype', '=', 'CASH'), eb('a.branch_id', '=', branchId)]), eb('a.subtype', '=', 'BANK')]),
      )
      .orderBy('a.code')
      .execute();
  }

  async assertPayoutAccount(db: Executor, accountId: string, branchId: string, mode: string) {
    const acc = (await this.payoutAccounts(db, branchId)).find((a) => a.id === accountId);
    if (!acc) throw notFound('Account');
    if (mode === 'CASH' && acc.subtype !== 'CASH') throw unprocessable('ACCOUNT_MISMATCH', 'Cash disbursements must come from a branch cash account');
    if (mode !== 'CASH' && acc.subtype === 'CASH') throw unprocessable('ACCOUNT_MISMATCH', 'Bank, UPI and cheque disbursements must come from a bank account');
    return acc;
  }

  /** Balances per account as of a date (debit-positive), from journal lines only. */
  async trialBalance(asOf: string, branchIds: string[] | null) {
    const rows = await sql<{ id: string; code: string; name: string; type: string; normal_balance: string; is_postable: boolean; parent_id: string | null; debit: string; credit: string }>`
      SELECT a.id, a.code, a.name, a.type, a.normal_balance, a.is_postable, a.parent_id,
             coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
      FROM accounts a
      LEFT JOIN journal_lines l ON l.account_id = a.id
        AND l.entry_id IN (SELECT id FROM journal_entries WHERE value_date <= ${asOf}::date)
        ${branchIds ? sql`AND l.branch_id = ANY(${branchIds}::uuid[])` : sql``}
      WHERE a.is_active
      GROUP BY a.id ORDER BY a.code`.execute(this.db);
    return rows.rows;
  }

  async accountLedger(accountId: string, from: string, to: string, branchIds: string[] | null) {
    const acc = await this.db.selectFrom('accounts').selectAll().where('id', '=', accountId).executeTakeFirst();
    if (!acc) throw notFound('Account');
    const filter = branchIds ? sql`AND l.branch_id = ANY(${branchIds}::uuid[])` : sql``;
    const opening = await sql<{ dr: string; cr: string }>`
      SELECT coalesce(sum(l.debit),0)::text dr, coalesce(sum(l.credit),0)::text cr FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ${accountId} AND e.value_date < ${from}::date ${filter}`.execute(this.db);
    const lines = await sql<{ entry_id: string; entry_no: string; value_date: string; entry_type: string; narration: string; debit: string; credit: string; memo: string | null; loan_id: string | null; loan_no: string | null }>`
      SELECT e.id entry_id, e.entry_no, e.value_date::text, e.entry_type, e.narration, l.debit::text, l.credit::text, l.memo, l.loan_id, ln.loan_no
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      LEFT JOIN loans ln ON ln.id = l.loan_id
      WHERE l.account_id = ${accountId} AND e.value_date BETWEEN ${from}::date AND ${to}::date ${filter}
      ORDER BY e.value_date, e.posted_at, l.line_no`.execute(this.db);
    const sign = acc.normal_balance === 'DEBIT' ? 1 : -1;
    let bal = Money.of(opening.rows[0]!.dr).minus(Money.of(opening.rows[0]!.cr));
    const openingBalance = sign === 1 ? bal : Money.zero().minus(bal);
    const out = lines.rows.map((r) => {
      bal = bal.plus(Money.of(r.debit)).minus(Money.of(r.credit));
      return { ...r, balance: (sign === 1 ? bal : Money.zero().minus(bal)).toString() };
    });
    return {
      account: { id: acc.id, code: acc.code, name: acc.name, type: acc.type, normalBalance: acc.normal_balance },
      from,
      to,
      openingBalance: openingBalance.toString(),
      closingBalance: (sign === 1 ? bal : Money.zero().minus(bal)).toString(),
      lines: out,
    };
  }

  async entriesForSource(db: Executor, filter: { loanId?: string }) {
    const entries = await db
      .selectFrom('journal_entries as e')
      .select(['e.id', 'e.entry_no', 'e.entry_type', 'e.value_date', 'e.posted_at', 'e.narration'])
      .where('e.id', 'in', (eb) => eb.selectFrom('journal_lines').select('entry_id').distinct().where('loan_id', '=', filter.loanId!))
      .orderBy('e.value_date')
      .orderBy('e.posted_at')
      .execute();
    if (!entries.length) return [];
    const lines = await db
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['l.entry_id', 'l.line_no', 'a.code', 'a.name', 'l.debit', 'l.credit', 'l.memo'])
      .where('l.entry_id', 'in', entries.map((e) => e.id))
      .orderBy('l.line_no')
      .execute();
    return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entry_id === e.id) }));
  }
}

/** Standalone so seeding (outside Nest) can call it too. */
export async function ensureBranchAccounts(db: Executor, branch: { id: string; code: string; name: string }) {
  const cash = await db.selectFrom('accounts').select('id').where('code', '=', '1100').executeTakeFirstOrThrow();
  const bank = await db.selectFrom('accounts').select('id').where('code', '=', '1200').executeTakeFirstOrThrow();
  await db
    .insertInto('accounts')
    .values([
      { code: `1110-${branch.code}`, name: `Branch Cash — ${branch.name}`, type: 'ASSET', normal_balance: 'DEBIT', parent_id: cash.id, subtype: 'CASH', branch_id: branch.id, is_system: true },
      { code: `1130-${branch.code}`, name: `Cheques in Hand — ${branch.name}`, type: 'ASSET', normal_balance: 'DEBIT', parent_id: cash.id, subtype: 'CHEQUES_IN_HAND', branch_id: branch.id, is_system: true },
      { code: `1250-${branch.code}`, name: `UPI Clearing — ${branch.name}`, type: 'ASSET', normal_balance: 'DEBIT', parent_id: bank.id, subtype: 'UPI_CLEARING', branch_id: branch.id, is_system: true },
    ])
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}
