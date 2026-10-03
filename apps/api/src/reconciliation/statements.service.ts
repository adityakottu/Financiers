import { Inject, Injectable } from '@nestjs/common';
import type { StatementMapping } from '@fin/contracts';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx } from '../db/db';
import { LedgerService } from '../ledger/ledger.service';
import { parseStatement } from './statement-parser';

type TargetType = 'PAYMENT' | 'DEPOSIT' | 'DISBURSEMENT' | 'EXPENSE' | 'SUSPENSE';
interface Candidate {
  type: TargetType;
  id: string;
  label: string;
  date: string;
  amount: string;
  reference: string | null;
  confidence: number;
  method: 'AUTO_REFERENCE' | 'AUTO_AMOUNT_DATE' | 'MANUAL';
}
interface Line {
  id: string;
  account_id: string;
  txn_date: string;
  description: string;
  reference: string | null;
  utr: string | null;
  debit: string;
  credit: string;
  match_status: string;
}

const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Bank / UPI statement import and matching (doc 09 §5). Suggest, then confirm: a payment is
 * never marked reconciled without a CONFIRMED match to a real statement line. Only an exact
 * reference + amount + date match may be auto-confirmed.
 */
@Injectable()
export class StatementsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  private async bankAccount(db: Executor, accountId: string) {
    const a = await db.selectFrom('accounts').select(['id', 'code', 'name', 'subtype']).where('id', '=', accountId).executeTakeFirst();
    if (!a || a.subtype !== 'BANK') throw notFound('Bank account');
    return a;
  }

  async preview(accountId: string, file: Express.Multer.File, mapping: StatementMapping) {
    await this.bankAccount(this.db, accountId);
    const p = await parseStatement(file.buffer, file.originalname, mapping, accountId);
    const existing = p.lines.length ? await this.db.selectFrom('bank_statement_lines').select('row_hash').where('row_hash', 'in', p.lines.map((l) => l.hash)).execute() : [];
    const dup = new Set(existing.map((e) => e.row_hash));
    return {
      header: p.header,
      total: p.lines.length + p.invalid.length,
      new: p.lines.filter((l) => !dup.has(l.hash)).length,
      duplicate: dup.size,
      invalid: p.invalid,
      rows: p.lines.slice(0, 200).map((l) => ({ ...l, status: dup.has(l.hash) ? 'DUPLICATE' : 'NEW' })),
    };
  }

  /**
   * Import new rows. Invalid rows are never skipped silently: the import is refused unless the
   * user has seen them and chosen to import the valid rows only (they stay listed on the import).
   */
  async import(ctx: RequestContext, accountId: string, file: Express.Multer.File, mapping: StatementMapping, acceptInvalid: boolean) {
    const acct = await this.bankAccount(this.db, accountId);
    const p = await parseStatement(file.buffer, file.originalname, mapping, accountId);
    if (p.invalid.length && !acceptInvalid) {
      throw unprocessable('INVALID_ROWS', `${p.invalid.length} row(s) could not be read. Fix the file or the column mapping, or confirm importing only the valid rows.`, { invalid: p.invalid.slice(0, 50) });
    }
    if (!p.lines.length) throw unprocessable('EMPTY_STATEMENT', 'No transactions found with this column mapping');
    const result = await this.db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('bank_statement_lines').select('row_hash').where('row_hash', 'in', p.lines.map((l) => l.hash)).execute();
      const dup = new Set(existing.map((e) => e.row_hash));
      const fresh = p.lines.filter((l) => !dup.has(l.hash));
      const dates = p.lines.map((l) => l.txnDate).sort();
      const imp = await tx
        .insertInto('bank_statement_imports')
        .values({
          account_id: accountId,
          file_name: file.originalname.slice(0, 200),
          file_sha256: createHash('sha256').update(file.buffer).digest('hex'),
          mapping: JSON.stringify(mapping),
          period_from: dates[0] ?? null,
          period_to: dates[dates.length - 1] ?? null,
          rows_total: p.lines.length + p.invalid.length,
          rows_new: fresh.length,
          rows_duplicate: dup.size,
          rows_invalid: p.invalid.length,
          invalid_rows: JSON.stringify(p.invalid),
          imported_by: ctx.auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const l of fresh) {
        await tx
          .insertInto('bank_statement_lines')
          .values({ import_id: imp.id, account_id: accountId, txn_date: l.txnDate, description: l.description.slice(0, 500), reference: l.reference, utr: l.utr, debit: l.debit, credit: l.credit, balance: l.balance, row_hash: l.hash })
          .onConflict((oc) => oc.column('row_hash').doNothing())
          .execute();
      }
      await this.audit.record(tx, ctx, { action: 'statement.imported', entityType: 'bank_statement_import', entityId: imp.id, newValues: { account: acct.code, file: file.originalname, new: fresh.length, duplicate: dup.size, invalid: p.invalid.length } });
      return { importId: imp.id, new: fresh.length, duplicate: dup.size, invalid: p.invalid.length };
    });
    const matching = await this.runMatching(ctx, accountId);
    return { ...result, matching };
  }

  /* ---------------------------- Matching ---------------------------- */

  private async candidates(db: Executor, line: Line): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const ref = norm(line.utr ?? line.reference);
    const text = norm(`${line.reference ?? ''} ${line.description}`);
    const refHit = (r: string | null) => {
      const n = norm(r);
      return n.length >= 4 && (n === ref || text.includes(n));
    };
    const d3 = [addDays(line.txn_date, -3), addDays(line.txn_date, 3)] as const;
    if (Money.of(line.credit).isPositive()) {
      const amount = line.credit;
      const pays = await db
        .selectFrom('payments as p')
        .innerJoin('loans as l', 'l.id', 'p.loan_id')
        .innerJoin('customers as c', 'c.id', 'p.customer_id')
        .select(['p.id', 'p.payment_no', 'p.method', 'p.reference_no', 'p.value_date', 'p.amount', 'p.debit_account_id', 'p.cheque_status', 'p.cheque_deposit_account_id', 'p.cheque_deposited_on', 'l.loan_no', 'c.full_name'])
        .where('p.status', '=', 'POSTED')
        .where('p.reconciliation_status', '<>', 'MATCHED')
        .where('p.amount', '=', amount)
        .where('p.value_date', '>=', addDays(line.txn_date, -10))
        .where('p.value_date', '<=', d3[1])
        .where((eb) =>
          eb.or([
            eb('p.method', '=', 'UPI'),
            eb.and([eb('p.method', '=', 'BANK_TRANSFER'), eb('p.debit_account_id', '=', line.account_id)]),
            eb.and([eb('p.method', '=', 'CHEQUE'), eb('p.cheque_status', '=', 'DEPOSITED'), eb('p.cheque_deposit_account_id', '=', line.account_id)]),
          ]),
        )
        .execute();
      for (const p of pays) {
        const when = p.method === 'CHEQUE' ? p.cheque_deposited_on! : p.value_date;
        const near = Math.abs(new Date(`${when}T00:00:00Z`).getTime() - new Date(`${line.txn_date}T00:00:00Z`).getTime()) / 86_400_000;
        const byRef = refHit(p.reference_no) && (p.method === 'CHEQUE' ? line.txn_date >= when && near <= 10 : near <= 3);
        if (!byRef && near > 1) continue;
        out.push({ type: 'PAYMENT', id: p.id, label: `${p.payment_no} · ${p.full_name} · ${p.loan_no} (${p.method === 'BANK_TRANSFER' ? 'bank transfer' : p.method === 'UPI' ? 'UPI' : 'cheque'} ${p.reference_no ?? ''})`, date: when, amount: p.amount, reference: p.reference_no, confidence: byRef ? 1 : 0.8, method: byRef ? 'AUTO_REFERENCE' : 'AUTO_AMOUNT_DATE' });
      }
      const deps = await db
        .selectFrom('cash_deposits as d')
        .innerJoin('accounts as f', 'f.id', 'd.from_account_id')
        .select(['d.id', 'd.deposit_no', 'd.slip_no', 'd.deposited_on', 'd.amount', 'f.name'])
        .where('d.status', '=', 'RECORDED')
        .where('d.reconciliation_status', '<>', 'MATCHED')
        .where('d.to_account_id', '=', line.account_id)
        .where('d.amount', '=', amount)
        .where('d.deposited_on', '>=', d3[0])
        .where('d.deposited_on', '<=', d3[1])
        .execute();
      for (const d of deps) {
        const near = Math.abs(new Date(`${d.deposited_on}T00:00:00Z`).getTime() - new Date(`${line.txn_date}T00:00:00Z`).getTime()) / 86_400_000;
        const byRef = refHit(d.slip_no);
        if (!byRef && near > 1) continue;
        out.push({ type: 'DEPOSIT', id: d.id, label: `${d.deposit_no} · cash from ${d.name}${d.slip_no ? ` (slip ${d.slip_no})` : ''}`, date: d.deposited_on, amount: d.amount, reference: d.slip_no, confidence: byRef ? 1 : 0.8, method: byRef ? 'AUTO_REFERENCE' : 'AUTO_AMOUNT_DATE' });
      }
    } else {
      const amount = line.debit;
      const loans = await db
        .selectFrom('loans as l')
        .innerJoin('customers as c', 'c.id', 'l.customer_id')
        .select(['l.id', 'l.loan_no', 'l.disbursement_reference', 'l.disbursed_on', 'l.net_disbursement', 'c.full_name'])
        .where('l.disbursement_account_id', '=', line.account_id)
        .where('l.net_disbursement', '=', amount)
        .where('l.disbursed_on', '>=', d3[0])
        .where('l.disbursed_on', '<=', d3[1])
        .execute();
      for (const l of loans) {
        const byRef = refHit(l.disbursement_reference);
        out.push({ type: 'DISBURSEMENT', id: l.id, label: `Disbursement ${l.loan_no} · ${l.full_name}`, date: l.disbursed_on!, amount: l.net_disbursement, reference: l.disbursement_reference, confidence: byRef ? 1 : 0.8, method: byRef ? 'AUTO_REFERENCE' : 'AUTO_AMOUNT_DATE' });
      }
      const exps = await db
        .selectFrom('expenses as e')
        .innerJoin('expense_categories as c', 'c.id', 'e.category_id')
        .select(['e.id', 'e.expense_no', 'e.expense_date', 'e.amount', 'e.bill_no', 'c.name'])
        .where('e.status', '=', 'POSTED')
        .where('e.paid_from_account_id', '=', line.account_id)
        .where('e.amount', '=', amount)
        .where('e.expense_date', '>=', addDays(line.txn_date, -1))
        .where('e.expense_date', '<=', addDays(line.txn_date, 1))
        .execute();
      for (const e of exps) out.push({ type: 'EXPENSE', id: e.id, label: `${e.expense_no} · ${e.name}`, date: e.expense_date, amount: e.amount, reference: e.bill_no, confidence: 0.8, method: 'AUTO_AMOUNT_DATE' });
    }
    // Leave out anything already confirmed against another line.
    if (!out.length) return out;
    const taken = await db.selectFrom('reconciliation_matches').select(['target_type', 'target_id']).where('status', '=', 'CONFIRMED').where('target_id', 'in', out.map((c) => c.id)).execute();
    return out.filter((c) => !taken.some((t) => t.target_type === c.type && t.target_id === c.id));
  }

  /** Suggest matches for open lines; auto-confirm only exact reference matches with a single candidate. */
  async runMatching(ctx: RequestContext, accountId?: string) {
    const lines = await this.db
      .selectFrom('bank_statement_lines')
      .select(['id', 'account_id', 'txn_date', 'description', 'reference', 'utr', 'debit', 'credit', 'match_status'])
      .where('match_status', 'in', ['UNMATCHED', 'SUGGESTED'])
      .$if(!!accountId, (q) => q.where('account_id', '=', accountId!))
      .orderBy('txn_date')
      .execute();
    let suggested = 0;
    let confirmed = 0;
    for (const line of lines) {
      const cands = await this.candidates(this.db, line);
      const strong = cands.filter((c) => c.confidence === 1);
      const pick = strong.length === 1 ? strong : strong.length === 0 && cands.length === 1 ? cands : [];
      if (!pick.length) continue;
      const c = pick[0]!;
      await this.db.transaction().execute(async (tx) => {
        const l = await tx.selectFrom('bank_statement_lines').select('match_status').where('id', '=', line.id).forUpdate().executeTakeFirstOrThrow();
        if (!['UNMATCHED', 'SUGGESTED'].includes(l.match_status)) return;
        const exists = await tx.selectFrom('reconciliation_matches').select('id').where('statement_line_id', '=', line.id).where('target_id', '=', c.id).where('status', '=', 'SUGGESTED').executeTakeFirst();
        const m =
          exists ??
          (await tx
            .insertInto('reconciliation_matches')
            .values({ statement_line_id: line.id, target_type: c.type, target_id: c.id, amount: c.amount, confidence: String(c.confidence), method: c.method })
            .returning('id')
            .executeTakeFirstOrThrow());
        await tx.updateTable('bank_statement_lines').set({ match_status: 'SUGGESTED' }).where('id', '=', line.id).execute();
        if (!exists) suggested++;
        if (c.confidence === 1) {
          await this.confirmIn(tx, ctx, m.id, true);
          confirmed++;
        }
      });
    }
    return { scanned: lines.length, suggested, autoConfirmed: confirmed };
  }

  /** Post E7 (UPI clearing → bank) and mark the target reconciled. */
  private async confirmIn(tx: Tx, ctx: RequestContext, matchId: string, auto = false) {
    const m = await tx.selectFrom('reconciliation_matches').selectAll().where('id', '=', matchId).forUpdate().executeTakeFirst();
    if (!m) throw notFound('Match');
    if (m.status !== 'SUGGESTED') throw conflict('INVALID_STATE', `This match is ${m.status.toLowerCase()}`);
    const line = await tx.selectFrom('bank_statement_lines').selectAll().where('id', '=', m.statement_line_id).forUpdate().executeTakeFirstOrThrow();
    if (line.match_status === 'MATCHED' || line.match_status === 'IGNORED') throw conflict('INVALID_STATE', 'This statement line is already handled');
    let journalId: string | null = null;
    if (m.target_type === 'PAYMENT') {
      const p = await tx.selectFrom('payments').selectAll().where('id', '=', m.target_id).forUpdate().executeTakeFirstOrThrow();
      if (p.status !== 'POSTED' || p.reconciliation_status === 'MATCHED') throw conflict('INVALID_STATE', `Payment ${p.payment_no} is no longer open for matching`);
      if (p.method === 'UPI') {
        // E7: the UPI money has reached the bank.
        const valueDate = await this.openDate(tx, p.branch_id, line.txn_date);
        const e = await this.ledger.post(tx, {
          entryType: 'TRANSFER',
          valueDate,
          branchId: p.branch_id,
          sourceType: 'reconciliation_match',
          sourceId: m.id,
          narration: `UPI ${p.reference_no} (${p.payment_no}) received in bank`,
          lines: [
            { account: line.account_id, debit: Money.of(p.amount), loanId: p.loan_id, memo: `UPI ${p.reference_no}` },
            { account: p.debit_account_id, credit: Money.of(p.amount), loanId: p.loan_id, memo: `UPI ${p.reference_no}` },
          ],
          createdBy: auto ? null : ctx.auth.userId,
        });
        journalId = e.id;
      }
      await tx
        .updateTable('payments')
        .set({ reconciliation_status: 'MATCHED', reconciled_at: new Date(), ...(p.method === 'CHEQUE' && p.cheque_status === 'DEPOSITED' ? { cheque_status: 'CLEARED', cheque_cleared_on: line.txn_date } : {}) })
        .where('id', '=', p.id)
        .execute();
    } else if (m.target_type === 'DEPOSIT') {
      await tx.updateTable('cash_deposits').set({ reconciliation_status: 'MATCHED', reconciled_at: new Date() }).where('id', '=', m.target_id).execute();
    }
    await tx.updateTable('reconciliation_matches').set({ status: 'CONFIRMED', confirmed_by: auto ? null : ctx.auth.userId, confirmed_at: new Date(), journal_entry_id: journalId }).where('id', '=', m.id).execute();
    await tx.updateTable('reconciliation_matches').set({ status: 'REJECTED' }).where('statement_line_id', '=', line.id).where('status', '=', 'SUGGESTED').where('id', '<>', m.id).execute();
    await tx.updateTable('bank_statement_lines').set({ match_status: 'MATCHED', handled_by: auto ? null : ctx.auth.userId, handled_at: new Date() }).where('id', '=', line.id).execute();
    await this.audit.record(tx, ctx, { action: auto ? 'recon.auto_matched' : 'recon.matched', entityType: 'bank_statement_line', entityId: line.id, newValues: { target: m.target_type, targetId: m.target_id, amount: m.amount, method: m.method } });
  }

  /** Statement date, unless that branch day or month is closed — then today (the original day stays as closed). */
  private async openDate(tx: Tx, branchId: string, date: string) {
    const closed = await tx.selectFrom('business_days').select('id').where('branch_id', '=', branchId).where('business_date', '=', date).where('status', '=', 'CLOSED').executeTakeFirst();
    const locked = await tx.selectFrom('accounting_periods').select('id').where('period_start', '<=', date).where('period_end', '>=', date).where('status', '<>', 'OPEN').executeTakeFirst();
    return closed || locked ? istToday() : date;
  }

  confirm(ctx: RequestContext, matchId: string) {
    return this.db.transaction().execute((tx) => this.confirmIn(tx, ctx, matchId));
  }

  async reject(ctx: RequestContext, matchId: string) {
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('reconciliation_matches').selectAll().where('id', '=', matchId).forUpdate().executeTakeFirst();
      if (!m || m.status !== 'SUGGESTED') throw conflict('INVALID_STATE', 'Only a suggestion can be rejected');
      await tx.updateTable('reconciliation_matches').set({ status: 'REJECTED' }).where('id', '=', matchId).execute();
      const left = await tx.selectFrom('reconciliation_matches').select('id').where('statement_line_id', '=', m.statement_line_id).where('status', '=', 'SUGGESTED').executeTakeFirst();
      if (!left) await tx.updateTable('bank_statement_lines').set({ match_status: 'UNMATCHED' }).where('id', '=', m.statement_line_id).where('match_status', '=', 'SUGGESTED').execute();
      await this.audit.record(tx, ctx, { action: 'recon.suggestion_rejected', entityType: 'bank_statement_line', entityId: m.statement_line_id, newValues: { target: m.target_type, targetId: m.target_id } });
    });
  }

  /** Undo a confirmed match (audited). A UPI clearing entry is reversed today. */
  async undo(ctx: RequestContext, matchId: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('reconciliation_matches').selectAll().where('id', '=', matchId).forUpdate().executeTakeFirst();
      if (!m || m.status !== 'CONFIRMED') throw conflict('INVALID_STATE', 'Only a confirmed match can be undone');
      let undoJournal: string | null = null;
      if (m.journal_entry_id) {
        const r = await this.ledger.reverse(tx, m.journal_entry_id, { valueDate: istToday(), narration: `Match undone: ${reason}`.slice(0, 500), createdBy: ctx.auth.userId, sourceType: 'reconciliation_match', sourceId: m.id });
        undoJournal = r.id;
      }
      const line = await tx.selectFrom('bank_statement_lines').select(['id', 'txn_date']).where('id', '=', m.statement_line_id).executeTakeFirstOrThrow();
      if (m.target_type === 'PAYMENT') {
        const p = await tx.selectFrom('payments').select(['id', 'method', 'cheque_status', 'cheque_cleared_on']).where('id', '=', m.target_id).forUpdate().executeTakeFirstOrThrow();
        await tx
          .updateTable('payments')
          .set({ reconciliation_status: 'UNRECONCILED', reconciled_at: null, ...(p.method === 'CHEQUE' && p.cheque_status === 'CLEARED' && p.cheque_cleared_on === line.txn_date ? { cheque_status: 'DEPOSITED', cheque_cleared_on: null } : {}) })
          .where('id', '=', p.id)
          .execute();
      } else if (m.target_type === 'DEPOSIT') {
        await tx.updateTable('cash_deposits').set({ reconciliation_status: 'UNRECONCILED', reconciled_at: null }).where('id', '=', m.target_id).execute();
      }
      await tx.updateTable('reconciliation_matches').set({ status: 'UNDONE', undone_by: ctx.auth.userId, undone_at: new Date(), undo_reason: reason, undo_journal_entry_id: undoJournal }).where('id', '=', matchId).execute();
      await tx.updateTable('bank_statement_lines').set({ match_status: 'UNMATCHED', handled_by: null, handled_at: null }).where('id', '=', m.statement_line_id).execute();
      await this.audit.record(tx, ctx, { action: 'recon.match_undone', entityType: 'bank_statement_line', entityId: m.statement_line_id, newValues: { target: m.target_type, targetId: m.target_id }, reason });
    });
  }

  /** Pick a candidate by hand (from the suggestions for this line). */
  async manualMatch(ctx: RequestContext, lineId: string, type: TargetType, targetId: string) {
    return this.db.transaction().execute(async (tx) => {
      const line = await tx.selectFrom('bank_statement_lines').selectAll().where('id', '=', lineId).forUpdate().executeTakeFirst();
      if (!line) throw notFound('Statement line');
      const cands = await this.candidates(tx, { ...line, debit: line.debit, credit: line.credit } as Line);
      const c = cands.find((x) => x.type === type && x.id === targetId);
      if (!c) throw unprocessable('NOT_A_CANDIDATE', 'That item does not match this line’s amount and date');
      const m = await tx.insertInto('reconciliation_matches').values({ statement_line_id: lineId, target_type: type, target_id: targetId, amount: c.amount, confidence: String(c.confidence), method: 'MANUAL' }).returning('id').executeTakeFirstOrThrow();
      await this.confirmIn(tx, ctx, m.id);
      return { id: m.id };
    });
  }

  /** Mark a line as explained without a system record (e.g. bank interest, charges booked separately). */
  async ignore(ctx: RequestContext, lineId: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      const line = await tx.selectFrom('bank_statement_lines').select(['id', 'match_status']).where('id', '=', lineId).forUpdate().executeTakeFirst();
      if (!line) throw notFound('Statement line');
      if (line.match_status === 'MATCHED') throw conflict('INVALID_STATE', 'Undo the match first');
      await tx.updateTable('reconciliation_matches').set({ status: 'REJECTED' }).where('statement_line_id', '=', lineId).where('status', '=', 'SUGGESTED').execute();
      await tx.updateTable('bank_statement_lines').set({ match_status: 'IGNORED', ignore_reason: reason, handled_by: ctx.auth.userId, handled_at: new Date() }).where('id', '=', lineId).execute();
      await this.audit.record(tx, ctx, { action: 'recon.line_ignored', entityType: 'bank_statement_line', entityId: lineId, reason });
    });
  }

  /** An unidentified credit: book it to Suspense (2250) so the bank ties out, until someone identifies it. */
  async toSuspense(ctx: RequestContext, lineId: string, note: string) {
    return this.db.transaction().execute(async (tx) => {
      const line = await tx.selectFrom('bank_statement_lines').selectAll().where('id', '=', lineId).forUpdate().executeTakeFirst();
      if (!line) throw notFound('Statement line');
      if (!Money.of(line.credit).isPositive()) throw badRequest('VALIDATION_FAILED', 'Only money received can go to suspense');
      if (line.match_status === 'MATCHED' || line.match_status === 'IGNORED') throw conflict('INVALID_STATE', 'This line is already handled');
      const m = await tx.insertInto('reconciliation_matches').values({ statement_line_id: lineId, target_type: 'SUSPENSE', target_id: lineId, amount: line.credit, confidence: '0', method: 'MANUAL', status: 'CONFIRMED', confirmed_by: ctx.auth.userId, confirmed_at: new Date() }).returning('id').executeTakeFirstOrThrow();
      const valueDate = (await tx.selectFrom('accounting_periods').select('id').where('period_start', '<=', line.txn_date).where('period_end', '>=', line.txn_date).where('status', '<>', 'OPEN').executeTakeFirst()) ? istToday() : line.txn_date;
      const e = await this.ledger.post(tx, {
        entryType: 'ADJUSTMENT',
        valueDate,
        branchId: null,
        sourceType: 'reconciliation_match',
        sourceId: m.id,
        narration: `Unidentified bank credit held in suspense: ${line.description}`.slice(0, 500),
        lines: [
          { account: line.account_id, debit: Money.of(line.credit), memo: line.reference ?? line.utr ?? 'Statement credit' },
          { account: '2250', credit: Money.of(line.credit), memo: note.slice(0, 200) },
        ],
        createdBy: ctx.auth.userId,
      });
      await tx.updateTable('reconciliation_matches').set({ journal_entry_id: e.id }).where('id', '=', m.id).execute();
      await tx.updateTable('bank_statement_lines').set({ match_status: 'MATCHED', handled_by: ctx.auth.userId, handled_at: new Date() }).where('id', '=', lineId).execute();
      await this.audit.record(tx, ctx, { action: 'recon.to_suspense', entityType: 'bank_statement_line', entityId: lineId, newValues: { amount: line.credit, journal: e.entryNo }, reason: note });
      return { journalEntryNo: e.entryNo };
    });
  }

  /* ---------------------------- Reads ---------------------------- */

  async lines(q: { accountId?: string; status?: string; from?: string; to?: string; limit: number }) {
    const rows = await this.db
      .selectFrom('bank_statement_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .selectAll('l')
      .select(['a.name as account_name'])
      .$if(!!q.accountId, (s) => s.where('l.account_id', '=', q.accountId!))
      .$if(!!q.status, (s) => s.where('l.match_status', '=', q.status!))
      .$if(!!q.from, (s) => s.where('l.txn_date', '>=', q.from!))
      .$if(!!q.to, (s) => s.where('l.txn_date', '<=', q.to!))
      .orderBy('l.txn_date', 'desc')
      .orderBy('l.seq', 'desc')
      .limit(q.limit)
      .execute();
    const ids = rows.map((r) => r.id);
    const matches = ids.length
      ? await this.db.selectFrom('reconciliation_matches').selectAll().where('statement_line_id', 'in', ids).where('status', 'in', ['SUGGESTED', 'CONFIRMED']).execute()
      : [];
    return rows.map((r) => ({ ...r, matches: matches.filter((m) => m.statement_line_id === r.id) }));
  }

  async lineCandidates(lineId: string) {
    const line = await this.db.selectFrom('bank_statement_lines').selectAll().where('id', '=', lineId).executeTakeFirst();
    if (!line) throw notFound('Statement line');
    return { line, candidates: await this.candidates(this.db, line as Line) };
  }

  async imports(accountId?: string) {
    return this.db
      .selectFrom('bank_statement_imports as i')
      .innerJoin('accounts as a', 'a.id', 'i.account_id')
      .innerJoin('users as u', 'u.id', 'i.imported_by')
      .select(['i.id', 'i.file_name', 'i.period_from', 'i.period_to', 'i.rows_total', 'i.rows_new', 'i.rows_duplicate', 'i.rows_invalid', 'i.imported_at', 'a.name as account_name', 'u.full_name as imported_by_name'])
      .$if(!!accountId, (q) => q.where('i.account_id', '=', accountId!))
      .orderBy('i.imported_at', 'desc')
      .limit(50)
      .execute();
  }

  /** UPI / bank transfers recorded but not seen on any statement after `days` days — possible fake screenshots or failed transfers. */
  async unconfirmedReceipts(auth: AuthContext, days = 3) {
    const cutoff = addDays(istToday(), -days);
    const branches = auth.scope === 'ALL' ? null : auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000'];
    return this.db
      .selectFrom('payments as p')
      .innerJoin('loans as l', 'l.id', 'p.loan_id')
      .innerJoin('customers as c', 'c.id', 'p.customer_id')
      .leftJoin('employees as e', 'e.id', 'p.collected_by')
      .select(['p.id', 'p.payment_no', 'p.amount', 'p.method', 'p.reference_no', 'p.value_date', 'l.loan_no', 'c.full_name as customer_name', 'e.full_name as collector'])
      .where('p.status', '=', 'POSTED')
      .where('p.method', 'in', ['UPI', 'BANK_TRANSFER'])
      .where('p.reconciliation_status', '<>', 'MATCHED')
      .where('p.value_date', '<=', cutoff)
      .$if(!!branches, (q) => q.where('p.branch_id', 'in', branches!))
      .orderBy('p.value_date')
      .limit(200)
      .execute();
  }

  /**
   * Bank reconciliation (doc 09 §1): ledger balance vs statement balance, with the items that
   * explain the gap. An unexplained difference is shown, never hidden.
   */
  async bankReconciliation(accountId: string, asOf: string) {
    const acct = await this.bankAccount(this.db, accountId);
    const ledger = await sql<{ b: string }>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ${accountId} AND e.value_date <= ${asOf}::date`.execute(this.db);
    const last = await this.db
      .selectFrom('bank_statement_lines')
      .select(['balance', 'txn_date'])
      .where('account_id', '=', accountId)
      .where('txn_date', '<=', asOf)
      .where('balance', 'is not', null)
      .orderBy('txn_date', 'desc')
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    // Book items touching this bank that no statement line has confirmed yet.
    const bookOnly = await sql<{ kind: string; id: string; ref: string; date: string; amount: string; direction: 'IN' | 'OUT' }>`
      SELECT 'Bank transfer' kind, p.id::text, p.payment_no ref, p.value_date::text date, p.amount::text, 'IN' direction FROM payments p
        WHERE p.method = 'BANK_TRANSFER' AND p.debit_account_id = ${accountId} AND p.status = 'POSTED' AND p.reconciliation_status <> 'MATCHED' AND p.value_date <= ${asOf}::date
      UNION ALL
      SELECT 'Cheque deposited', p.id::text, p.payment_no, p.cheque_deposited_on::text, p.amount::text, 'IN' FROM payments p
        WHERE p.method = 'CHEQUE' AND p.cheque_deposit_account_id = ${accountId} AND p.cheque_status = 'DEPOSITED' AND p.reconciliation_status <> 'MATCHED' AND p.cheque_deposited_on <= ${asOf}::date
      UNION ALL
      SELECT 'Cash deposit', d.id::text, d.deposit_no, d.deposited_on::text, d.amount::text, 'IN' FROM cash_deposits d
        WHERE d.to_account_id = ${accountId} AND d.status = 'RECORDED' AND d.reconciliation_status <> 'MATCHED' AND d.deposited_on <= ${asOf}::date
      UNION ALL
      SELECT 'Disbursement', l.id::text, l.loan_no, l.disbursed_on::text, l.net_disbursement::text, 'OUT' FROM loans l
        WHERE l.disbursement_account_id = ${accountId} AND l.disbursed_on <= ${asOf}::date
          AND NOT EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.target_type = 'DISBURSEMENT' AND m.target_id = l.id::text AND m.status = 'CONFIRMED')
      UNION ALL
      SELECT 'Expense', e.id::text, e.expense_no, e.expense_date::text, e.amount::text, 'OUT' FROM expenses e
        WHERE e.paid_from_account_id = ${accountId} AND e.status = 'POSTED' AND e.expense_date <= ${asOf}::date
          AND NOT EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.target_type = 'EXPENSE' AND m.target_id = e.id::text AND m.status = 'CONFIRMED')
      ORDER BY date`.execute(this.db);
    const statementOnly = await this.db
      .selectFrom('bank_statement_lines')
      .select(['id', 'txn_date', 'description', 'debit', 'credit', 'match_status', 'ignore_reason'])
      .where('account_id', '=', accountId)
      .where('txn_date', '<=', asOf)
      .where('match_status', 'in', ['UNMATCHED', 'SUGGESTED', 'IGNORED'])
      .orderBy('txn_date')
      .execute();
    const bal = Money.of(ledger.rows[0]!.b);
    const st = last ? Money.of(last.balance!) : null;
    const inT = Money.sum(bookOnly.rows.filter((r) => r.direction === 'IN').map((r) => Money.of(r.amount)));
    const outT = Money.sum(bookOnly.rows.filter((r) => r.direction === 'OUT').map((r) => Money.of(r.amount)));
    const stIn = Money.sum(statementOnly.map((r) => Money.of(r.credit)));
    const stOut = Money.sum(statementOnly.map((r) => Money.of(r.debit)));
    // statement + book receipts not yet in bank − book payments not yet in bank − bank credits not in books + bank debits not in books = ledger
    const adjusted = st ? st.plus(inT).minus(outT).minus(stIn).plus(stOut) : null;
    return {
      account: acct,
      asOf,
      ledgerBalance: bal.toString(),
      statementBalance: st?.toString() ?? null,
      statementBalanceDate: last?.txn_date ?? null,
      bookOnly: bookOnly.rows,
      statementOnly,
      totals: { bookIn: inT.toString(), bookOut: outT.toString(), statementIn: stIn.toString(), statementOut: stOut.toString() },
      adjustedStatementBalance: adjusted?.toString() ?? null,
      unexplained: adjusted ? bal.minus(adjusted).toString() : null,
    };
  }
}
