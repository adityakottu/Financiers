import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { branchCreateSchema, branchUpdateSchema } from '@fin/contracts';
import { AuditService, diff } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import { Authenticated, Ctx, RequestContext, Require } from '../auth/context';
import { conflict, notFound, parse, preconditionFailed } from '../common/errors';
import { DB_TOKEN, Db, isUniqueViolation } from '../db/db';
import { expectedVersion } from './versioning';
import { ensureBranchAccounts } from '../ledger/ledger.service';

const COLUMNS = ['id', 'code', 'name', 'address', 'phone', 'is_active', 'version', 'created_at'] as const;

@Controller('branches')
export class BranchesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Any signed-in user may list the branches in their own scope (for pickers). */
  @Authenticated()
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const branches = scope.branchFilter(ctx.auth);
    let q = this.db.selectFrom('branches').select(COLUMNS).orderBy('code');
    if (branches) q = q.where('id', 'in', branches.length ? branches : ['00000000-0000-0000-0000-000000000000']);
    return { data: await q.execute() };
  }

  @Authenticated()
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    scope.assertBranch(ctx.auth, id, 'Branch');
    const row = await this.db.selectFrom('branches').select(COLUMNS).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Branch');
    return row;
  }

  @Require('branch.manage')
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(branchCreateSchema, body);
    try {
      return await this.db.transaction().execute(async (tx) => {
        const company = await tx.selectFrom('companies').select('id').executeTakeFirstOrThrow();
        const row = await tx
          .insertInto('branches')
          .values({
            company_id: company.id,
            code: input.code,
            name: input.name,
            address: input.address ?? null,
            phone: input.phone ?? null,
            created_by: ctx.auth.userId,
            updated_by: ctx.auth.userId,
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        await ensureBranchAccounts(tx, row);
        await this.audit.record(tx, ctx, {
          action: 'branch.created',
          entityType: 'branch',
          entityId: row.id,
          branchId: row.id,
          newValues: input,
        });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('DUPLICATE_CODE', `Branch code ${input.code} already exists`);
      throw e;
    }
  }

  @Require('branch.manage')
  @Patch(':id')
  async update(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const input = parse(branchUpdateSchema, body);
    const version = expectedVersion(ifMatch);
    return this.db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom('branches').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('Branch');
      if (before.version !== version) throw preconditionFailed();
      const next = {
        name: input.name ?? before.name,
        address: input.address === undefined ? before.address : input.address,
        phone: input.phone === undefined ? before.phone : input.phone,
        is_active: input.isActive ?? before.is_active,
      };
      const d = diff(before, next);
      if (!d.changed) return this.pick(before);
      const row = await tx
        .updateTable('branches')
        .set({ ...next, version: before.version + 1, updated_at: new Date(), updated_by: ctx.auth.userId })
        .where('id', '=', id)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'branch.updated',
        entityType: 'branch',
        entityId: id,
        branchId: id,
        oldValues: d.oldValues,
        newValues: d.newValues,
      });
      return row;
    });
  }

  private pick(b: Record<string, unknown>) {
    return Object.fromEntries(COLUMNS.map((c) => [c, b[c]]));
  }
}
