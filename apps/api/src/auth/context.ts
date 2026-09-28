import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, RoleCode, Scope } from '@fin/contracts';
import type { Request } from 'express';

/** Why a signed-in session is limited to a few endpoints until the user completes a step. */
export type Restriction = 'MFA_PENDING' | 'PASSWORD_CHANGE' | 'MFA_SETUP';

export interface AuthContext {
  userId: string;
  username: string;
  fullName: string;
  sessionId: string;
  roles: RoleCode[];
  permissions: Set<Permission>;
  scope: Scope;
  /** Branches the user is scoped to (empty for ALL scope — no filter applies). */
  branchIds: string[];
  employeeId: string | null;
  restriction: Restriction | null;
  reauthAt: Date | null;
}

/** Per-request data every service call receives for authorization and audit. */
export interface RequestContext {
  auth: AuthContext;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface FinRequest extends Request {
  requestId: string;
  auth?: AuthContext;
}

export function requestMeta(req: FinRequest) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    requestId: req.requestId,
  };
}

export const IS_PUBLIC = 'fin:public';
export const REQUIRED_PERMISSIONS = 'fin:permissions';
export const ALLOW_RESTRICTED = 'fin:allowRestricted';
export const RECENT_AUTH = 'fin:recentAuth';

/** No session required (login, password reset, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** The caller must hold every listed permission. Every non-public route must declare one. */
export const Require = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);
/** Any signed-in user (no specific permission) — used for self-service endpoints. */
export const Authenticated = () => SetMetadata(REQUIRED_PERMISSIONS, []);
/** Endpoint usable while the session is restricted (e.g. before MFA is completed). */
export const AllowRestricted = (...states: Restriction[]) => SetMetadata(ALLOW_RESTRICTED, states);
/** Step-up: the user must have re-entered their password within the last 5 minutes. */
export const RequireRecentAuth = () => SetMetadata(RECENT_AUTH, true);

export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext => {
  const req = ctx.switchToHttp().getRequest<FinRequest>();
  if (!req.auth) throw new Error('Ctx used on a route without authentication');
  return { auth: req.auth, ...requestMeta(req) };
});
