import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { userAccessSchema, userCreateSchema, userUpdateSchema } from '@fin/contracts';
import { sql } from 'kysely';
import { AuditService, diff } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { Ctx, RequestContext, Require, RequireRecentAuth } from '../auth/context';
import { hashPassword } from '../auth/password';
import { SessionService } from '../auth/session.service';
import { badRequest, conflict, forbidden, notFound, parse } from '../common/errors';
import { DB_TOKEN, Db, Tx, isUniqueViolation, pgConstraint } from '../db/db';

@Controller('users')
export class UsersController {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  private selectUsers() {
    return this.db
      .selectFrom('users as u')
      .select([
        'u.id',
        'u.username',
        'u.full_name',
        'u.email',
        'u.mobile',
        'u.status',
        'u.mfa_enabled',
        'u.must_change_password',
        'u.locked_until',
        'u.last_login_at',
        'u.created_at',
        sql<string[]>`coalesce((SELECT array_agg(r.code ORDER BY r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}')`.as(
          'roles',
        ),
        sql<{ id: string; code: string }[]>`coalesce((SELECT json_agg(json_build_object('id', b.id, 'code', b.code) ORDER BY b.code) FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id), '[]')`.as(
          'branches',
        ),
      ]);
  }

  @Require('user.manage')
  @Get()
  async list() {
    return { data: await this.selectUsers().orderBy('u.username').execute() };
  }

