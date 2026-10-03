import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { LedgerService } from '../ledger/ledger.service';

const NONE = '00000000-0000-0000-0000-000000000000';
/** Control accounts whose balances must equal a sub-ledger (loans, advances). Only business events post to them. */
const CONTROLLED = ['LOAN_RECEIVABLE', 'INTEREST_RECEIVABLE', 'FEES_RECEIVABLE', 'PENAL_RECEIVABLE', 'CUSTOMER_ADVANCE'];

interface LineInput {
  accountId: string;
  debit: string;
  credit: string;
  memo?: string;
}

const monthBounds = (m: string) => {
  const start = `${m}-01`;
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { start, end: d.toISOString().slice(0, 10) };
};

/** Manual journals (two people), the journal browser, and month locks (doc 07 §6). */
@Injectable()
export class JournalsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------- Manual journals ---------------------------- */

  async create(ctx: RequestContext, input: { valueDate: string; branchId?: string; narration: string; lines: LineInput[] }) {
    if (input.branchId) scope.assertBranchWritable(ctx.auth, input.branchId);
    else if (ctx.auth.scope !== 'ALL') throw badRequest('VALIDATION_FAILED', 'Choose the branch', [{ path: 'branchId', message: 'Required' }]);
    if (input.valueDate > istToday()) throw unprocessable('FUTURE_DATE', 'Manual journals cannot be dated in the future');
    const accounts = await this.db
      .selectFrom('accounts')
      .select(['id', 'code', 'name', 'subtype', 'is_postable', 'is_active'])
      .where('id', 'in', input.lines.map((l) => l.accountId))
      .execute();
    const problems: { path: string; message: string }[] = [];
    input.lines.forEach((l, i) => {
      const a = accounts.find((x) => x.id === l.accountId);
      if (!a) problems.push({ path: `lines.${i}.accountId`, message: 'Unknown account' });
      else if (!a.is_postable || !a.is_active) problems.push({ path: `lines.${i}.accountId`, message: `${a.code} is a group or inactive account` });
      else if (CONTROLLED.includes(a.subtype ?? '')) problems.push({ path: `lines.${i}.accountId`, message: `${a.code} ${a.name} is kept in step with loans; use the loan’s own actions (payment, waiver, reversal)` });
    });
    const dr = Money.sum(input.lines.map((l) => Money.of(l.debit)));
    const cr = Money.sum(input.lines.map((l) => Money.of(l.credit)));
    if (!dr.eq(cr)) problems.push({ path: 'lines', message: `Debits ₹${dr.format({ symbol: false })} and credits ₹${cr.format({ symbol: false })} must be equal` });
    if (problems.length) throw badRequest('VALIDATION_FAILED', problems[0]!.message, problems);
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('manual_journals')
        .values({ value_date: input.valueDate, branch_id: input.branchId ?? null, narration: input.narration, lines: JSON.stringify(input.lines), total: dr.toString(), created_by: ctx.auth.userId })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, { action: 'journal.manual_created', entityType: 'manual_journal', entityId: row.id, branchId: input.branchId ?? null, newValues: { valueDate: input.valueDate, narration: input.narration, total: dr.toString(), lines: input.lines } });
      return row;
    });
  }

  async approve(ctx: RequestContext, id: string, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('manual_journals').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m || (m.branch_id && !scope.canAccessBranch(ctx.auth, m.branch_id)) || (!m.branch_id && ctx.auth.scope !== 'ALL')) throw notFound('Manual journal');
      if (m.status !== 'PENDING') throw conflict('INVALID_STATE', `This journal is ${m.status.toLowerCase()}`);
      if (m.created_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You prepared this journal, so someone else must approve it');
      const lines = m.lines as unknown as LineInput[];
      const entry = await this.ledger.post(tx, {
        entryType: 'MANUAL',
        valueDate: m.value_date,
        branchId: m.branch_id,
        sourceType: 'manual_journal',
        sourceId: id,
        narration: m.narration,
        lines: lines.map((l) => ({ account: l.accountId, ...(Money.of(l.debit).isPositive() ? { debit: Money.of(l.debit) } : { credit: Money.of(l.credit) }), memo: l.memo })),
        createdBy: m.created_by,
        approvedBy: ctx.auth.userId,
      });
      await tx.updateTable('manual_journals').set({ status: 'APPROVED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null, journal_entry_id: entry.id }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'journal.manual_approved', entityType: 'manual_journal', entityId: id, branchId: m.branch_id, oldValues: { status: 'PENDING' }, newValues: { status: 'APPROVED', journal: entry.entryNo } });
      return { id, status: 'APPROVED', journalEntryNo: entry.entryNo };
    });
  }

  async reject(ctx: RequestContext, id: string, note: string) {
    return this.db.transaction().execute(async (tx) => {
      const m = await tx.selectFrom('manual_journals').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m || (m.branch_id && !scope.canAccessBranch(ctx.auth, m.branch_id))) throw notFound('Manual journal');
      if (m.status !== 'PENDING') throw conflict('INVALID_STATE', `This journal is ${m.status.toLowerCase()}`);
      if (m.created_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'Ask another approver to reject it');
      await tx.updateTable('manual_journals').set({ status: 'REJECTED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note }).where('id', '=', id).execute();
      await this.audit.record(tx, ctx, { action: 'journal.manual_rejected', entityType: 'manual_journal', entityId: id, branchId: m.branch_id, oldValues: { status: 'PENDING' }, newValues: { status: 'REJECTED', note } });
      return { id, status: 'REJECTED' };
    });
  }

  async listManual(auth: AuthContext, status?: string) {
    const branches = scope.branchFilter(auth);
    let sel = this.db
      .selectFrom('manual_journals as m')
      .innerJoin('users as u', 'u.id', 'm.created_by')
      .leftJoin('users as d', 'd.id', 'm.decided_by')
      .leftJoin('journal_entries as e', 'e.id', 'm.journal_entry_id')
      .leftJoin('branches as b', 'b.id', 'm.branch_id')
      .select(['m.id', 'm.value_date', 'm.narration', 'm.total', 'm.status', 'm.lines', 'm.created_at', 'm.created_by', 'm.decided_at', 'm.decision_note', 'u.full_name as created_by_name', 'd.full_name as decided_by_name', 'e.entry_no', 'e.id as entry_id', 'b.code as branch_code'])
      .orderBy('m.created_at', 'desc')
      .limit(200);
    if (branches) sel = sel.where('m.branch_id', 'in', branches.length ? branches : [NONE]);
    if (status) sel = sel.where('m.status', '=', status);
    const rows = await sel.execute();
    const ids = [...new Set(rows.flatMap((r) => (r.lines as unknown as LineInput[]).map((l) => l.accountId)))];
    const accts = ids.length ? await this.db.selectFrom('accounts').select(['id', 'code', 'name']).where('id', 'in', ids).execute() : [];
    return rows.map((r) => ({
      ...r,
      lines: (r.lines as unknown as LineInput[]).map((l) => ({ ...l, code: accts.find((a) => a.id === l.accountId)?.code, name: accts.find((a) => a.id === l.accountId)?.name })),
      canDecide: r.status === 'PENDING' && r.created_by !== auth.userId && auth.permissions.has('journal.approve'),
    }));
  }

  /* ---------------------------- Journal browser ---------------------------- */

  async list(auth: AuthContext, q: { from?: string; to?: string; type?: string; branchId?: string; q?: string; limit: number; cursor?: string }) {
    const branches = scope.branchFilter(auth);
    let sel = this.db
      .selectFrom('journal_entries as e')
      .leftJoin('branches as b', 'b.id', 'e.branch_id')
      .leftJoin('users as u', 'u.id', 'e.created_by')
      .select([
        'e.id', 'e.entry_no', 'e.entry_type', 'e.value_date', 'e.posted_at', 'e.narration', 'e.source_type', 'e.source_id', 'e.reverses_entry_id', 'b.code as branch_code', 'u.full_name as created_by_name',
        (eb) => eb.selectFrom('journal_lines').select(sql<string>`sum(debit)::text`.as('t')).whereRef('entry_id', '=', 'e.id').as('total'),
      ])
      .orderBy('e.id', 'desc')
      .limit(q.limit + 1);
    if (branches) sel = sel.where('e.branch_id', 'in', branches.length ? branches : [NONE]);
    if (q.from) sel = sel.where('e.value_date', '>=', q.from);
    if (q.to) sel = sel.where('e.value_date', '<=', q.to);
    if (q.type) sel = sel.where('e.entry_type', '=', q.type);
    if (q.branchId) sel = sel.where('e.branch_id', '=', q.branchId);
    if (q.cursor) sel = sel.where('e.id', '<', q.cursor);
    if (q.q) {
      const t = q.q.replace(/[%_\\]/g, '');
      sel = sel.where((eb) => eb.or([eb('e.entry_no', 'ilike', `%${t}%`), eb('e.narration', 'ilike', `%${t}%`)]));
    }
    const rows = await sel.execute();
    const data = rows.slice(0, q.limit);
    return { data, nextCursor: rows.length > q.limit ? data[data.length - 1]!.id : null };
  }

  async get(auth: AuthContext, id: string) {
    const e = await this.db
      .selectFrom('journal_entries as e')
      .leftJoin('branches as b', 'b.id', 'e.branch_id')
      .leftJoin('users as c', 'c.id', 'e.created_by')
      .leftJoin('users as a', 'a.id', 'e.approved_by')
      .leftJoin('journal_entries as r', 'r.id', 'e.reverses_entry_id')
      .leftJoin('journal_entries as rb', 'rb.reverses_entry_id', 'e.id')
      .selectAll('e')
      .select(['b.code as branch_code', 'c.full_name as created_by_name', 'a.full_name as approved_by_name', 'r.entry_no as reverses_entry_no', 'rb.id as reversed_by_id', 'rb.entry_no as reversed_by_entry_no'])
      .where('e.id', '=', id)
      .executeTakeFirst();
    if (!e || (e.branch_id && !scope.canAccessBranch(auth, e.branch_id) && auth.scope !== 'ALL')) throw notFound('Journal entry');
    const lines = await this.db
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .leftJoin('loans as ln', 'ln.id', 'l.loan_id')
      .leftJoin('employees as em', 'em.id', 'l.employee_id')
      .select(['l.line_no', 'a.id as account_id', 'a.code', 'a.name', 'l.debit', 'l.credit', 'l.memo', 'ln.id as loan_id', 'ln.loan_no', 'em.full_name as employee'])
      .where('l.entry_id', '=', id)
      .orderBy('l.line_no')
      .execute();
    return { ...e, lines };
  }

  /* ---------------------------- Periods ---------------------------- */

  async periods() {
    const first = await this.db.selectFrom('journal_entries').select(sql<string>`to_char(min(value_date), 'YYYY-MM')`.as('m')).executeTakeFirst();
    const now = istToday().slice(0, 7);
    const start = first?.m && first.m < now ? first.m : now;
    const months: string[] = [];
    for (let m = start; m <= now; ) {
      months.push(m);
      const d = new Date(`${m}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      m = d.toISOString().slice(0, 7);
    }
    const rows = await this.db
      .selectFrom('accounting_periods as p')
      .leftJoin('users as s', 's.id', 'p.soft_locked_by')
      .leftJoin('users as l', 'l.id', 'p.locked_by')
      .leftJoin('users as u', 'u.id', 'p.unlocked_by')
      .select(['p.period_start', 'p.status', 'p.soft_locked_at', 'p.locked_at', 'p.unlocked_at', 'p.unlock_reason', 's.full_name as soft_locked_by', 'l.full_name as locked_by', 'u.full_name as unlocked_by'])
      .execute();
    const counts = await this.db
      .selectFrom('journal_entries')
      .select([sql<string>`to_char(value_date, 'YYYY-MM')`.as('m'), sql<string>`count(*)::text`.as('n')])
      .groupBy(sql`to_char(value_date, 'YYYY-MM')`)
      .execute();
    return months.reverse().map((m) => {
      const p = rows.find((r) => r.period_start.startsWith(m));
      return { month: m, status: p?.status ?? 'OPEN', entries: Number(counts.find((c) => c.m === m)?.n ?? 0), current: m === now, ...(p ?? {}) };
    });
  }

  async setPeriod(ctx: RequestContext, month: string, to: 'SOFT_LOCKED' | 'LOCKED' | 'OPEN', reason?: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('VALIDATION_FAILED', 'Month must be YYYY-MM');
    if (to !== 'OPEN' && month >= istToday().slice(0, 7)) throw unprocessable('MONTH_NOT_OVER', 'Only months that have ended can be locked');
    const { start, end } = monthBounds(month);
    return this.db.transaction().execute(async (tx) => {
      await tx.insertInto('accounting_periods').values({ period_start: start, period_end: end }).onConflict((oc) => oc.column('period_start').doNothing()).execute();
      const p = await tx.selectFrom('accounting_periods').selectAll().where('period_start', '=', start).forUpdate().executeTakeFirstOrThrow();
      const allowed: Record<string, string[]> = { SOFT_LOCKED: ['OPEN'], LOCKED: ['OPEN', 'SOFT_LOCKED'], OPEN: ['SOFT_LOCKED', 'LOCKED'] };
      if (!allowed[to]!.includes(p.status)) throw conflict('INVALID_STATE', `${month} is already ${p.status.toLowerCase().replace('_', '-')}`);
      if (to === 'SOFT_LOCKED' && !ctx.auth.permissions.has('period.soft_lock') && !ctx.auth.permissions.has('period.lock')) throw forbidden();
      if (to === 'OPEN' && p.status === 'SOFT_LOCKED' && !ctx.auth.permissions.has('period.unlock') && !ctx.auth.permissions.has('period.lock')) throw forbidden();
      const now = new Date();
      await tx
        .updateTable('accounting_periods')
        .set({
          status: to,
          ...(to === 'SOFT_LOCKED' ? { soft_locked_by: ctx.auth.userId, soft_locked_at: now } : {}),
          ...(to === 'LOCKED' ? { locked_by: ctx.auth.userId, locked_at: now } : {}),
          ...(to === 'OPEN' ? { unlocked_by: ctx.auth.userId, unlocked_at: now, unlock_reason: reason ?? null } : {}),
        })
        .where('period_start', '=', start)
        .execute();
      await this.audit.record(tx, ctx, { action: `period.${to === 'OPEN' ? 'reopened' : to === 'LOCKED' ? 'locked' : 'soft_locked'}`, entityType: 'accounting_period', entityId: month, oldValues: { status: p.status }, newValues: { status: to }, reason: reason ?? null });
      return { month, status: to };
    });
  }
}
