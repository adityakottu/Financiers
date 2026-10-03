import { Inject, Injectable } from '@nestjs/common';
import { DIFFERENCE_MANAGEMENT_THRESHOLD } from '@fin/contracts';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor, Tx } from '../db/db';
import { LedgerService, PostingLine } from '../ledger/ledger.service';

const NONE = '00000000-0000-0000-0000-000000000000';
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export interface CashFigures {
  accountId: string | null;
  opening: string;
  collected: string;
  reversed: string;
  deposited: string;
  expenses: string;
  other: string;
  expected: string;
  adjustments: string;
}

interface SettlementRow {
  id: string;
  status: string;
  expected_cash: string | null;
  counted_cash: string | null;
  difference: string | null;
  employee_user_id: string | null;
  branch_id: string;
  business_date: string;
  employee_id: string;
}

/**
 * Daily employee cash settlement and branch day close (doc 09 §2–§4, §7).
 *
 * Expected cash comes only from the employee's cash-in-hand ledger account (1120-{EMP}), so it
 * can't drift from the books. Counting freezes a snapshot; if the ledger moves afterwards the
 * day can't close until the cash is counted again. Differences need a reason, a resolution and a
 * second person's approval; approval posts the E11 adjustment.
 */
@Injectable()
export class SettlementsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Cash-in-hand movements for one employee on one date, from the journal. */
  async cashFigures(db: Executor, employeeId: string, date: string): Promise<CashFigures> {
    const acct = await db.selectFrom('accounts').select('id').where('employee_id', '=', employeeId).where('subtype', '=', 'EMPLOYEE_CASH').executeTakeFirst();
    const zero = '0.00';
    if (!acct) return { accountId: null, opening: zero, collected: zero, reversed: zero, deposited: zero, expenses: zero, other: zero, expected: zero, adjustments: zero };
    const r = await sql<{ opening: string; collected: string; reversed: string; deposited: string; expenses: string; net: string; adjustments: string }>`
      SELECT
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.value_date < ${date}::date), 0)::text opening,
        coalesce(sum(l.debit) FILTER (WHERE e.value_date = ${date}::date AND e.entry_type = 'PAYMENT'), 0)::text collected,
        coalesce(sum(l.credit) FILTER (WHERE e.value_date = ${date}::date AND e.entry_type = 'REVERSAL'), 0)::text reversed,
        coalesce(sum(l.credit - l.debit) FILTER (WHERE e.value_date = ${date}::date AND e.entry_type = 'DEPOSIT'), 0)::text deposited,
        coalesce(sum(l.credit - l.debit) FILTER (WHERE e.value_date = ${date}::date AND e.entry_type = 'EXPENSE'), 0)::text expenses,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.value_date = ${date}::date AND coalesce(e.source_type, '') <> 'settlement_difference'), 0)::text net,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE e.value_date = ${date}::date AND e.source_type = 'settlement_difference'), 0)::text adjustments
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ${acct.id} AND e.value_date <= ${date}::date`.execute(db);
    const x = r.rows[0]!;
    const m = (v: string) => Money.of(v);
    const other = m(x.net).minus(m(x.collected)).plus(m(x.reversed)).plus(m(x.deposited)).plus(m(x.expenses));
    return {
      accountId: acct.id,
      opening: m(x.opening).toString(),
      collected: m(x.collected).toString(),
      reversed: m(x.reversed).toString(),
      deposited: m(x.deposited).toString(),
      expenses: m(x.expenses).toString(),
      other: other.toString(),
      expected: m(x.opening).plus(m(x.net)).toString(),
      adjustments: m(x.adjustments).toString(),
    };
  }

  /** Non-cash collections of the employee that day, and how many are matched to the bank. */
  private async collections(db: Executor, employeeId: string, date: string) {
    const rows = await db
      .selectFrom('payments')
      .select(['method', sql<string>`sum(amount)::text`.as('total'), sql<string>`count(*)::text`.as('n'), sql<string>`count(*) FILTER (WHERE reconciliation_status = 'MATCHED')::text`.as('matched')])
      .where('collected_by', '=', employeeId)
      .where('business_date', '=', date)
      .where('status', '<>', 'REVERSED')
      .groupBy('method')
      .execute();
    const get = (m: string) => rows.find((r) => r.method === m);
    const item = (m: string) => ({ total: get(m)?.total ?? '0.00', count: Number(get(m)?.n ?? 0), matched: Number(get(m)?.matched ?? 0) });
    return { cash: item('CASH'), upi: item('UPI'), bank: item('BANK_TRANSFER'), cheque: item('CHEQUE'), total: Money.sum(rows.map((r) => Money.of(r.total))).toString() };
  }

  private async employee(db: Executor, auth: AuthContext, employeeId: string) {
    const e = await db.selectFrom('employees').select(['id', 'full_name', 'employee_code', 'branch_id', 'user_id', 'is_collector']).where('id', '=', employeeId).executeTakeFirst();
    if (!e) throw notFound('Employee');
    const self = auth.employeeId === employeeId;
    if (!self && !scope.canAccessBranch(auth, e.branch_id)) throw notFound('Employee');
    return e;
  }

  async get(auth: AuthContext, employeeId: string, date: string) {
    if (!isoDate.test(date)) throw badRequest('VALIDATION_FAILED', 'Date must be YYYY-MM-DD');
    const e = await this.employee(this.db, auth, employeeId);
    if (auth.employeeId !== employeeId && !auth.permissions.has('recon.view')) throw notFound('Employee');
    const [figures, collections, row, day] = await Promise.all([
      this.cashFigures(this.db, employeeId, date),
      this.collections(this.db, employeeId, date),
      this.db.selectFrom('employee_settlements').selectAll().where('employee_id', '=', employeeId).where('business_date', '=', date).executeTakeFirst(),
      this.db.selectFrom('business_days').select(['status']).where('branch_id', '=', e.branch_id).where('business_date', '=', date).executeTakeFirst(),
    ]);
    const differences = row
      ? await this.db
          .selectFrom('settlement_differences as d')
          .innerJoin('users as r', 'r.id', 'd.recorded_by')
          .leftJoin('users as a', 'a.id', 'd.decided_by')
          .selectAll('d')
          .select(['r.full_name as recorded_by_name', 'a.full_name as decided_by_name'])
          .where('d.settlement_id', '=', row.id)
          .orderBy('d.recorded_at')
          .execute()
      : [];
    const names = row ? await this.db.selectFrom('users').select(['id', 'full_name']).where('id', 'in', [row.declared_by, row.counted_by, row.approved_by].filter((x): x is string => !!x).concat(NONE)).execute() : [];
    const name = (id: string | null | undefined) => names.find((n) => n.id === id)?.full_name ?? null;
    const stale = !!row?.expected_cash && !Money.of(row.expected_cash).eq(Money.of(figures.expected));
    const self = e.user_id === auth.userId;
    return {
      employee: { id: e.id, name: e.full_name, code: e.employee_code, branchId: e.branch_id },
      date,
      dayClosed: day?.status === 'CLOSED',
      figures,
      collections,
      settlement: row ? { ...row, declared_by_name: name(row.declared_by), counted_by_name: name(row.counted_by), approved_by_name: name(row.approved_by) } : null,
      status: row?.status ?? 'OPEN',
      stale,
      differences,
      threshold: DIFFERENCE_MANAGEMENT_THRESHOLD,
      can: {
        declare: (self && auth.permissions.has('settlement.submit')) || auth.permissions.has('settlement.verify'),
        count: !self && auth.permissions.has('settlement.verify') && scope.canAccessBranch(auth, e.branch_id),
        approve: !self && auth.permissions.has('difference.approve'),
      },
    };
  }

  private async lockRow(tx: Tx, e: { id: string; branch_id: string; user_id: string | null }, date: string): Promise<SettlementRow> {
    await tx
      .insertInto('employee_settlements')
      .values({ employee_id: e.id, branch_id: e.branch_id, business_date: date, employee_user_id: e.user_id })
      .onConflict((oc) => oc.columns(['employee_id', 'business_date']).doNothing())
      .execute();
    return tx.selectFrom('employee_settlements').selectAll().where('employee_id', '=', e.id).where('business_date', '=', date).forUpdate().executeTakeFirstOrThrow();
  }

  private async assertDayOpen(db: Executor, branchId: string, date: string) {
    const d = await db.selectFrom('business_days').select('status').where('branch_id', '=', branchId).where('business_date', '=', date).executeTakeFirst();
    if (d?.status === 'CLOSED') throw conflict('DAY_CLOSED', 'This business day is closed');
    if (date > istToday()) throw unprocessable('FUTURE_DATE', 'Settlements are for today or earlier');
  }

  /** The employee (or their manager) states how much cash is in hand. Informational; counting decides. */
  async declare(ctx: RequestContext, employeeId: string, date: string, declaredCash: string, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.employee(tx, ctx.auth, employeeId);
      const self = ctx.auth.employeeId === employeeId;
      if (!self && !ctx.auth.permissions.has('settlement.verify')) throw forbidden();
      await this.assertDayOpen(tx, e.branch_id, date);
      const row = await this.lockRow(tx, e, date);
      if (!['OPEN', 'SUBMITTED'].includes(row.status)) throw conflict('INVALID_STATE', 'Cash has already been counted for this day');
      await tx
        .updateTable('employee_settlements')
        .set({ status: 'SUBMITTED', declared_cash: Money.of(declaredCash).toString(), declared_by: ctx.auth.userId, declared_at: new Date(), declaration_note: note ?? null, version: row.status === 'OPEN' ? 1 : sql`version + 1` })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(tx, ctx, { action: 'settlement.declared', entityType: 'employee_settlement', entityId: row.id, branchId: e.branch_id, newValues: { employee: e.full_name, date, declaredCash } });
      return { id: row.id, status: 'SUBMITTED' };
    });
  }

  /** Accountant / manager counts the cash. The difference against the ledger decides the status. */
  async count(ctx: RequestContext, employeeId: string, date: string, countedCash: string) {
    return this.db.transaction().execute(async (tx) => {
      const e = await this.employee(tx, ctx.auth, employeeId);
      if (!scope.canAccessBranch(ctx.auth, e.branch_id)) throw notFound('Employee');
      if (e.user_id === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'Someone else must count your cash');
      await this.assertDayOpen(tx, e.branch_id, date);
      const row = await this.lockRow(tx, e, date);
      const approved = await tx.selectFrom('settlement_differences').select('id').where('settlement_id', '=', row.id).where('status', '=', 'APPROVED').executeTakeFirst();
      if (approved) throw conflict('INVALID_STATE', 'A difference for this day is already approved; the count can no longer change');
      // A recount replaces earlier explanations that are still waiting.
      await tx.updateTable('settlement_differences').set({ status: 'REJECTED', decision_note: 'Superseded by a recount', decided_at: new Date() }).where('settlement_id', '=', row.id).where('status', '=', 'PENDING').execute();
      const figures = await this.cashFigures(tx, employeeId, date);
      const counted = Money.of(countedCash);
      const diff = Money.of(figures.expected).minus(counted);
      const status = diff.isZero() ? 'MATCHED' : diff.isPositive() ? 'SHORT' : 'EXCESS';
      await tx
        .updateTable('employee_settlements')
        .set({ status, expected_cash: figures.expected, snapshot: JSON.stringify(figures), counted_cash: counted.toString(), counted_by: ctx.auth.userId, counted_at: new Date(), difference: diff.toString(), approved_by: null, approved_at: null, version: sql`version + 1` })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(tx, ctx, {
        action: 'settlement.counted',
        entityType: 'employee_settlement',
        entityId: row.id,
        branchId: e.branch_id,
        oldValues: { status: row.status, countedCash: row.counted_cash },
        newValues: { employee: e.full_name, date, expected: figures.expected, counted: counted.toString(), difference: diff.toString(), status },
      });
      return { id: row.id, status, expected: figures.expected, counted: counted.toString(), difference: diff.toString() };
    });
  }

  async addDifference(ctx: RequestContext, settlementId: string, input: { amount: string; reasonCode: string; resolution: string; notes: string }) {
    return this.db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom('employee_settlements').selectAll().where('id', '=', settlementId).forUpdate().executeTakeFirst();
      if (!s || !scope.canAccessBranch(ctx.auth, s.branch_id)) throw notFound('Settlement');
      if (s.employee_user_id === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'Someone else must explain your difference');
      if (!['SHORT', 'EXCESS'].includes(s.status)) throw conflict('INVALID_STATE', 'Only a short or excess count needs explaining');
      await this.assertDayOpen(tx, s.branch_id, s.business_date);
      const direction = s.status;
      const shortRes = ['CARRY_FORWARD', 'RECOVER_FROM_EMPLOYEE', 'WRITE_OFF'];
      if ((direction === 'SHORT') !== shortRes.includes(input.resolution)) {
        throw badRequest('VALIDATION_FAILED', direction === 'SHORT' ? 'A shortage is carried forward, recovered or written off' : 'An excess goes to income or suspense', [{ path: 'resolution', message: 'Not valid for this difference' }]);
      }
      if ((input.resolution === 'CARRY_FORWARD') !== (input.reasonCode === 'PENDING_DEPOSIT')) {
        throw badRequest('VALIDATION_FAILED', 'Carry forward is only for cash deposited but not yet recorded', [{ path: 'resolution', message: 'Use with “Deposited but not yet recorded”' }]);
      }
      const open = await tx.selectFrom('settlement_differences').select('amount').where('settlement_id', '=', settlementId).where('status', '<>', 'REJECTED').execute();
      const explained = Money.sum(open.map((o) => Money.of(o.amount))).plus(Money.of(input.amount));
      const total = Money.of(s.difference!);
      const abs = total.isNegative() ? Money.zero().minus(total) : total;
      if (explained.gt(abs)) throw unprocessable('OVER_EXPLAINED', `Only ₹${abs.minus(explained.minus(Money.of(input.amount))).format({ symbol: false })} of the difference is left to explain`);
      const d = await tx
        .insertInto('settlement_differences')
        .values({ settlement_id: settlementId, amount: Money.of(input.amount).toString(), direction, reason_code: input.reasonCode, resolution: input.resolution, notes: input.notes, recorded_by: ctx.auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, { action: 'settlement.difference_recorded', entityType: 'employee_settlement', entityId: settlementId, branchId: s.branch_id, newValues: { differenceId: d.id, ...input, direction } });
      return { id: d.id, status: 'PENDING' };
    });
  }

  async decideDifference(ctx: RequestContext, id: string, approve: boolean, note?: string) {
    return this.db.transaction().execute(async (tx) => {
      const d = await tx.selectFrom('settlement_differences').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw notFound('Difference');
      const s = await tx.selectFrom('employee_settlements').selectAll().where('id', '=', d.settlement_id).forUpdate().executeTakeFirstOrThrow();
      if (!scope.canAccessBranch(ctx.auth, s.branch_id)) throw notFound('Difference');
      if (d.status !== 'PENDING') throw conflict('INVALID_STATE', 'Already decided');
      if (d.recorded_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You recorded this explanation, so someone else must decide it');
      if (s.employee_user_id === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You cannot approve a difference in your own cash');
      if (approve && Money.of(d.amount).gt(Money.of(DIFFERENCE_MANAGEMENT_THRESHOLD)) && !ctx.auth.permissions.has('difference.approve_high')) {
        throw forbidden('NEEDS_MANAGEMENT', `Differences above ₹${Money.of(DIFFERENCE_MANAGEMENT_THRESHOLD).format({ symbol: false })} need Management approval`);
      }
      await this.assertDayOpen(tx, s.branch_id, s.business_date);
      let journalId: string | null = null;
      if (approve && d.resolution !== 'CARRY_FORWARD') {
        const cash = (await tx.selectFrom('accounts').select('id').where('employee_id', '=', s.employee_id).where('subtype', '=', 'EMPLOYEE_CASH').executeTakeFirstOrThrow()).id;
        const amount = Money.of(d.amount);
        const emp = await tx.selectFrom('employees').select('full_name').where('id', '=', s.employee_id).executeTakeFirstOrThrow();
        const other = { RECOVER_FROM_EMPLOYEE: '1410', WRITE_OFF: '5700', CASH_EXCESS_INCOME: '4600', TO_SUSPENSE: '2250' }[d.resolution as 'WRITE_OFF']!;
        const lines: PostingLine[] =
          d.direction === 'SHORT'
            ? [
                { account: other, debit: amount, employeeId: s.employee_id, memo: d.notes.slice(0, 200) },
                { account: cash, credit: amount, employeeId: s.employee_id, memo: 'Cash short on count' },
              ]
            : [
                { account: cash, debit: amount, employeeId: s.employee_id, memo: 'Cash excess on count' },
                { account: other, credit: amount, employeeId: s.employee_id, memo: d.notes.slice(0, 200) },
              ];
        const entry = await this.ledger.post(tx, {
          entryType: 'ADJUSTMENT',
          valueDate: s.business_date,
          branchId: s.branch_id,
          sourceType: 'settlement_difference',
          sourceId: id,
          narration: `Cash ${d.direction === 'SHORT' ? 'shortage' : 'excess'} of ${emp.full_name} on ${s.business_date}: ${d.resolution.toLowerCase().replace(/_/g, ' ')}`,
          lines,
          createdBy: d.recorded_by,
          approvedBy: ctx.auth.userId,
        });
        journalId = entry.id;
      }
      await tx.updateTable('settlement_differences').set({ status: approve ? 'APPROVED' : 'REJECTED', decided_by: ctx.auth.userId, decided_at: new Date(), decision_note: note ?? null, journal_entry_id: journalId }).where('id', '=', id).execute();
      if (approve) {
        const approved = await tx.selectFrom('settlement_differences').select('amount').where('settlement_id', '=', s.id).where('status', '=', 'APPROVED').execute();
        const abs = Money.of(s.difference!).isNegative() ? Money.zero().minus(Money.of(s.difference!)) : Money.of(s.difference!);
        if (Money.sum(approved.map((a) => Money.of(a.amount))).eq(abs)) {
          await tx.updateTable('employee_settlements').set({ status: 'APPROVED', approved_by: ctx.auth.userId, approved_at: new Date() }).where('id', '=', s.id).execute();
        }
      }
      await this.audit.record(tx, ctx, { action: approve ? 'settlement.difference_approved' : 'settlement.difference_rejected', entityType: 'employee_settlement', entityId: s.id, branchId: s.branch_id, newValues: { differenceId: id, amount: d.amount, resolution: d.resolution, note: note ?? null } });
      return { id, status: approve ? 'APPROVED' : 'REJECTED' };
    });
  }

  /* ---------------------------- Branch day ---------------------------- */

  /** Employees who must settle for a branch/date: collectors, plus anyone whose cash account moved or holds cash. */
  async employeesFor(db: Executor, branchId: string, date: string) {
    const r = await sql<{ id: string; full_name: string; employee_code: string; user_id: string | null }>`
      SELECT DISTINCT e.id, e.full_name, e.employee_code, e.user_id FROM employees e
      LEFT JOIN accounts a ON a.employee_id = e.id AND a.subtype = 'EMPLOYEE_CASH'
      WHERE e.branch_id = ${branchId} AND (
        (e.is_collector AND e.status = 'ACTIVE')
        OR EXISTS (SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id = l.entry_id WHERE l.account_id = a.id AND j.value_date <= ${date}::date)
      )
      ORDER BY e.full_name`.execute(db);
    return r.rows;
  }

  async day(auth: AuthContext, branchId: string, date: string) {
    if (!scope.canAccessBranch(auth, branchId)) throw notFound('Branch');
    const [branch, day, employees] = await Promise.all([
      this.db.selectFrom('branches').select(['id', 'code', 'name']).where('id', '=', branchId).executeTakeFirstOrThrow(),
      this.db.selectFrom('business_days as d').leftJoin('users as c', 'c.id', 'd.closed_by').leftJoin('users as r', 'r.id', 'd.reopen_requested_by').leftJoin('users as o', 'o.id', 'd.reopened_by').selectAll('d').select(['c.full_name as closed_by_name', 'r.full_name as reopen_requested_by_name', 'o.full_name as reopened_by_name']).where('d.branch_id', '=', branchId).where('d.business_date', '=', date).executeTakeFirst(),
      this.employeesFor(this.db, branchId, date),
    ]);
    const rows = [];
    for (const e of employees) {
      const [figures, collections, s] = await Promise.all([
        this.cashFigures(this.db, e.id, date),
        this.collections(this.db, e.id, date),
        this.db.selectFrom('employee_settlements').select(['id', 'status', 'expected_cash', 'counted_cash', 'difference', 'declared_cash']).where('employee_id', '=', e.id).where('business_date', '=', date).executeTakeFirst(),
      ]);
      const stale = !!s?.expected_cash && !Money.of(s.expected_cash).eq(Money.of(figures.expected));
      const idle = Money.of(figures.expected).isZero() && Money.of(figures.opening).isZero() && Money.of(collections.total).isZero();
      rows.push({ employee: { id: e.id, name: e.full_name, code: e.employee_code }, figures, collections, settlement: s ?? null, status: idle && !s ? 'NOTHING_TO_SETTLE' : (s?.status ?? 'OPEN'), stale });
    }
    const blockers = rows
      .filter((r) => r.status !== 'NOTHING_TO_SETTLE' && (!['MATCHED', 'APPROVED'].includes(r.status) || r.stale))
      .map((r) => `${r.employee.name}: ${r.stale ? 'cash moved after counting — count again' : r.status === 'OPEN' || r.status === 'SUBMITTED' ? 'cash not counted' : 'difference not approved'}`);
    const pending = await this.pendingItems(branchId, date);
    return { branch, date, status: day?.status ?? 'OPEN', day: day ?? null, employees: rows, blockers, pending, canClose: blockers.length === 0 && day?.status !== 'CLOSED' && date <= istToday() };
  }

  /** Items still in transit: UPI / bank payments not yet seen on a statement, cheques not yet cleared. Informational. */
  async pendingItems(branchId: string, date: string) {
    const r = await this.db
      .selectFrom('payments as p')
      .innerJoin('loans as l', 'l.id', 'p.loan_id')
      .select(['p.id', 'p.payment_no', 'p.amount', 'p.method', 'p.reference_no', 'p.business_date', 'p.cheque_status', 'l.loan_no'])
      .where('p.branch_id', '=', branchId)
      .where('p.business_date', '<=', date)
      .where('p.status', '=', 'POSTED')
      .where('p.method', '<>', 'CASH')
      .where('p.reconciliation_status', '<>', 'MATCHED')
      .where((eb) => eb.or([eb('p.method', '<>', 'CHEQUE'), eb('p.cheque_status', 'in', ['RECEIVED', 'DEPOSITED'])]))
      .orderBy('p.business_date')
      .limit(200)
      .execute();
    return r.map((p) => ({ ...p, ageDays: Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${p.business_date}T00:00:00Z`).getTime()) / 86_400_000) }));
  }

  async closeDay(ctx: RequestContext, branchId: string, date: string) {
    if (!isoDate.test(date)) throw badRequest('VALIDATION_FAILED', 'Date must be YYYY-MM-DD');
    return this.db.transaction().execute(async (tx) => {
      if (!scope.canAccessBranch(ctx.auth, branchId)) throw notFound('Branch');
      if (date > istToday()) throw unprocessable('FUTURE_DATE', 'A day can be closed only once it has started');
      await tx.insertInto('business_days').values({ branch_id: branchId, business_date: date }).onConflict((oc) => oc.columns(['branch_id', 'business_date']).doNothing()).execute();
      const d = await tx.selectFrom('business_days').selectAll().where('branch_id', '=', branchId).where('business_date', '=', date).forUpdate().executeTakeFirstOrThrow();
      if (d.status === 'CLOSED') throw conflict('INVALID_STATE', 'This day is already closed');
      const board = await this.day(ctx.auth, branchId, date);
      if (board.blockers.length) throw unprocessable('NOT_RECONCILED', `The day can’t close yet: ${board.blockers.join('; ')}`, { blockers: board.blockers });
      const summary = {
        employees: board.employees.map((e) => ({ name: e.employee.name, status: e.status, expected: e.figures.expected, counted: e.settlement?.counted_cash ?? null, collected: e.collections.total })),
        collected: Money.sum(board.employees.map((e) => Money.of(e.collections.total))).toString(),
        inTransit: board.pending.length,
      };
      await tx.updateTable('business_days').set({ status: 'CLOSED', closed_by: ctx.auth.userId, closed_at: new Date(), summary: JSON.stringify(summary), reopen_requested_by: null, reopen_requested_at: null, reopen_reason: null, reopened_by: null, reopened_at: null }).where('id', '=', d.id).execute();
      await this.audit.record(tx, ctx, { action: 'day.closed', entityType: 'business_day', entityId: d.id, branchId, newValues: { date, ...summary } });
      return { status: 'CLOSED', summary };
    });
  }

  async requestReopen(ctx: RequestContext, branchId: string, date: string, reason: string) {
    return this.db.transaction().execute(async (tx) => {
      if (!scope.canAccessBranch(ctx.auth, branchId)) throw notFound('Branch');
      const d = await tx.selectFrom('business_days').selectAll().where('branch_id', '=', branchId).where('business_date', '=', date).forUpdate().executeTakeFirst();
      if (d?.status !== 'CLOSED') throw conflict('INVALID_STATE', 'Only a closed day can be reopened');
      if (d.reopen_requested_by) throw conflict('INVALID_STATE', 'A reopen is already waiting for approval');
      await tx.updateTable('business_days').set({ reopen_requested_by: ctx.auth.userId, reopen_requested_at: new Date(), reopen_reason: reason }).where('id', '=', d.id).execute();
      await this.audit.record(tx, ctx, { action: 'day.reopen_requested', entityType: 'business_day', entityId: d.id, branchId, newValues: { date }, reason });
      return { status: 'REOPEN_REQUESTED' };
    });
  }

  async approveReopen(ctx: RequestContext, branchId: string, date: string) {
    return this.db.transaction().execute(async (tx) => {
      if (!scope.canAccessBranch(ctx.auth, branchId)) throw notFound('Branch');
      const d = await tx.selectFrom('business_days').selectAll().where('branch_id', '=', branchId).where('business_date', '=', date).forUpdate().executeTakeFirst();
      if (d?.status !== 'CLOSED' || !d.reopen_requested_by) throw conflict('INVALID_STATE', 'There is no reopen request for this day');
      if (d.reopen_requested_by === ctx.auth.userId) throw forbidden('MAKER_CHECKER', 'You asked for this reopen, so someone else must approve it');
      await tx.updateTable('business_days').set({ status: 'OPEN', reopened_by: ctx.auth.userId, reopened_at: new Date() }).where('id', '=', d.id).execute();
      await this.audit.record(tx, ctx, { action: 'day.reopened', entityType: 'business_day', entityId: d.id, branchId, oldValues: { status: 'CLOSED' }, newValues: { status: 'OPEN', date, requestedBy: d.reopen_requested_by }, reason: d.reopen_reason });
      return { status: 'OPEN' };
    });
  }

  /**
   * Management board (doc 09 §8): employees × dates, each cell reconciled / pending / difference.
   * Pending reopen requests are listed so they are not missed.
   */
  async board(auth: AuthContext, from: string, to: string, branchId?: string) {
    const branches = branchId ? [branchId] : scope.branchFilter(auth);
    if (branchId && !scope.canAccessBranch(auth, branchId)) throw notFound('Branch');
    const days: string[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`) && days.length < 31; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const bs = await this.db.selectFrom('branches').select(['id', 'code', 'name']).$if(!!branches, (q) => q.where('id', 'in', branches!.length ? branches! : [NONE])).orderBy('code').execute();
    const settlements = await this.db
      .selectFrom('employee_settlements')
      .select(['employee_id', 'business_date', 'status', 'difference'])
      .where('business_date', '>=', from)
      .where('business_date', '<=', to)
      .$if(!!branches, (q) => q.where('branch_id', 'in', branches!.length ? branches! : [NONE]))
      .execute();
    const dayRows = await this.db
      .selectFrom('business_days')
      .select(['branch_id', 'business_date', 'status', 'reopen_requested_by'])
      .where('business_date', '>=', from)
      .where('business_date', '<=', to)
      .$if(!!branches, (q) => q.where('branch_id', 'in', branches!.length ? branches! : [NONE]))
      .execute();
    const activity = await sql<{ employee_id: string; d: string }>`
      SELECT DISTINCT a.employee_id, j.value_date::text d FROM journal_lines l
      JOIN journal_entries j ON j.id = l.entry_id
      JOIN accounts a ON a.id = l.account_id AND a.subtype = 'EMPLOYEE_CASH'
      WHERE j.value_date BETWEEN ${from}::date AND ${to}::date`.execute(this.db);
    const out = [];
    for (const b of bs) {
      const emps = await this.employeesFor(this.db, b.id, to);
      out.push({
        branch: b,
        days: days.map((d) => {
          const r = dayRows.find((x) => x.branch_id === b.id && x.business_date === d);
          return { date: d, status: r?.status ?? 'OPEN', reopenRequested: !!r?.reopen_requested_by && r.status === 'CLOSED' };
        }),
        employees: emps.map((e) => ({
          id: e.id,
          name: e.full_name,
          cells: days.map((d) => {
            const s = settlements.find((x) => x.employee_id === e.id && x.business_date === d);
            const active = activity.rows.some((a) => a.employee_id === e.id && a.d === d);
            const state = s ? (['MATCHED', 'APPROVED'].includes(s.status) ? 'RECONCILED' : ['SHORT', 'EXCESS'].includes(s.status) ? 'DIFFERENCE' : 'PENDING') : active ? 'PENDING' : 'NONE';
            return { date: d, state, status: s?.status ?? null, difference: s?.difference ?? null };
          }),
        })),
      });
    }
    return { from, to, days, branches: out };
  }
}