  @Require('user.manage')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const u = await this.selectUsers().where('u.id', '=', id).executeTakeFirst();
    if (!u) throw notFound('User');
    return u;
  }

  private async setAccess(tx: Tx, userId: string, roleCodes: string[], branchIds: string[]) {
    const roles = await tx.selectFrom('roles').select(['id', 'code']).where('code', 'in', roleCodes).execute();
    if (roles.length !== new Set(roleCodes).size) throw badRequest('UNKNOWN_ROLE', 'One or more roles do not exist');
    if (branchIds.length) {
      const found = await tx.selectFrom('branches').select('id').where('id', 'in', branchIds).execute();
      if (found.length !== new Set(branchIds).size) throw badRequest('UNKNOWN_BRANCH', 'One or more branches do not exist');
    }
    await tx.deleteFrom('user_roles').where('user_id', '=', userId).execute();
    await tx.insertInto('user_roles').values(roles.map((r) => ({ user_id: userId, role_id: r.id }))).execute();
    await tx.deleteFrom('user_branches').where('user_id', '=', userId).execute();
    if (branchIds.length) {
      await tx
        .insertInto('user_branches')
        .values([...new Set(branchIds)].map((b) => ({ user_id: userId, branch_id: b })))
        .execute();
    }
  }

  private async assertAnotherActiveAdmin(tx: Tx, excludingUserId: string) {
    const r = await tx
      .selectFrom('users as u')
      .innerJoin('user_roles as ur', 'ur.user_id', 'u.id')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('r.code', '=', 'SUPER_ADMIN')
      .where('u.status', '=', 'ACTIVE')
      .where('u.id', '<>', excludingUserId)
      .executeTakeFirstOrThrow();
    if (Number(r.n) === 0) throw conflict('LAST_ADMIN', 'At least one active Super Admin must remain');
  }

  @Require('user.manage', 'permission.assign')
  @RequireRecentAuth()
  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = parse(userCreateSchema, body);
    this.auth.assertPasswordPolicy(input.temporaryPassword, input.username);
    const passwordHash = await hashPassword(input.temporaryPassword);
    try {
      const id = await this.db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('users')
          .values({
            username: input.username,
            full_name: input.fullName,
            email: input.email ?? null,
            mobile: input.mobile ?? null,
            password_hash: passwordHash,
            must_change_password: true,
            created_by: ctx.auth.userId,
            updated_by: ctx.auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.setAccess(tx, row.id, input.roleCodes, input.branchIds);
        await this.audit.record(tx, ctx, {
          action: 'user.created',
          entityType: 'user',
          entityId: row.id,
          newValues: { ...input, temporaryPassword: undefined },
        });
        return row.id;
      });
      return this.get(id);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const field = pgConstraint(e)?.replace(/^users_|_key$/g, '') ?? 'value';
        throw conflict('DUPLICATE_USER', `A user with this ${field} already exists`);
      }
      throw e;
    }
  }

  @Require('user.manage')
  @Patch(':id')
  async update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(userUpdateSchema, body);
    try {
      await this.db.transaction().execute(async (tx) => {
        const before = await tx.selectFrom('users').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!before) throw notFound('User');
        const next = {
          full_name: input.fullName ?? before.full_name,
          email: input.email === undefined ? before.email : input.email,
          mobile: input.mobile === undefined ? before.mobile : input.mobile,
        };
        const d = diff(before, next);
        if (!d.changed) return;
        await tx
          .updateTable('users')
          .set({ ...next, version: before.version + 1, updated_at: new Date(), updated_by: ctx.auth.userId })
          .where('id', '=', id)
          .execute();
        await this.audit.record(tx, ctx, {
          action: 'user.updated',
          entityType: 'user',
          entityId: id,
          oldValues: d.oldValues,
          newValues: d.newValues,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('DUPLICATE_USER', 'Email or mobile is already used by another user');
      throw e;
    }
    return this.get(id);
  }

  @Require('permission.assign')
  @RequireRecentAuth()
  @Put(':id/access')
  async access(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    if (id === ctx.auth.userId) throw forbidden('SELF_MODIFICATION', 'You cannot change your own roles or branches');
    const input = parse(userAccessSchema, body);
    await this.db.transaction().execute(async (tx) => {
      const before = await this.selectUsers().where('u.id', '=', id).executeTakeFirst();
      if (!before) throw notFound('User');
      if (before.roles.includes('SUPER_ADMIN') && !input.roleCodes.includes('SUPER_ADMIN')) {
        await this.assertAnotherActiveAdmin(tx, id);
      }
      await this.setAccess(tx, id, input.roleCodes, input.branchIds);
      // Access changed: force the user to sign in again so no session keeps old privileges.
      await this.sessions.revokeAllForUser(tx, id, 'ACCESS_CHANGED');
      await this.audit.record(tx, ctx, {
        action: 'user.access_changed',
        entityType: 'user',
        entityId: id,
        oldValues: { roles: before.roles, branches: before.branches.map((b) => b.id) },
        newValues: { roles: input.roleCodes, branches: input.branchIds },
      });
    });
    return this.get(id);
  }

  private async setStatus(ctx: RequestContext, id: string, status: 'ACTIVE' | 'DISABLED') {
    if (id === ctx.auth.userId) throw forbidden('SELF_MODIFICATION', 'You cannot change your own status');
    await this.db.transaction().execute(async (tx) => {
      const before = await this.selectUsers().where('u.id', '=', id).executeTakeFirst();
      if (!before) throw notFound('User');
      if (before.status === status) return;
      if (status === 'DISABLED' && before.roles.includes('SUPER_ADMIN')) await this.assertAnotherActiveAdmin(tx, id);
      await tx
        .updateTable('users')
        .set({ status, updated_at: new Date(), updated_by: ctx.auth.userId })
        .where('id', '=', id)
        .execute();
      if (status === 'DISABLED') await this.sessions.revokeAllForUser(tx, id, 'USER_DISABLED');
      await this.audit.record(tx, ctx, {
        action: status === 'DISABLED' ? 'user.disabled' : 'user.enabled',
        entityType: 'user',
        entityId: id,
        oldValues: { status: before.status },
        newValues: { status },
      });
    });
    return this.get(id);
  }

  @Require('user.manage')
  @Post(':id/disable')
  @HttpCode(200)
  disable(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.setStatus(ctx, id, 'DISABLED');
  }

  @Require('user.manage')
  @Post(':id/enable')
  @HttpCode(200)
  enable(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.setStatus(ctx, id, 'ACTIVE');
  }

  @Require('user.manage')
  @Post(':id/unlock')
  @HttpCode(200)
  async unlock(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.transaction().execute(async (tx) => {
      const r = await tx
        .updateTable('users')
        .set({ locked_until: null, failed_login_count: 0, lockout_level: 0 })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('User');
      await this.audit.record(tx, ctx, { action: 'user.unlocked', entityType: 'user', entityId: id });
    });
    return this.get(id);
  }

  @Require('session.manage_others')
  @Post(':id/force-logout')
  @HttpCode(200)
  async forceLogout(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const n = await this.db.transaction().execute(async (tx) => {
      const count = await this.sessions.revokeAllForUser(tx, id, 'FORCED_LOGOUT');
      await this.audit.record(tx, ctx, {
        action: 'user.force_logout',
        entityType: 'user',
        entityId: id,
        newValues: { sessionsRevoked: count },
      });
      return count;
    });
    return { sessionsRevoked: n };
  }

  /** One-time reset link for the admin to hand over (until SMS/email delivery exists). */
  @Require('user.manage')
  @RequireRecentAuth()
  @Post(':id/reset-link')
  @HttpCode(200)
  async resetLink(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    if (id === ctx.auth.userId) throw forbidden('SELF_MODIFICATION', 'Use "change password" for your own account');
    const token = await this.db.transaction().execute(async (tx) => {
      const u = await tx.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
      if (!u) throw notFound('User');
      const t = await this.auth.issueResetToken(tx, id, ctx.auth.userId);
      await this.audit.record(tx, ctx, { action: 'user.reset_link_issued', entityType: 'user', entityId: id });
      return t;
    });
    return { resetPath: `/reset-password?token=${token}`, expiresInMinutes: 30 };
  }

  /** For a user who lost their phone: clears their second factor; they re-enrol at next sign-in. */
  @Require('user.manage')
  @RequireRecentAuth()
  @Post(':id/reset-mfa')
  @HttpCode(200)
  async resetMfa(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    if (id === ctx.auth.userId) throw forbidden('SELF_MODIFICATION', 'You cannot reset your own two-factor');
    await this.db.transaction().execute(async (tx) => {
      const r = await tx
        .updateTable('users')
        .set({ mfa_enabled: false, totp_secret_enc: null, totp_pending_enc: null, totp_last_step: null })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw notFound('User');
      await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', id).execute();
      await this.sessions.revokeAllForUser(tx, id, 'MFA_RESET');
      await this.audit.record(tx, ctx, { action: 'user.mfa_reset', entityType: 'user', entityId: id });
    });
    return this.get(id);
  }

  @Require('user.manage')
  @Get(':id/login-history')
  async history(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.auth.loginHistory(id, 100) };
  }
}
