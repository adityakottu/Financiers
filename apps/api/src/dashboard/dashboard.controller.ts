import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { sql } from 'kysely';
import { scope } from '../auth/access.service';
import { Authenticated, Ctx, RequestContext, Require } from '../auth/context';
import { DashboardService } from './dashboard.service';
import { DB_TOKEN, Db } from '../db/db';
import { istToday } from '../common/dates';

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * Only figures that exist today. Collection and reconciliation KPIs are added by the phases
 * that create that data — never shown as fake numbers.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly dashboards: DashboardService,
  ) {}

  @Require('dashboard.company')
  @Get('company')
  company(@Ctx() ctx: RequestContext) {
    return this.dashboards.company(ctx.auth);
  }

  @Require('dashboard.branch')
  @Get('branch/:id')
  branch(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dashboards.branch(ctx.auth, id);
  }

  @Require('dashboard.collector')
  @Get('collector/:employeeId')
  collector(@Ctx() ctx: RequestContext, @Param('employeeId', ParseUUIDPipe) id: string) {
    return this.dashboards.collector(ctx.auth, id);
  }

  @Authenticated()
  @Get('summary')
  async summary(@Ctx() ctx: RequestContext) {
    const branches = scope.branchFilter(ctx.auth);
    const ids = branches ? (branches.length ? branches : [NONE]) : null;
    const canSeeCustomers = ctx.auth.permissions.has('customer.view');

    const customers = canSeeCustomers
      ? await this.db
          .selectFrom('customers')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'ACTIVE')`.as('active'),
            sql<string>`count(*)`.as('total'),
            sql<string>`count(*) FILTER (WHERE kyc_status IN ('PENDING','PARTIAL'))`.as('kyc_pending'),
            sql<string>`count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`.as(
              'new_today',
            ),
          ])
          .$if(ids !== null, (q) => q.where('branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;

    const byBranch = canSeeCustomers
      ? await this.db
          .selectFrom('branches as b')
          .leftJoin('customers as c', (j) => j.onRef('c.branch_id', '=', 'b.id').on('c.status', '=', 'ACTIVE'))
          .select(['b.id', 'b.code', 'b.name', sql<string>`count(c.id)`.as('active_customers')])
          .$if(ids !== null, (q) => q.where('b.id', 'in', ids!))
          .groupBy(['b.id', 'b.code', 'b.name'])
          .orderBy('b.code')
          .execute()
      : [];

    const staff = ctx.auth.permissions.has('employee.view')
      ? await this.db
          .selectFrom('employees')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'ACTIVE')`.as('active'),
            sql<string>`count(*) FILTER (WHERE status = 'ACTIVE' AND is_collector)`.as('collectors'),
          ])
          .$if(ids !== null, (q) => q.where('branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;

    const today = istToday();
    const loans = ctx.auth.permissions.has('loan.view') && ctx.auth.scope !== 'ASSIGNED'
      ? await this.db
          .selectFrom('loans')
          .select([
            sql<string>`count(*) FILTER (WHERE status = 'ACTIVE')`.as('active'),
            sql<string>`count(*) FILTER (WHERE status = 'CLOSED')`.as('closed'),
            sql<string>`count(*) FILTER (WHERE status IN ('DRAFT','PENDING_APPROVAL','APPROVED'))`.as('pipeline'),
            sql<string>`count(*) FILTER (WHERE status = 'PENDING_APPROVAL')`.as('awaiting_approval'),
            sql<string>`count(*) FILTER (WHERE status = 'APPROVED')`.as('awaiting_disbursal'),
            sql<string>`coalesce(sum(principal_outstanding) FILTER (WHERE status = 'ACTIVE'), 0)::text`.as('principal_outstanding'),
            sql<string>`coalesce(sum(interest_outstanding) FILTER (WHERE status = 'ACTIVE'), 0)::text`.as('interest_outstanding'),
            sql<string>`coalesce(sum(balance_payable) FILTER (WHERE status = 'ACTIVE'), 0)::text`.as('receivable'),
            sql<string>`coalesce(sum(overdue_amount) FILTER (WHERE status = 'ACTIVE'), 0)::text`.as('overdue_amount'),
            sql<string>`count(*) FILTER (WHERE status = 'ACTIVE' AND dpd > 0)`.as('overdue_loans'),
            sql<string>`coalesce(sum(principal) FILTER (WHERE disbursed_on IS NOT NULL), 0)::text`.as('total_disbursed'),
            sql<string>`count(*) FILTER (WHERE disbursed_on = ${today}::date)`.as('disbursed_today_count'),
            sql<string>`coalesce(sum(principal) FILTER (WHERE disbursed_on = ${today}::date), 0)::text`.as('disbursed_today'),
          ])
          .$if(ids !== null, (q) => q.where('branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;
    const dueToday = loans
      ? await this.db
          .selectFrom('loan_installments as i')
          .innerJoin('loans as l', 'l.id', 'i.loan_id')
          .select([sql<string>`count(*)`.as('n'), sql<string>`coalesce(sum(i.total_due - i.total_paid), 0)::text`.as('amount')])
          .where('l.status', '=', 'ACTIVE')
          .where('i.due_date', '=', today)
          .where('i.status', 'not in', ['PAID', 'WAIVED', 'RESCHEDULED'])
          .$if(ids !== null, (q) => q.where('l.branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;
    const byCategory = loans
      ? await this.db
          .selectFrom('loans')
          .select(['category', sql<string>`count(*)`.as('n'), sql<string>`coalesce(sum(principal_outstanding), 0)::text`.as('outstanding')])
          .where('status', '=', 'ACTIVE')
          .$if(ids !== null, (q) => q.where('branch_id', 'in', ids!))
          .groupBy('category')
          .orderBy('category')
          .execute()
      : [];

    const collections = ctx.auth.permissions.has('payment.view') && ctx.auth.scope !== 'ASSIGNED'
      ? await this.db
          .selectFrom('payments')
          .select([
            sql<string>`coalesce(sum(amount), 0)::text`.as('total'),
            sql<string>`count(*)`.as('n'),
            sql<string>`coalesce(sum(amount) FILTER (WHERE method = 'CASH'), 0)::text`.as('cash'),
            sql<string>`coalesce(sum(amount) FILTER (WHERE method = 'UPI'), 0)::text`.as('upi'),
            sql<string>`coalesce(sum(amount) FILTER (WHERE method = 'BANK_TRANSFER'), 0)::text`.as('bank'),
            sql<string>`coalesce(sum(amount) FILTER (WHERE method = 'CHEQUE'), 0)::text`.as('cheque'),
          ])
          .where('business_date', '=', today)
          .where('status', '<>', 'REVERSED')
          .$if(ids !== null, (q) => q.where('branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;
    const pendingReversals = collections
      ? await this.db
          .selectFrom('payment_reversals as r')
          .innerJoin('payments as p', 'p.id', 'r.payment_id')
          .select(sql<string>`count(*)`.as('n'))
          .where('r.status', '=', 'REQUESTED')
          .$if(ids !== null, (q) => q.where('p.branch_id', 'in', ids!))
          .executeTakeFirstOrThrow()
      : null;

    return {
      collections: collections && {
        today: collections.total,
        count: Number(collections.n),
        byMethod: { CASH: collections.cash, UPI: collections.upi, BANK_TRANSFER: collections.bank, CHEQUE: collections.cheque },
        pendingReversals: Number(pendingReversals!.n),
      },
      loans: loans && {
        active: Number(loans.active),
        closed: Number(loans.closed),
        pipeline: Number(loans.pipeline),
        awaitingApproval: Number(loans.awaiting_approval),
        awaitingDisbursal: Number(loans.awaiting_disbursal),
        principalOutstanding: loans.principal_outstanding,
        interestOutstanding: loans.interest_outstanding,
        receivable: loans.receivable,
        overdueAmount: loans.overdue_amount,
        overdueLoans: Number(loans.overdue_loans),
        totalDisbursed: loans.total_disbursed,
        disbursedToday: loans.disbursed_today,
        disbursedTodayCount: Number(loans.disbursed_today_count),
        dueTodayCount: Number(dueToday!.n),
        dueTodayAmount: dueToday!.amount,
        byCategory: byCategory.map((c) => ({ category: c.category, count: Number(c.n), outstanding: c.outstanding })),
      },
      customers: customers && {
        active: Number(customers.active),
        total: Number(customers.total),
        kycPending: Number(customers.kyc_pending),
        newToday: Number(customers.new_today),
      },
      staff: staff && { active: Number(staff.active), collectors: Number(staff.collectors) },
      branches: byBranch.map((b) => ({ id: b.id, code: b.code, name: b.name, activeCustomers: Number(b.active_customers) })),
      availableFrom: {
        accounting: 'Phase 5',
        reconciliation: 'Phase 6',
      },
    };
  }
}
