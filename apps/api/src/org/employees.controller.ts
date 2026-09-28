import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { employeeCreateSchema, employeeUpdateSchema } from '@fin/contracts';
import { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service';
import { scope } from '../auth/access.service';
import { Ctx, RequestContext, Require } from '../auth/context';
import { conflict, notFound, parse, preconditionFailed } from '../common/errors';
import { DB_TOKEN, Db, Tx, isUniqueViolation, pgConstraint } from '../db/db';
import { expectedVersion } from './versioning';

const listQuery = z.object({
  branchId: z.string().uuid().optional(),
  collectorsOnly: z.enum(['true', 'false']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

@Controller('employees')
export class EmployeesController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private base() {
    return this.db
      .selectFrom('employees as e')
      .innerJoin('branches as b', 'b.id', 'e.branch_id')
      .leftJoin('users as u', 'u.id', 'e.user_id')
      .select([
        'e.id',
        'e.employee_code',
        'e.full_name',
        'e.designation',
        'e.mobile',
        'e.joined_on',
        'e.is_collector',
        'e.status',
        'e.version',
        'e.branch_id',
        'b.code as branch_code',
        'e.user_id',
        'u.username',
      ]);
  }

  @Require('employee.view')
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listQuery, query);
    const branches = scope.branchFilter(ctx.auth);
    let sel = this.base().orderBy('e.employee_code');
    if (branches) sel = sel.where('e.branch_id', 'in', branches.length ? branches : ['00000000-0000-0000-0000-000000000000']);
    if (q.branchId) sel = sel.where('e.branch_id', '=', q.branchId);
    if (q.collectorsOnly === 'true') sel = sel.where('e.is_collector', '=', true);
    if (q.status) sel = sel.where('e.status', '=', q.status);
    return { data: await sel.execute() };
  }

  @Require('employee.view')
  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.base().where('e.id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Employee');
    scope.assertBranch(ctx.auth, row.branch_id, 'Employee');
    return row;
  }

  private async assertLinkableUser(tx: Tx, userId: string) {
    const u = await tx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!u) throw notFound('User');
  }

  @Require('employee.manage')
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(employeeCreateSchema, body);
    scope.assertBranchWritable(ctx.auth, input.branchId);
    try {
      return await this.db.transaction().execute(async (tx) => {
        if (input.userId) await this.assertLinkableUser(tx, input.userId);
        const row = await tx
          .insertInto('employees')
          .values({
            branch_id: input.branchId,
            employee_code: input.employeeCode,
            full_name: input.fullName,
            designation: input.designation ?? null,
            mobile: input.mobile ?? null,
            joined_on: input.joinedOn ?? null,
            is_collector: input.isCollector,
            user_id: input.userId ?? null,
            created_by: ctx.auth.userId,
            updated_by: ctx.auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(tx, ctx, {
          action: 'employee.created',
          entityType: 'employee',
          entityId: row.id,
          branchId: input.branchId,
          newValues: input,
        });
        return row;
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw pgConstraint(e) === 'employees_user_id_key'
          ? conflict('USER_ALREADY_LINKED', 'That user is already linked to another employee')
          : conflict('DUPLICATE_CODE', `Employee code ${input.employeeCode} already exists`);
      }
      throw e;
    }
  }

  @Require('employee.manage')
  @Patch(':id')
  async update(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const input = parse(employeeUpdateSchema, body);
    const version = expectedVersion(ifMatch);
    try {
      return await this.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('employees').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!before) throw notFound('Employee');
        scope.assertBranch(ctx.auth, before.branch_id, 'Employee');
        if (input.branchId) scope.assertBranchWritable(ctx.auth, input.branchId);
        if (before.version !== version) throw preconditionFailed();
        if (input.userId) await this.assertLinkableUser(tx, input.userId);
        const next = {
          branch_id: input.branchId ?? before.branch_id,
          full_name: input.fullName ?? before.full_name,
          designation: input.designation === undefined ? before.designation : input.designation,
          mobile: input.mobile === undefined ? before.mobile : input.mobile,
          joined_on: input.joinedOn === undefined ? before.joined_on : input.joinedOn,
          is_collector: input.isCollector ?? before.is_collector,
          user_id: input.userId === undefined ? before.user_id : input.userId,
          status: input.status ?? before.status,
        };
        const d = diff(before, next);
        if (d.changed) {
          await tx
            .updateTable('employees')
            .set({ ...next, version: before.version + 1, updated_at: new Date(), updated_by: ctx.auth.userId })
            .where('id', '=', id)
            .execute();
          await this.audit.record(tx, ctx, {
            action: 'employee.updated',
            entityType: 'employee',
            entityId: id,
            branchId: next.branch_id,
            oldValues: d.oldValues,
            newValues: d.newValues,
          });
        }
        return { id };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('USER_ALREADY_LINKED', 'That user is already linked to another employee');
      throw e;
    }
  }
}
