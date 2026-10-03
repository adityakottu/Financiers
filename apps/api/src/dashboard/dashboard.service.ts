import { Inject, Injectable } from '@nestjs/common';
import { addDays } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { scope } from '../auth/access.service';
import type { AuthContext } from '../auth/context';
import { istToday } from '../common/dates';
import { forbidden, notFound } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { ReportsService } from '../reports/reports.service';

const NONE = '00000000-0000-0000-0000-000000000000';
const pctOf = (num: Money, den: Money) => (den.isPositive() ? Number(num.toDecimal().div(den.toDecimal()).times(100).toFixed(1)) : null);
/** `AND col = ANY(ids)` or nothing for all branches. */
const inIds = (ids: string[] | null, col: string) => (ids ? sql`AND ${sql.ref(col)} = ANY(${ids}::uuid[])` : sql``);

/**
 * Dashboards (doc 01 §Dashboards): company, branch, collector and employee performance. Every
 * figure is computed from the same tables as the reports; collection efficiency is the
 * collection-efficiency report itself, so a dashboard and its report can never disagree.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly reports: ReportsService,
  ) {}

  private period() {
    const today = istToday();
    return { today, monthStart: `${today.slice(0, 8)}01`, yearStart: `${today.slice(0, 4)}-01-01` };
  }

  private async portfolio(ids: string[] | null, employeeId?: string) {
    const emp = employeeId ? sql`AND l.assigned_collector_id = ${employeeId}` : sql``;
    const r = await sql<{
      active: number; principal_os: string; receivable: string; overdue: string; overdue_loans: number; par30: string; par90: string;
      b0: number; b1: number; b2: number; b3: number; b4: number; p0: string; p1: string; p2: string; p3: string; p4: string;
    }>`
      SELECT count(*)::int active, coalesce(sum(l.principal_outstanding), 0)::text principal_os,
        coalesce(sum(l.principal_outstanding + l.interest_outstanding + l.fees_outstanding + l.penalty_outstanding), 0)::text receivable,
        coalesce(sum(l.overdue_amount), 0)::text overdue, count(*) FILTER (WHERE l.dpd > 0)::int overdue_loans,
        coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd > 30), 0)::text par30, coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd > 90), 0)::text par90,
        count(*) FILTER (WHERE l.dpd = 0)::int b0, count(*) FILTER (WHERE l.dpd BETWEEN 1 AND 30)::int b1, count(*) FILTER (WHERE l.dpd BETWEEN 31 AND 60)::int b2,
        count(*) FILTER (WHERE l.dpd BETWEEN 61 AND 90)::int b3, count(*) FILTER (WHERE l.dpd > 90)::int b4,
        coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd = 0), 0)::text p0, coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd BETWEEN 1 AND 30), 0)::text p1,
        coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd BETWEEN 31 AND 60), 0)::text p2, coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd BETWEEN 61 AND 90), 0)::text p3,
        coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd > 90), 0)::text p4
      FROM loans l WHERE l.status = 'ACTIVE' ${inIds(ids, 'l.branch_id')} ${emp}`.execute(this.db);
    const x = r.rows[0]!;
    const pos = Money.of(x.principal_os);
    return {
      activeLoans: x.active,
      principalOutstanding: x.principal_os,
      receivable: x.receivable,
      overdueAmount: x.overdue,
      overdueLoans: x.overdue_loans,
      par30: x.par30,
      par30Pct: pctOf(Money.of(x.par30), pos),
      par90Pct: pctOf(Money.of(x.par90), pos),
      buckets: [
        { label: 'Current', loans: x.b0, principal: x.p0 },
        { label: '1–30', loans: x.b1, principal: x.p1 },
        { label: '31–60', loans: x.b2, principal: x.p2 },
        { label: '61–90', loans: x.b3, principal: x.p3 },
        { label: '90+', loans: x.b4, principal: x.p4 },
      ],
    };
  }

  /** Daily collections for the last `days` days (zero-filled), and today / month-to-date totals. */
  private async collections(ids: string[] | null, employeeId?: string, days = 30) {
    const { today, monthStart } = this.period();
    const from = addDays(today, -(days - 1));
    const emp = employeeId ? sql`AND p.collected_by = ${employeeId}` : sql``;
    const r = await sql<{ d: string; total: string; n: number }>`
      SELECT g.d::date::text d, coalesce(sum(p.amount), 0)::text total, count(p.id)::int n
      FROM generate_series(${from}::date, ${today}::date, interval '1 day') g(d)
      LEFT JOIN payments p ON p.business_date = g.d::date AND p.status <> 'REVERSED' ${inIds(ids, 'p.branch_id')} ${emp}
      GROUP BY g.d ORDER BY g.d`.execute(this.db);
    const m = await sql<{ total: string; n: number; cash: string; digital: string }>`
      SELECT coalesce(sum(p.amount), 0)::text total, count(*)::int n, coalesce(sum(p.amount) FILTER (WHERE p.method = 'CASH'), 0)::text cash,
        coalesce(sum(p.amount) FILTER (WHERE p.method <> 'CASH'), 0)::text digital
      FROM payments p WHERE p.status <> 'REVERSED' AND p.business_date BETWEEN ${monthStart}::date AND ${today}::date ${inIds(ids, 'p.branch_id')} ${emp}`.execute(this.db);
    const t = r.rows.find((x) => x.d === today);
    return { today: t?.total ?? '0.00', todayCount: t?.n ?? 0, mtd: m.rows[0]!.total, mtdCount: m.rows[0]!.n, mtdCash: m.rows[0]!.cash, mtdDigital: m.rows[0]!.digital, daily: r.rows.map((x) => ({ date: x.d, total: x.total })) };
  }

  private async disbursements(ids: string[] | null) {
    const { today } = this.period();
    const r = await sql<{ m: string; n: number; total: string }>`
      SELECT to_char(g.m, 'YYYY-MM') m, count(l.id)::int n, coalesce(sum(l.principal), 0)::text total
      FROM generate_series(date_trunc('month', ${today}::date) - interval '5 months', date_trunc('month', ${today}::date), interval '1 month') g(m)
      LEFT JOIN loans l ON date_trunc('month', l.disbursed_on) = g.m ${inIds(ids, 'l.branch_id')}
      GROUP BY g.m ORDER BY g.m`.execute(this.db);
    return r.rows.map((x) => ({ month: x.m, loans: x.n, amount: x.total }));
  }

  private async efficiency(auth: AuthContext, filters: { branchId?: string; employeeId?: string }) {
    const { today, monthStart } = this.period();
    const r = await this.reports.compute(auth, 'collection-efficiency', { from: monthStart, to: today, ...filters });
    return { rows: r.rows, demand: String(r.totals?.demand ?? '0.00'), collected: String(r.totals?.collected ?? '0.00'), pct: (r.totals?.efficiency as number | null) ?? null };
  }

  private async recovery(ids: string[] | null) {
    const { yearStart } = this.period();
    const r = await sql<{ open: number; requests: number; custody: number; wo_n: number; wo_amt: string }>`
      SELECT (SELECT count(*) FROM recovery_cases rc WHERE rc.status = 'OPEN' ${inIds(ids, 'rc.branch_id')})::int open,
        (SELECT count(*) FROM recovery_cases rc WHERE rc.requested_stage IS NOT NULL ${inIds(ids, 'rc.branch_id')})::int
          + (SELECT count(*) FROM asset_sales s JOIN loans l ON l.id = s.loan_id WHERE s.status = 'PENDING' ${inIds(ids, 'l.branch_id')})::int
          + (SELECT count(*) FROM loan_write_offs w JOIN loans l ON l.id = w.loan_id WHERE w.status = 'PENDING' ${inIds(ids, 'l.branch_id')})::int requests,
        (SELECT count(*) FROM assets a WHERE a.status = 'REPOSSESSED' ${inIds(ids, 'a.branch_id')})::int custody,
        (SELECT count(*) FROM loan_write_offs w JOIN loans l ON l.id = w.loan_id WHERE w.status = 'APPROVED' AND w.written_off_on >= ${yearStart}::date ${inIds(ids, 'l.branch_id')})::int wo_n,
        (SELECT coalesce(sum(w.amount), 0) FROM loan_write_offs w JOIN loans l ON l.id = w.loan_id WHERE w.status = 'APPROVED' AND w.written_off_on >= ${yearStart}::date ${inIds(ids, 'l.branch_id')})::text wo_amt`.execute(this.db);
    const x = r.rows[0]!;
    return { openCases: x.open, pendingApprovals: x.requests, assetsInCustody: x.custody, writtenOffYtd: x.wo_n, writtenOffYtdAmount: x.wo_amt };
  }

  /** Per collector: their book, this month's collections, efficiency, visits and promises. */
  private async collectors(auth: AuthContext, branchId: string) {
    const { today, monthStart } = this.period();
    const eff = await this.efficiency(auth, { branchId });
    const r = await sql<{ id: string; name: string; code: string; loans: number; overdue: string; overdue_loans: number; collected: string; payments: number; visits: number; kept: number; broken: number; open_cases: number }>`
      SELECT e.id, e.full_name name, e.employee_code code,
        (SELECT count(*) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE')::int loans,
        (SELECT coalesce(sum(l.overdue_amount), 0) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE')::text overdue,
        (SELECT count(*) FROM loans l WHERE l.assigned_collector_id = e.id AND l.status = 'ACTIVE' AND l.dpd > 0)::int overdue_loans,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.collected_by = e.id AND p.status <> 'REVERSED' AND p.business_date BETWEEN ${monthStart}::date AND ${today}::date)::text collected,
        (SELECT count(*) FROM payments p WHERE p.collected_by = e.id AND p.status <> 'REVERSED' AND p.business_date BETWEEN ${monthStart}::date AND ${today}::date)::int payments,
        (SELECT count(*) FROM collection_visits v WHERE v.employee_id = e.id AND (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthStart}::date AND ${today}::date)::int visits,
        (SELECT count(*) FROM promises_to_pay t WHERE t.employee_id = e.id AND t.status = 'KEPT' AND t.promised_date BETWEEN ${monthStart}::date AND ${today}::date)::int kept,
        (SELECT count(*) FROM promises_to_pay t WHERE t.employee_id = e.id AND t.status = 'BROKEN' AND t.promised_date BETWEEN ${monthStart}::date AND ${today}::date)::int broken,
        (SELECT count(*) FROM recovery_cases rc WHERE rc.owner_employee_id = e.id AND rc.status = 'OPEN')::int open_cases
      FROM employees e WHERE e.branch_id = ${branchId} AND e.status = 'ACTIVE' AND e.is_collector
      ORDER BY e.full_name`.execute(this.db);
    return r.rows.map((x) => {
      const e = eff.rows.find((row) => row.employee === x.name);
      return { ...x, demand: (e?.demand as string) ?? '0.00', efficiencyPct: (e?.efficiency as number | null) ?? null, promiseKeptPct: x.kept + x.broken ? Math.round((x.kept / (x.kept + x.broken)) * 100) : null };
    });
  }

  async company(auth: AuthContext) {
    const ids = scope.branchFilter(auth);
    const { today, monthStart } = this.period();
    const [portfolio, collections, disbursements, efficiency, recovery] = await Promise.all([this.portfolio(ids), this.collections(ids), this.disbursements(ids), this.efficiency(auth, {}), this.recovery(ids)]);
    const branches = await sql<{ id: string; code: string; name: string; active: number; principal_os: string; overdue: string; par30: string; mtd: string; closed_today: boolean | null }>`
      SELECT b.id, b.code, b.name,
        (SELECT count(*) FROM loans l WHERE l.branch_id = b.id AND l.status = 'ACTIVE')::int active,
        (SELECT coalesce(sum(l.principal_outstanding), 0) FROM loans l WHERE l.branch_id = b.id AND l.status = 'ACTIVE')::text principal_os,
        (SELECT coalesce(sum(l.overdue_amount), 0) FROM loans l WHERE l.branch_id = b.id AND l.status = 'ACTIVE')::text overdue,
        (SELECT coalesce(sum(l.principal_outstanding), 0) FROM loans l WHERE l.branch_id = b.id AND l.status = 'ACTIVE' AND l.dpd > 30)::text par30,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.branch_id = b.id AND p.status <> 'REVERSED' AND p.business_date BETWEEN ${monthStart}::date AND ${today}::date)::text mtd,
        (SELECT d.status = 'CLOSED' FROM business_days d WHERE d.branch_id = b.id AND d.business_date = ${addDays(today, -1)}::date) closed_today
      FROM branches b WHERE b.is_active ${inIds(ids, 'b.id')} ORDER BY b.code`.execute(this.db);
    const effRows = (await this.reports.compute(auth, 'collection-efficiency', { from: monthStart, to: today })).rows;
    return {
      asOf: today,
      portfolio,
      collections,
      disbursements,
      efficiency: { demand: efficiency.demand, collected: efficiency.collected, pct: efficiency.pct },
      recovery,
      branches: branches.rows.map((b) => {
        const mine = effRows.filter((r) => r.branch === b.code);
        const d = Money.sum(mine.map((r) => Money.of(String(r.demand))));
        const c = Money.sum(mine.map((r) => Money.of(String(r.collected))));
        return { id: b.id, code: b.code, name: b.name, activeLoans: b.active, principalOutstanding: b.principal_os, overdue: b.overdue, par30Pct: pctOf(Money.of(b.par30), Money.of(b.principal_os)), collectedMtd: b.mtd, efficiencyPct: pctOf(c, d), yesterdayClosed: b.closed_today === true };
      }),
    };
  }

  async branch(auth: AuthContext, branchId: string) {
    if (!scope.canAccessBranch(auth, branchId)) throw notFound('Branch');
    const b = await this.db.selectFrom('branches').select(['id', 'code', 'name']).where('id', '=', branchId).executeTakeFirst();
    if (!b) throw notFound('Branch');
    const { today } = this.period();
    const ids = [branchId];
    const [portfolio, collections, efficiency, recovery, collectors] = await Promise.all([this.portfolio(ids), this.collections(ids), this.efficiency(auth, { branchId }), this.recovery(ids), this.collectors(auth, branchId)]);
    const day = await this.db.selectFrom('business_days').select(['status', 'business_date']).where('branch_id', '=', branchId).where('business_date', '=', today).executeTakeFirst();
    const counts = await sql<{ pending: number }>`
      SELECT count(*)::int pending FROM employees e WHERE e.branch_id = ${branchId} AND e.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM employee_settlements s WHERE s.employee_id = e.id AND s.business_date = ${today}::date AND s.status IN ('MATCHED', 'APPROVED'))
        AND EXISTS (SELECT 1 FROM payments p WHERE p.collected_by = e.id AND p.business_date = ${today}::date AND p.method = 'CASH' AND p.status <> 'REVERSED')`.execute(this.db);
    const dueToday = await sql<{ n: number; amount: string }>`
      SELECT count(*)::int n, coalesce(sum(i.total_due - i.total_paid), 0)::text amount FROM loan_installments i JOIN loans l ON l.id = i.loan_id
      WHERE l.branch_id = ${branchId} AND l.status = 'ACTIVE' AND i.due_date = ${today}::date AND i.status NOT IN ('PAID', 'WAIVED', 'RESCHEDULED')`.execute(this.db);
    return {
      asOf: today,
      branch: b,
      portfolio,
      collections,
      efficiency: { demand: efficiency.demand, collected: efficiency.collected, pct: efficiency.pct },
      recovery,
      dueToday: dueToday.rows[0]!,
      today: { dayStatus: day?.status ?? 'OPEN', cashCountsPending: counts.rows[0]!.pending },
      collectors,
    };
  }

  async collector(auth: AuthContext, employeeId: string) {
    const e = await this.db.selectFrom('employees').select(['id', 'full_name', 'employee_code', 'branch_id']).where('id', '=', employeeId).executeTakeFirst();
    if (!e) throw notFound('Employee');
    const self = auth.employeeId === employeeId;
    if (!self) {
      if (auth.scope === 'ASSIGNED' || !scope.canAccessBranch(auth, e.branch_id)) throw notFound('Employee');
      if (!auth.permissions.has('dashboard.branch') && !auth.permissions.has('dashboard.company')) throw forbidden();
    }
    const { today, monthStart } = this.period();
    const [book, collections, efficiency] = await Promise.all([this.portfolio(null, employeeId), this.collections(null, employeeId, 14), this.efficiency(auth, { employeeId })]);
    const r = await sql<{ due_n: number; due_amt: string; visits: number; ptp_open: number; ptp_today: number; cases: number }>`
      SELECT (SELECT count(*) FROM loan_installments i JOIN loans l ON l.id = i.loan_id WHERE l.assigned_collector_id = ${employeeId} AND l.status = 'ACTIVE' AND i.due_date <= ${today}::date AND i.total_paid < i.total_due AND i.status NOT IN ('WAIVED', 'RESCHEDULED'))::int due_n,
        (SELECT coalesce(sum(i.total_due - i.total_paid), 0) FROM loan_installments i JOIN loans l ON l.id = i.loan_id WHERE l.assigned_collector_id = ${employeeId} AND l.status = 'ACTIVE' AND i.due_date <= ${today}::date AND i.status NOT IN ('WAIVED', 'RESCHEDULED'))::text due_amt,
        (SELECT count(*) FROM collection_visits v WHERE v.employee_id = ${employeeId} AND (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${monthStart}::date AND ${today}::date)::int visits,
        (SELECT count(*) FROM promises_to_pay t WHERE t.employee_id = ${employeeId} AND t.status = 'OPEN')::int ptp_open,
        (SELECT count(*) FROM promises_to_pay t WHERE t.employee_id = ${employeeId} AND t.status = 'OPEN' AND t.promised_date <= ${today}::date)::int ptp_today,
        (SELECT count(*) FROM recovery_cases rc WHERE rc.owner_employee_id = ${employeeId} AND rc.status = 'OPEN')::int cases`.execute(this.db);
    const x = r.rows[0]!;
    return {
      asOf: today,
      employee: { id: e.id, name: e.full_name, code: e.employee_code },
      book,
      collections,
      efficiency: { demand: efficiency.demand, collected: efficiency.collected, pct: efficiency.pct },
      toCollect: { installments: x.due_n, amount: x.due_amt },
      visitsMtd: x.visits,
      promises: { open: x.ptp_open, dueNow: x.ptp_today },
      recoveryCases: x.cases,
    };
  }
}
