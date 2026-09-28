import { Controller, Get, Inject, Query } from '@nestjs/common';
import { auditQuerySchema } from '@fin/contracts';
import { scope } from '../auth/access.service';
import { Ctx, RequestContext, Require } from '../auth/context';
import { forbidden, parse } from '../common/errors';
import { DB_TOKEN, Db } from '../db/db';
import { AuditService } from './audit.service';

@Controller('audit-logs')
export class AuditController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Require('audit.view')
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(auditQuerySchema, query);
    const branches = scope.branchFilter(ctx.auth);
    let sel = this.db
      .selectFrom('audit_logs as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .select([
        'a.id',
        'a.at',
        'a.user_id',
        'u.username',
        'a.role_codes',
        'a.branch_id',
        'a.ip',
        'a.action',
        'a.entity_type',
        'a.entity_id',
        'a.old_values',
        'a.new_values',
        'a.reason',
        'a.request_id',
      ])
      .orderBy('a.id', 'desc')
      .limit(q.limit + 1);
    // Branch-scoped users only see entries tied to their branches.
    if (branches) sel = sel.where('a.branch_id', 'in', branches.length ? branches : ['00000000-0000-0000-0000-000000000000']);
    if (q.cursor && /^\d+$/.test(q.cursor)) sel = sel.where('a.id', '<', q.cursor);
    if (q.userId) sel = sel.where('a.user_id', '=', q.userId);
    if (q.action) sel = sel.where('a.action', 'like', `${q.action.replace(/[%_]/g, '')}%`);
    if (q.entityType) sel = sel.where('a.entity_type', '=', q.entityType);
    if (q.entityId) sel = sel.where('a.entity_id', '=', q.entityId);
    if (q.from) sel = sel.where('a.at', '>=', new Date(`${q.from}T00:00:00+05:30`));
    if (q.to) sel = sel.where('a.at', '<', new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000));
    const rows = await sel.execute();
    const hasMore = rows.length > q.limit;
    const data = rows.slice(0, q.limit);
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
  }

  @Require('audit.view')
  @Get('verify')
  async verify(@Ctx() ctx: RequestContext) {
    if (ctx.auth.scope !== 'ALL') throw forbidden();
    return this.audit.verifyChain();
  }
}
