import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { scope } from '../auth/access.service';
import { Authenticated, Ctx, RequestContext } from '../auth/context';
import { DB_TOKEN, Db } from '../db/db';

const NONE = '00000000-0000-0000-0000-000000000000';

/**
 * Phase 2 dashboard: only figures that exist today. Lending, collection and reconciliation
 * KPIs are added by the phases that create that data — never shown as fake numbers.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

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

    return {
      customers: customers && {
        active: Number(customers.active),
        total: Number(customers.total),
        kycPending: Number(customers.kyc_pending),
        newToday: Number(customers.new_today),
      },
      staff: staff && { active: Number(staff.active), collectors: Number(staff.collectors) },
      branches: byBranch.map((b) => ({ id: b.id, code: b.code, name: b.name, activeCustomers: Number(b.active_customers) })),
      availableFrom: {
        loans: 'Phase 3',
        collections: 'Phase 4',
        accounting: 'Phase 5',
        reconciliation: 'Phase 6',
      },
    };
  }
}
