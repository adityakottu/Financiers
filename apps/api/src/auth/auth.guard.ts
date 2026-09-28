import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@fin/contracts';
import { AppConfig, CONFIG } from '../config/config';
import { ApiError, forbidden, unauthorized } from '../common/errors';
import { CryptoService } from '../common/crypto.service';
import { DB_TOKEN, Db } from '../db/db';
import { AccessService } from './access.service';
import {
  ALLOW_RESTRICTED,
  FinRequest,
  IS_PUBLIC,
  RECENT_AUTH,
  REQUIRED_PERMISSIONS,
  Restriction,
} from './context';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOUCH_INTERVAL_MS = 60_000;
export const RECENT_AUTH_WINDOW_MS = 5 * 60_000;

/**
 * One global guard so the order is fixed and nothing can be skipped:
 * origin check → session → CSRF → restriction → step-up → permission (deny by default).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB_TOKEN) private readonly db: Db,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FinRequest>();
    const unsafe = !SAFE_METHODS.has(req.method);

    // Browsers always send Origin on cross-site POSTs; reject anything not from our web app.
    if (unsafe) {
      const origin = req.get('origin');
      if (origin && !this.config.allowedOrigins.includes(origin)) {
        throw forbidden('BAD_ORIGIN', 'Request origin not allowed');
      }
    }

    if (this.meta<boolean>(IS_PUBLIC, ctx)) return true;

    const token = req.cookies?.[this.config.sessionCookie] as string | undefined;
    if (!token) throw unauthorized();
    const s = await this.sessions.findByToken(token);
    if (!s || s.revoked_at) throw unauthorized('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    if (s.status !== 'ACTIVE') {
      await this.sessions.revoke(this.db, s.id, 'USER_DISABLED');
      throw unauthorized('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    }

    const access = await this.access.load(s.user_id);
    const now = Date.now();
    const idleLimit = access.collectorOnly ? this.config.sessionIdleCollectorMs : this.config.sessionIdleMs;
    if (s.expires_at.getTime() <= now || s.last_seen_at.getTime() + idleLimit <= now) {
      await this.sessions.revoke(this.db, s.id, s.expires_at.getTime() <= now ? 'EXPIRED' : 'IDLE_TIMEOUT');
      throw unauthorized('SESSION_EXPIRED', 'Your session timed out. Please sign in again.');
    }

    if (unsafe) {
      const header = req.get('x-csrf-token');
      if (!header || !CryptoService.safeEqual(CryptoService.sha256(header), s.csrf_hash)) {
        throw forbidden('CSRF_FAILED', 'Security token missing or invalid. Reload the page and try again.');
      }
    }

    let restriction: Restriction | null = null;
    if (s.mfa_pending) restriction = 'MFA_PENDING';
    else if (s.must_change_password) restriction = 'PASSWORD_CHANGE';
    else if (this.config.enforceMfa && access.mfaRequired && !s.mfa_enabled) restriction = 'MFA_SETUP';

    const employee = await this.db
      .selectFrom('employees')
      .select('id')
      .where('user_id', '=', s.user_id)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();

    req.auth = {
      userId: s.user_id,
      username: s.username,
      fullName: s.full_name,
      sessionId: s.id,
      roles: access.roles,
      permissions: access.permissions,
      scope: access.scope,
      branchIds: access.scope === 'ALL' ? [] : access.branchIds,
      employeeId: employee?.id ?? null,
      restriction,
      reauthAt: s.reauth_at,
    };

    if (now - s.last_seen_at.getTime() > TOUCH_INTERVAL_MS) await this.sessions.touch(s.id);

    if (restriction) {
      const allowed = this.meta<Restriction[]>(ALLOW_RESTRICTED, ctx) ?? [];
      if (!allowed.includes(restriction)) {
        throw new ApiError(403, restriction, restrictionMessage(restriction));
      }
    }

    if (this.meta<boolean>(RECENT_AUTH, ctx)) {
      if (!s.reauth_at || now - s.reauth_at.getTime() > RECENT_AUTH_WINDOW_MS) {
        throw new ApiError(403, 'REAUTH_REQUIRED', 'Please confirm your password to continue');
      }
    }

    const required = this.meta<Permission[]>(REQUIRED_PERMISSIONS, ctx);
    if (required === undefined) {
      // A route that forgot to declare its permission is closed, not open.
      throw forbidden('ROUTE_NOT_DECLARED', 'This endpoint has no permission declared');
    }
    if (!required.every((p) => access.permissions.has(p))) throw forbidden();
    return true;
  }
}

function restrictionMessage(r: Restriction) {
  switch (r) {
    case 'MFA_PENDING':
      return 'Enter your authenticator code to finish signing in';
    case 'PASSWORD_CHANGE':
      return 'You must change your password before continuing';
    case 'MFA_SETUP':
      return 'Your role requires two-factor authentication. Set it up to continue.';
  }
}
