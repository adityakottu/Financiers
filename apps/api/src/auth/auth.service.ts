import { Inject, Injectable } from '@nestjs/common';
import { passwordProblems } from '@fin/contracts';
import { toDataURL } from 'qrcode';
import { randomBytes } from 'node:crypto';
import { AppConfig, CONFIG } from '../config/config';
import { AuditActor, AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { ApiError, badRequest, forbidden, unauthorized } from '../common/errors';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { AccessService } from './access.service';
import type { RequestContext } from './context';
import { dummyHash, hashPassword, verifyPassword } from './password';
import { IssuedSession, SessionService } from './session.service';
import { generateSecret, otpauthUri, verifyTotp } from './totp';

const MAX_FAILURES = 5;
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3_600_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_IP_FAILURES = 20;
const RESET_TOKEN_TTL_MS = 30 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const TOTP_AAD = 'users.totp_secret';

interface Meta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const invalidCredentials = () => unauthorized('INVALID_CREDENTIALS', 'Invalid username or password');
const tooManyAttempts = () =>
  new ApiError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or contact your administrator.');

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  /* ------------------------------ login ------------------------------ */

  private findUserByIdentifier(identifier: string) {
    const id = identifier.trim();
    const digits = id.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
    let q = this.db
      .selectFrom('users')
      .select([
        'id',
        'username',
        'password_hash',
        'status',
        'locked_until',
        'failed_login_count',
        'lockout_level',
        'mfa_enabled',
      ]);
    if (/^[6-9]\d{9}$/.test(digits)) q = q.where('mobile', '=', digits);
    else if (id.includes('@')) q = q.where('email', '=', id);
    else q = q.where('username', '=', id);
    return q.executeTakeFirst();
  }

  private async logEvent(userId: string | null, identifier: string, success: boolean, reason: string, meta: Meta) {
    await this.db
      .insertInto('login_events')
      .values({ user_id: userId, identifier, success, reason, ip: meta.ip, user_agent: meta.userAgent })
      .execute();
  }

  private async recentFailures(column: 'identifier' | 'ip', value: string | null) {
    if (!value) return 0;
    const r = await this.db
      .selectFrom('login_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where(column, '=', value)
      .where('success', '=', false)
      .where('at', '>', new Date(Date.now() - FAILURE_WINDOW_MS))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async login(identifier: string, password: string, meta: Meta) {
    const ident = identifier.trim().toLowerCase();
    if ((await this.recentFailures('ip', meta.ip)) >= MAX_IP_FAILURES) {
      await this.logEvent(null, ident, false, 'IP_THROTTLED', meta);
      throw tooManyAttempts();
    }

    const user = await this.findUserByIdentifier(ident);
    if (!user) {
      await verifyPassword(await dummyHash(), password); // equalise timing
      // Unknown identifiers lock the same way known ones do, so lockout doesn't reveal which exist.
      if ((await this.recentFailures('identifier', ident)) >= MAX_FAILURES) throw tooManyAttempts();
      await this.logEvent(null, ident, false, 'UNKNOWN_USER', meta);
      throw invalidCredentials();
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await this.logEvent(user.id, ident, false, 'LOCKED', meta);
      throw tooManyAttempts();
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      await this.registerFailure(user, ident, meta);
      throw invalidCredentials();
    }
    if (user.status !== 'ACTIVE') {
      await this.logEvent(user.id, ident, false, 'DISABLED', meta);
      throw invalidCredentials();
    }

    const actor: AuditActor = { userId: user.id, ...meta };
    const issued = await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('users')
        .set({ failed_login_count: 0, lockout_level: 0, locked_until: null, last_login_at: new Date() })
        .where('id', '=', user.id)
        .execute();
      const s = await this.sessions.create(tx, user.id, meta, user.mfa_enabled);
      await this.audit.recordAs(tx, { ...actor, sessionId: s.sessionId }, {
        action: user.mfa_enabled ? 'auth.login_password_ok' : 'auth.login',
        entityType: 'user',
        entityId: user.id,
      });
      return s;
    });
    await this.logEvent(user.id, ident, true, user.mfa_enabled ? 'MFA_PENDING' : 'OK', meta);
    return { session: issued, mfaRequired: user.mfa_enabled };
  }

  private async registerFailure(
    user: { id: string; failed_login_count: number; lockout_level: number },
    ident: string,
    meta: Meta,
  ) {
    const failures = user.failed_login_count + 1;
    if (failures >= MAX_FAILURES) {
      const lockMs = Math.min(LOCK_BASE_MS * 2 ** user.lockout_level, LOCK_MAX_MS);
      await this.db.transaction().execute(async (tx) => {
        await tx
          .updateTable('users')
          .set({
            failed_login_count: 0,
            lockout_level: user.lockout_level + 1,
            locked_until: new Date(Date.now() + lockMs),
          })
          .where('id', '=', user.id)
          .execute();
        await this.audit.recordAs(tx, { userId: null, ...meta }, {
          action: 'auth.account_locked',
          entityType: 'user',
          entityId: user.id,
          newValues: { lockedForMinutes: lockMs / 60_000 },
        });
      });
    } else {
      await this.db.updateTable('users').set({ failed_login_count: failures }).where('id', '=', user.id).execute();
    }
    await this.logEvent(user.id, ident, false, 'BAD_PASSWORD', meta);
  }

  /* ------------------------------ MFA ------------------------------ */

  private async loadTotpUser(userId: string) {
    return this.db
      .selectFrom('users')
      .select(['id', 'username', 'mfa_enabled', 'totp_secret_enc', 'totp_pending_enc', 'totp_last_step'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  }

  /**
   * Checks a TOTP or recovery code. TOTP steps at or before the last accepted one are
   * rejected (no replay); recovery codes are single-use.
   */
  private async checkSecondFactor(tx: Executor, userId: string, code: string): Promise<'TOTP' | 'RECOVERY' | null> {
    const u = await tx
      .selectFrom('users')
      .select(['totp_secret_enc', 'totp_last_step'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!u.totp_secret_enc) return null;
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const secret = this.crypto.decrypt(u.totp_secret_enc, TOTP_AAD);
      const step = verifyTotp(secret, trimmed);
      if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) return null;
      await tx.updateTable('users').set({ totp_last_step: String(step) }).where('id', '=', userId).execute();
      return 'TOTP';
    }
    const used = await tx
      .updateTable('mfa_recovery_codes')
      .set({ used_at: new Date() })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .where('code_hash', '=', CryptoService.sha256(trimmed.toLowerCase()))
      .executeTakeFirst();
    return Number(used.numUpdatedRows) === 1 ? 'RECOVERY' : null;
  }

  async verifyMfaLogin(ctx: RequestContext, code: string): Promise<IssuedSession> {
    const result = await this.db.transaction().execute(async (tx) => {
      const method = await this.checkSecondFactor(tx, ctx.auth.userId, code);
      if (!method) return null;
      await tx.updateTable('sessions').set({ mfa_pending: false }).where('id', '=', ctx.auth.sessionId).execute();
      const rotated = await this.sessions.rotate(tx, ctx.auth.sessionId);
      await this.audit.record(tx, ctx, {
        action: 'auth.login',
        entityType: 'user',
        entityId: ctx.auth.userId,
        newValues: { secondFactor: method },
      });
      return rotated;
    });
    if (result) return result;

    await this.logEvent(ctx.auth.userId, ctx.auth.username, false, 'MFA_FAILED', ctx);
    const failures = await this.db
      .selectFrom('login_events')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', ctx.auth.userId)
      .where('reason', '=', 'MFA_FAILED')
      .where('at', '>', new Date(Date.now() - FAILURE_WINDOW_MS))
      .executeTakeFirstOrThrow();
    if (Number(failures.n) >= MAX_FAILURES) {
      await this.sessions.revoke(this.db, ctx.auth.sessionId, 'MFA_FAILED');
      throw tooManyAttempts();
    }
    throw unauthorized('INVALID_CODE', 'That code is not valid. Try the latest code from your app.');
  }

  async startMfaSetup(ctx: RequestContext) {
    const u = await this.loadTotpUser(ctx.auth.userId);
    if (u.mfa_enabled) {
      // Re-enrolling replaces a working second factor, so it needs a fresh password check.
      if (!ctx.auth.reauthAt || Date.now() - ctx.auth.reauthAt.getTime() > 5 * 60_000) {
        throw new ApiError(403, 'REAUTH_REQUIRED', 'Please confirm your password to continue');
      }
    }
    const secret = generateSecret();
    await this.db
      .updateTable('users')
      .set({ totp_pending_enc: this.crypto.encrypt(secret, TOTP_AAD) })
      .where('id', '=', ctx.auth.userId)
      .execute();
    const company = await this.db.selectFrom('companies').select(['trade_name', 'legal_name']).executeTakeFirst();
    const issuer = (company?.trade_name || company?.legal_name || 'Financiers').replace(/:/g, '');
    const uri = otpauthUri(secret, u.username, issuer);
    return { secret, otpauthUri: uri, qrDataUrl: await toDataURL(uri, { margin: 1, width: 220 }) };
  }

  async enableMfa(ctx: RequestContext, code: string) {
    return this.db.transaction().execute(async (tx) => {
      const u = await tx
        .selectFrom('users')
        .select(['totp_pending_enc'])
        .where('id', '=', ctx.auth.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!u.totp_pending_enc) throw badRequest('MFA_SETUP_NOT_STARTED', 'Start two-factor setup first');
      const secret = this.crypto.decrypt(u.totp_pending_enc, TOTP_AAD);
      const step = verifyTotp(secret, code.trim());
      if (step === null) throw unauthorized('INVALID_CODE', 'That code is not valid. Check the time on your phone.');
      await tx
        .updateTable('users')
        .set({
          totp_secret_enc: u.totp_pending_enc,
          totp_pending_enc: null,
          totp_last_step: String(step),
          mfa_enabled: true,
          updated_at: new Date(),
        })
        .where('id', '=', ctx.auth.userId)
        .execute();
      const codes = await this.replaceRecoveryCodes(tx, ctx.auth.userId);
      await this.sessions.revokeAllForUser(tx, ctx.auth.userId, 'MFA_ENABLED', ctx.auth.sessionId);
      await this.audit.record(tx, ctx, { action: 'auth.mfa_enabled', entityType: 'user', entityId: ctx.auth.userId });
      return { recoveryCodes: codes };
    });
  }

  async regenerateRecoveryCodes(ctx: RequestContext) {
    return this.db.transaction().execute(async (tx) => {
      const u = await this.loadTotpUser(ctx.auth.userId);
      if (!u.mfa_enabled) throw badRequest('MFA_NOT_ENABLED', 'Two-factor authentication is not enabled');
      const codes = await this.replaceRecoveryCodes(tx, ctx.auth.userId);
      await this.audit.record(tx, ctx, {
        action: 'auth.mfa_recovery_codes_regenerated',
        entityType: 'user',
        entityId: ctx.auth.userId,
      });
      return { recoveryCodes: codes };
    });
  }

  async disableMfa(ctx: RequestContext) {
    const access = await this.access.load(ctx.auth.userId);
    if (this.config.enforceMfa && access.mfaRequired) {
      throw forbidden('MFA_REQUIRED_BY_ROLE', 'Your role requires two-factor authentication');
    }
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('users')
        .set({ mfa_enabled: false, totp_secret_enc: null, totp_pending_enc: null, totp_last_step: null })
        .where('id', '=', ctx.auth.userId)
        .execute();
      await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', ctx.auth.userId).execute();
      await this.audit.record(tx, ctx, { action: 'auth.mfa_disabled', entityType: 'user', entityId: ctx.auth.userId });
    });
  }

  private async replaceRecoveryCodes(tx: Executor, userId: string): Promise<string[]> {
    await tx.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = randomBytes(8).toString('hex').slice(0, 10);
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await tx
      .insertInto('mfa_recovery_codes')
      .values(codes.map((c) => ({ user_id: userId, code_hash: CryptoService.sha256(c) })))
      .execute();
    return codes;
  }

  /* ------------------------------ passwords ------------------------------ */

  async changePassword(ctx: RequestContext, current: string, next: string): Promise<IssuedSession> {
    const user = await this.db
      .selectFrom('users')
      .select(['password_hash', 'username'])
      .where('id', '=', ctx.auth.userId)
      .executeTakeFirstOrThrow();
    if (!(await verifyPassword(user.password_hash, current))) {
      await this.logEvent(ctx.auth.userId, ctx.auth.username, false, 'PASSWORD_CHANGE_BAD_CURRENT', ctx);
      throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    this.assertPasswordPolicy(next, user.username);
    if (await verifyPassword(user.password_hash, next)) {
      throw badRequest('PASSWORD_REUSED', 'New password must be different from the current one');
    }
    const hash = await hashPassword(next);
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('users')
        .set({ password_hash: hash, password_changed_at: new Date(), must_change_password: false, updated_at: new Date() })
        .where('id', '=', ctx.auth.userId)
        .execute();
      await this.sessions.revokeAllForUser(tx, ctx.auth.userId, 'PASSWORD_CHANGED', ctx.auth.sessionId);
      const rotated = await this.sessions.rotate(tx, ctx.auth.sessionId);
      await this.audit.record(tx, ctx, { action: 'auth.password_changed', entityType: 'user', entityId: ctx.auth.userId });
      return rotated;
    });
  }

  assertPasswordPolicy(password: string, username: string) {
    const problems = passwordProblems(password, username);
    if (problems.length) {
      throw badRequest(
        'WEAK_PASSWORD',
        problems[0]!,
        problems.map((message) => ({ path: 'newPassword', message })),
      );
    }
  }

  /** Always succeeds from the caller's view, so it can't be used to discover accounts. */
  async requestPasswordReset(identifier: string, meta: Meta) {
    const ident = identifier.trim().toLowerCase();
    const user = await this.findUserByIdentifier(ident);
    await this.logEvent(user?.id ?? null, ident, false, 'RESET_REQUESTED', meta);
    if (!user || user.status !== 'ACTIVE') return;
    const token = CryptoService.token();
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('password_reset_tokens')
        .values({
          user_id: user.id,
          token_hash: CryptoService.sha256(token),
          expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        })
        .execute();
      // Delivered by the messaging worker (Phase 4). The token is encrypted at rest in the outbox.
      await tx
        .insertInto('outbox')
        .values({
          topic: 'auth.password_reset',
          payload: { userId: user.id, tokenEnc: this.crypto.encrypt(token, 'outbox.reset_token').toString('base64') },
        })
        .execute();
      await this.audit.recordAs(tx, { userId: null, ...meta }, {
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
      });
    });
  }

  /** Admin-issued reset link (used until SMS/email delivery exists). */
  async issueResetToken(tx: Executor, userId: string, createdBy: string): Promise<string> {
    const token = CryptoService.token();
    await tx
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date() })
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .execute();
    await tx
      .insertInto('password_reset_tokens')
      .values({
        user_id: userId,
        token_hash: CryptoService.sha256(token),
        expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        created_by: createdBy,
      })
      .execute();
    return token;
  }

  async resetPassword(token: string, newPassword: string, meta: Meta) {
    const row = await this.db
      .selectFrom('password_reset_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select(['t.id', 't.user_id', 't.expires_at', 't.used_at', 'u.username', 'u.status'])
      .where('t.token_hash', '=', CryptoService.sha256(token))
      .executeTakeFirst();
    if (!row || row.used_at || row.expires_at.getTime() < Date.now() || row.status !== 'ACTIVE') {
      throw badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
    }
    this.assertPasswordPolicy(newPassword, row.username);
    const hash = await hashPassword(newPassword);
    await this.db.transaction().execute(async (tx) => {
      const claimed = await tx
        .updateTable('password_reset_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) {
        throw badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
      }
      await tx
        .updateTable('users')
        .set({
          password_hash: hash,
          password_changed_at: new Date(),
          must_change_password: false,
          failed_login_count: 0,
          locked_until: null,
          updated_at: new Date(),
        })
        .where('id', '=', row.user_id)
        .execute();
      await this.sessions.revokeAllForUser(tx, row.user_id, 'PASSWORD_RESET');
      await this.audit.recordAs(tx, { userId: row.user_id, ...meta }, {
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: row.user_id,
      });
    });
  }

  /* ------------------------------ step-up ------------------------------ */

  async reauthenticate(ctx: RequestContext, password: string, code?: string) {
    const u = await this.db
      .selectFrom('users')
      .select(['password_hash', 'mfa_enabled'])
      .where('id', '=', ctx.auth.userId)
      .executeTakeFirstOrThrow();
    let ok = await verifyPassword(u.password_hash, password);
    if (ok && u.mfa_enabled) {
      if (!code) throw badRequest('CODE_REQUIRED', 'Enter your authenticator code');
      ok = (await this.db.transaction().execute((tx) => this.checkSecondFactor(tx, ctx.auth.userId, code))) !== null;
    }
    if (!ok) {
      await this.logEvent(ctx.auth.userId, ctx.auth.username, false, 'REAUTH_FAILED', ctx);
      const r = await this.db
        .selectFrom('login_events')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', ctx.auth.userId)
        .where('reason', '=', 'REAUTH_FAILED')
        .where('at', '>', new Date(Date.now() - FAILURE_WINDOW_MS))
        .executeTakeFirstOrThrow();
      if (Number(r.n) >= MAX_FAILURES) {
        await this.sessions.revoke(this.db, ctx.auth.sessionId, 'REAUTH_FAILED');
        throw tooManyAttempts();
      }
      throw unauthorized('INVALID_CREDENTIALS', 'Password or code is incorrect');
    }
    await this.db.updateTable('sessions').set({ reauth_at: new Date() }).where('id', '=', ctx.auth.sessionId).execute();
  }

  /* ------------------------------ sessions ------------------------------ */

  async logout(ctx: RequestContext) {
    await this.db.transaction().execute(async (tx) => {
      await this.sessions.revoke(tx, ctx.auth.sessionId, 'LOGOUT');
      await this.audit.record(tx, ctx, { action: 'auth.logout', entityType: 'user', entityId: ctx.auth.userId });
    });
  }

  async logoutAll(ctx: RequestContext) {
    await this.db.transaction().execute(async (tx) => {
      const n = await this.sessions.revokeAllForUser(tx, ctx.auth.userId, 'LOGOUT_ALL');
      await this.audit.record(tx, ctx, {
        action: 'auth.logout_all',
        entityType: 'user',
        entityId: ctx.auth.userId,
        newValues: { sessionsRevoked: n },
      });
    });
  }

  listSessions(userId: string) {
    return this.db
      .selectFrom('sessions')
      .select(['id', 'created_at', 'last_seen_at', 'ip', 'user_agent', 'mfa_pending'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
      .execute();
  }

  async revokeOwnSession(ctx: RequestContext, sessionId: string) {
    await this.db.transaction().execute(async (tx) => {
      const r = await tx
        .updateTable('sessions')
        .set({ revoked_at: new Date(), revoke_reason: 'REVOKED_BY_USER' })
        .where('id', '=', sessionId)
        .where('user_id', '=', ctx.auth.userId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
      await this.audit.record(tx, ctx, { action: 'auth.session_revoked', entityType: 'session', entityId: sessionId });
    });
  }

  loginHistory(userId: string, limit = 50) {
    return this.db
      .selectFrom('login_events')
      .select(['id', 'success', 'reason', 'ip', 'user_agent', 'at'])
      .where('user_id', '=', userId)
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  async me(ctx: RequestContext) {
    const [user, branches, employee] = await Promise.all([
      this.db
        .selectFrom('users')
        .select(['id', 'username', 'full_name', 'email', 'mobile', 'mfa_enabled', 'must_change_password', 'last_login_at'])
        .where('id', '=', ctx.auth.userId)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('branches')
        .select(['id', 'code', 'name'])
        .$if(ctx.auth.scope !== 'ALL', (q) =>
          q.where('id', 'in', ctx.auth.branchIds.length ? ctx.auth.branchIds : ['00000000-0000-0000-0000-000000000000']),
        )
        .where('is_active', '=', true)
        .orderBy('code')
        .execute(),
      ctx.auth.employeeId
        ? this.db
            .selectFrom('employees')
            .select(['id', 'employee_code', 'is_collector', 'branch_id'])
            .where('id', '=', ctx.auth.employeeId)
            .executeTakeFirst()
        : undefined,
    ]);
    return {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      mobile: user.mobile,
      mfaEnabled: user.mfa_enabled,
      lastLoginAt: user.last_login_at,
      roles: ctx.auth.roles,
      permissions: [...ctx.auth.permissions].sort(),
      scope: ctx.auth.scope,
      branches,
      employee: employee
        ? { id: employee.id, code: employee.employee_code, isCollector: employee.is_collector, branchId: employee.branch_id }
        : null,
      restriction: ctx.auth.restriction,
    };
  }
}
