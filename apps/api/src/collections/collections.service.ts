import { Inject, Injectable } from '@nestjs/common';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import type { AuthContext, RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { forbidden, notFound, unprocessable } from '../common/errors';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { LoansService } from '../lending/loans.service';

const NONE = '00000000-0000-0000-0000-000000000000';

/** Collector assignment, the collector's day sheet, visits and promises to pay (doc 01 §10). */
@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly loans: LoansService,
    private readonly audit: AuditService,
  ) {}

  /** Collectors the caller can assign loans to (or see the work of). */
  async collectors(auth: AuthContext, branchId?: string) {
    const today = istToday();
    let q = this.db
      .selectFrom('employees as e')
      .innerJoin('branches as b', 'b.id', 'e.branch_id')
      .select([
        'e.id', 'e.full_name', 'e.employee_code', 'e.mobile', 'e.branch_id', 'b.code as branch_code',
        (eb) => eb.selectFrom('loans').select(sql<string>`count(*)::text`.as('n')).whereRef('assigned_collector_id', '=', 'e.id').where('status', '=', 'ACTIVE').as('active_loans'),
        (eb) =>
          eb
            .selectFrom('payments')
            .select(sql<string>`coalesce(sum(amount), 0)::text`.as('s'))
            .whereRef('collected_by', '=', 'e.id')
            .where('business_date', '=', today)
            .where('status', '<>', 'REVERSED')
            .as('collected_today'),
      ])
      .where('e.is_collector', '=', true)
      .where('e.status', '=', 'ACTIVE')
      .orderBy('b.code')
      .orderBy('e.full_name');
    const branches = scope.branchFilter(auth);
    if (branches) q = q.where('e.branch_id', 'in', branches.length ? branches : [NONE]);
    if (branchId) q = q.where('e.branch_id', '=', branchId);
    return q.execute();
  }

  async assign(ctx: RequestContext, input: { loanIds: string[]; employeeId: string | null; reason?: string }) {
    return this.db.transaction().execute(async (tx) => {
      const employee = input.employeeId
        ? await tx.selectFrom('employees').select(['id', 'full_name', 'branch_id', 'is_collector', 'status']).where('id', '=', input.employeeId).executeTakeFirst()
        : null;
      if (input.employeeId) {
        if (!employee || !scope.canAccessBranch(ctx.auth, employee.branch_id)) throw notFound('Employee');
        if (!employee.is_collector || employee.status !== 'ACTIVE') throw unprocessable('NOT_A_COLLECTOR', `${employee.full_name} is not an active collector`);
      }
      const loans = await this.loans
        .scoped(tx, ctx.auth)
        .select(['l.id', 'l.loan_no', 'l.status', 'l.branch_id', 'l.customer_id', 'l.assigned_collector_id'])
        .where('l.id', 'in', input.loanIds)
        .forUpdate('l')
        .execute();
      if (loans.length !== new Set(input.loanIds).size) throw notFound('Loan');
      const wrong = loans.find((l) => !['ACTIVE', 'APPROVED'].includes(l.status));
      if (wrong) throw unprocessable('LOAN_NOT_ACTIVE', `${wrong.loan_no} is ${wrong.status.toLowerCase().replace('_', ' ')}; only approved or active loans are assigned`);
      if (employee) {
        const other = loans.find((l) => l.branch_id !== employee.branch_id);
        if (other) throw unprocessable('BRANCH_MISMATCH', `${other.loan_no} belongs to another branch than ${employee.full_name}`);
      }
      let changed = 0;
      for (const l of loans) {
        if (l.assigned_collector_id === (input.employeeId ?? null)) continue;
        await tx.updateTable('collection_assignments').set({ to_at: new Date() }).where('loan_id', '=', l.id).where('to_at', 'is', null).execute();
        if (input.employeeId) {
          await tx.insertInto('collection_assignments').values({ loan_id: l.id, employee_id: input.employeeId, assigned_by: ctx.auth.userId, reason: input.reason ?? null }).execute();
        }
        await tx.updateTable('loans').set({ assigned_collector_id: input.employeeId, updated_at: new Date() }).where('id', '=', l.id).execute();
        await this.loans.event(tx, l.customer_id, l.id, ctx.auth.userId, 'COLLECTOR_ASSIGNED', employee ? `Loan ${l.loan_no} assigned to ${employee.full_name}` : `Collector removed from loan ${l.loan_no}`);
        changed++;
      }
      await this.audit.record(tx, ctx, {
        action: 'collection.assigned',
        entityType: 'employee',
        entityId: input.employeeId,
        newValues: { loans: loans.map((l) => l.loan_no), employee: employee?.full_name ?? null, reason: input.reason ?? null, changed },
      });
      return { changed };
    });
  }

  /** The collector's day: who to visit, in what order, and what they have collected so far. */
  async myDay(auth: AuthContext) {
    if (!auth.employeeId) throw forbidden('NOT_AN_EMPLOYEE', 'Your sign-in is not linked to an employee record');
    const today = istToday();
    const week = new Date(`${today}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() + 7);
    const horizon = week.toISOString().slice(0, 10);
    const rows = await sql<{
      id: string; loan_no: string; category: string; dpd: number; overdue_amount: string; next_due_date: string | null; next_due_amount: string | null;
      balance_payable: string; advance_balance: string; installment_amount: string; frequency: string;
      customer_id: string; customer_name: string; customer_no: string; mobile: string; village_town: string | null; address_line1: string | null;
      due_today: string; asset_label: string | null; paid_today: string; last_visit_outcome: string | null; last_visit_at: Date | null;
      ptp_amount: string | null; ptp_date: string | null;
    }>`
      SELECT l.id, l.loan_no, l.category, l.dpd, l.overdue_amount::text, l.next_due_date::text, l.next_due_amount::text,
             l.balance_payable::text, l.advance_balance::text, l.installment_amount::text, l.frequency,
             c.id customer_id, c.full_name customer_name, c.customer_no, c.mobile, c.village_town, c.address_line1,
             coalesce((SELECT sum(i.total_due - i.total_paid) FROM loan_installments i
                        WHERE i.loan_id = l.id AND i.due_date = ${today}::date AND i.status <> 'RESCHEDULED'), 0)::text due_today,
             (SELECT coalesce(a.registration_no, nullif(concat_ws(' ', a.make, a.model), ''), a.description) FROM assets a WHERE a.loan_id = l.id LIMIT 1) asset_label,
             coalesce((SELECT sum(p.amount) FROM payments p WHERE p.loan_id = l.id AND p.business_date = ${today}::date AND p.status <> 'REVERSED'), 0)::text paid_today,
             v.outcome last_visit_outcome, v.visited_at last_visit_at,
             ptp.promised_amount::text ptp_amount, ptp.promised_date::text ptp_date
      FROM loans l
      JOIN customers c ON c.id = l.customer_id
      LEFT JOIN LATERAL (SELECT outcome, visited_at FROM collection_visits WHERE loan_id = l.id ORDER BY visited_at DESC LIMIT 1) v ON true
      LEFT JOIN LATERAL (SELECT promised_amount, promised_date FROM promises_to_pay WHERE loan_id = l.id AND status = 'OPEN' ORDER BY promised_date LIMIT 1) ptp ON true
      WHERE l.assigned_collector_id = ${auth.employeeId} AND l.status = 'ACTIVE'
      ORDER BY l.dpd DESC, l.next_due_date NULLS LAST, c.full_name`.execute(this.db);

    const cards = rows.rows.map((r) => {
      const overdue = Money.of(r.overdue_amount);
      const dueToday = Money.of(r.due_today);
      const toCollect = overdue.plus(dueToday);
      const group = overdue.isPositive() ? 'OVERDUE' : dueToday.isPositive() ? 'DUE_TODAY' : r.next_due_date && r.next_due_date <= horizon ? 'UPCOMING' : 'LATER';
      return { ...r, to_collect: toCollect.toString(), group, collected: Money.of(r.paid_today).isPositive() };
    });
    const payments = await this.db
      .selectFrom('payments')
      .select(['method', sql<string>`sum(amount)::text`.as('total'), sql<string>`count(*)::text`.as('n')])
      .where('collected_by', '=', auth.employeeId)
      .where('business_date', '=', today)
      .where('status', '<>', 'REVERSED')
      .groupBy('method')
      .execute();
    const byMethod = Object.fromEntries(['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'].map((m) => [m, payments.find((p) => p.method === m)?.total ?? '0.00']));
    const expected = Money.sum(cards.filter((c) => c.group === 'OVERDUE' || c.group === 'DUE_TODAY').map((c) => Money.of(c.to_collect)));
    const collected = Money.sum(payments.map((p) => Money.of(p.total)));
    const cash = await this.db
      .selectFrom('accounts as a')
      .leftJoin('journal_lines as jl', 'jl.account_id', 'a.id')
      .select(sql<string>`coalesce(sum(jl.debit) - sum(jl.credit), 0)::text`.as('bal'))
      .where('a.employee_id', '=', auth.employeeId)
      .where('a.subtype', '=', 'EMPLOYEE_CASH')
      .executeTakeFirst();
    const visits = await this.db
      .selectFrom('collection_visits')
      .select(sql<string>`count(*)::text`.as('n'))
      .where('employee_id', '=', auth.employeeId)
      .where('visited_at', '>=', new Date(`${today}T00:00:00+05:30`))
      .executeTakeFirstOrThrow();
    return {
      date: today,
      totals: {
        expected: expected.toString(),
        collected: collected.toString(),
        byMethod,
        payments: payments.reduce((n, p) => n + Number(p.n), 0),
        visits: Number(visits.n),
        cashInHand: Money.of(cash?.bal ?? '0').toString(),
        customers: cards.length,
        pending: cards.filter((c) => (c.group === 'OVERDUE' || c.group === 'DUE_TODAY') && !c.collected).length,
      },
      cards,
    };
  }

  /** Branch / company view: each collector's day, plus loans nobody is assigned to. */
  async summary(auth: AuthContext, date: string, branchId?: string) {
    const branches = scope.branchFilter(auth);
    const filter = sql`${branches ? sql`AND e.branch_id = ANY(${branches.length ? branches : [NONE]}::uuid[])` : sql``} ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}`;
    const rows = await sql<{
      id: string; full_name: string; employee_code: string; branch_code: string; loans: string; overdue_loans: string; overdue_amount: string; due_today: string;
      cash: string; upi: string; bank: string; cheque: string; payments: string; visits: string; promises: string;
    }>`
      SELECT e.id, e.full_name, e.employee_code, b.code branch_code,
        (SELECT count(*) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE')::text loans,
        (SELECT count(*) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE' AND l.dpd > 0)::text overdue_loans,
        (SELECT coalesce(sum(l.overdue_amount), 0) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE')::text overdue_amount,
        (SELECT coalesce(sum(i.total_due - i.total_paid), 0) FROM loan_installments i JOIN loans l ON l.id = i.loan_id
           WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE' AND i.due_date = ${date}::date AND i.status <> 'RESCHEDULED')::text due_today,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'CASH'), 0)::text cash,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'UPI'), 0)::text upi,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'BANK_TRANSFER'), 0)::text bank,
        coalesce(sum(p.amount) FILTER (WHERE p.method = 'CHEQUE'), 0)::text cheque,
        count(p.id)::text payments,
        (SELECT count(*) FROM collection_visits v WHERE v.employee_id = e.id AND (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date)::text visits,
        (SELECT count(*) FROM promises_to_pay t WHERE t.employee_id = e.id AND t.status = 'OPEN')::text promises
      FROM employees e
      JOIN branches b ON b.id = e.branch_id
      LEFT JOIN payments p ON p.collected_by = e.id AND p.business_date = ${date}::date AND p.status <> 'REVERSED'
      WHERE e.is_collector AND e.status = 'ACTIVE' ${filter}
      GROUP BY e.id, b.code
      ORDER BY b.code, e.full_name`.execute(this.db);
    const unassigned = await this.loans
      .scoped(this.db, auth)
      .select([sql<string>`count(*)::text`.as('n'), sql<string>`coalesce(sum(l.overdue_amount), 0)::text`.as('overdue')])
      .where('l.status', '=', 'ACTIVE')
      .where('l.assigned_collector_id', 'is', null)
      .$if(!!branchId, (q) => q.where('l.branch_id', '=', branchId!))
      .executeTakeFirstOrThrow();
    const counter = await this.loans
      .scoped(this.db, auth)
      .innerJoin('payments as p', 'p.loan_id', 'l.id')
      .select(['p.method', sql<string>`sum(p.amount)::text`.as('total')])
      .where('p.business_date', '=', date)
      .where('p.status', '<>', 'REVERSED')
      .where('p.collected_by', 'is', null)
      .$if(!!branchId, (q) => q.where('l.branch_id', '=', branchId!))
      .groupBy('p.method')
      .execute();
    const total = Money.sum(rows.rows.flatMap((r) => [r.cash, r.upi, r.bank, r.cheque].map((x) => Money.of(x))).concat(counter.map((c) => Money.of(c.total))));
    return { date, collectors: rows.rows, unassigned: { loans: Number(unassigned.n), overdue: unassigned.overdue }, other: counter, total: total.toString() };
  }

  async recordVisit(ctx: RequestContext, loanId: string, input: { outcome: string; notes?: string; promisedAmount?: string; promisedDate?: string; lat?: number; lng?: number }) {
    return this.db.transaction().execute(async (tx) => {
      const loan = await this.loans.scoped(tx, ctx.auth).select(['l.id', 'l.loan_no', 'l.status', 'l.customer_id', 'l.branch_id']).where('l.id', '=', loanId).executeTakeFirst();
      if (!loan) throw notFound('Loan');
      if (loan.status !== 'ACTIVE') throw unprocessable('LOAN_NOT_ACTIVE', 'Visits are recorded on active loans');
      let promiseId: string | null = null;
      if (input.outcome === 'PROMISED') {
        if (input.promisedDate! < istToday()) throw unprocessable('PAST_DATE', 'The promised date cannot be in the past');
        await tx.updateTable('promises_to_pay').set({ status: 'CANCELLED', resolved_at: new Date() }).where('loan_id', '=', loanId).where('status', '=', 'OPEN').execute();
        promiseId = (
          await tx
            .insertInto('promises_to_pay')
            .values({ loan_id: loanId, customer_id: loan.customer_id, employee_id: ctx.auth.employeeId, created_by: ctx.auth.userId, promised_amount: input.promisedAmount!, promised_date: input.promisedDate! })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      }
      const v = await tx
        .insertInto('collection_visits')
        .values({
          loan_id: loanId,
          customer_id: loan.customer_id,
          employee_id: ctx.auth.employeeId,
          created_by: ctx.auth.userId,
          outcome: input.outcome,
          notes: input.notes ?? null,
          lat: input.lat !== undefined ? String(input.lat) : null,
          lng: input.lng !== undefined ? String(input.lng) : null,
          promise_id: promiseId,
        })
        .returning(['id', 'visited_at'])
        .executeTakeFirstOrThrow();
      const label = { PAID: 'paid', PARTIAL: 'paid part', PROMISED: `promised ₹${Money.of(input.promisedAmount ?? '0').format({ symbol: false })} by ${input.promisedDate}`, NOT_AVAILABLE: 'not available', REFUSED: 'refused to pay', SHIFTED: 'shifted / not at address', OTHER: 'other' }[input.outcome];
      await this.loans.event(tx, loan.customer_id, loanId, ctx.auth.userId, 'VISIT', `Visit on ${loan.loan_no}: ${label}${input.notes ? ` — ${input.notes}` : ''}`);
      return { id: v.id, visitedAt: v.visited_at, promiseId };
    });
  }

  async loanActivity(auth: AuthContext, loanId: string) {
    const loan = await this.loans.scoped(this.db, auth).select(['l.id', 'l.assigned_collector_id']).where('l.id', '=', loanId).executeTakeFirst();
    if (!loan) throw notFound('Loan');
    const [visits, promises, assignments] = await Promise.all([
      this.db
        .selectFrom('collection_visits as v')
        .leftJoin('users as u', 'u.id', 'v.created_by')
        .select(['v.id', 'v.visited_at', 'v.outcome', 'v.notes', 'u.full_name as by'])
        .where('v.loan_id', '=', loanId)
        .orderBy('v.visited_at', 'desc')
        .limit(50)
        .execute(),
      this.db.selectFrom('promises_to_pay').selectAll().where('loan_id', '=', loanId).orderBy('created_at', 'desc').limit(20).execute(),
      this.db
        .selectFrom('collection_assignments as a')
        .innerJoin('employees as e', 'e.id', 'a.employee_id')
        .leftJoin('users as u', 'u.id', 'a.assigned_by')
        .select(['a.id', 'a.from_at', 'a.to_at', 'a.reason', 'e.full_name as employee', 'u.full_name as by'])
        .where('a.loan_id', '=', loanId)
        .orderBy('a.from_at', 'desc')
        .execute(),
    ]);
    return { visits, promises, assignments };
  }

  /** Nightly: promises whose date has passed become KEPT / PARTIAL / BROKEN by what was actually paid. */
  async resolvePromises(db: Executor, date: string) {
    const r = await sql`
      WITH due AS (
        SELECT t.id,
          coalesce((SELECT sum(p.amount) FROM payments p WHERE p.loan_id = t.loan_id AND p.status <> 'REVERSED'
                     AND p.received_at >= t.created_at AND p.value_date <= t.promised_date), 0) AS paid
        FROM promises_to_pay t WHERE t.status = 'OPEN' AND t.promised_date < ${date}::date
      )
      UPDATE promises_to_pay t SET
        paid_amount = due.paid,
        status = CASE WHEN due.paid >= t.promised_amount THEN 'KEPT' WHEN due.paid > 0 THEN 'PARTIAL' ELSE 'BROKEN' END,
        resolved_at = now()
      FROM due WHERE due.id = t.id`.execute(db);
    return Number(r.numAffectedRows ?? 0);
  }
}
