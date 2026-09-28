import { Inject, Injectable } from '@nestjs/common';
import { ALL_PERMISSIONS, Permission, RoleCode, Scope, widestScope } from '@fin/contracts';
import { DB_TOKEN, Db, Executor } from '../db/db';
import { forbidden, notFound } from '../common/errors';
import type { AuthContext } from './context';

export interface UserAccess {
  roles: RoleCode[];
  permissions: Set<Permission>;
  scope: Scope;
  branchIds: string[];
  mfaRequired: boolean;
  collectorOnly: boolean;
}

const KNOWN = new Set<string>(ALL_PERMISSIONS);

@Injectable()
export class AccessService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Effective permissions = union of role permissions, then per-user ALLOW/DENY overrides (DENY wins). */
  async load(userId: string, db: Executor = this.db): Promise<UserAccess> {
    const [roles, perms, overrides, branches] = await Promise.all([
      db
        .selectFrom('user_roles as ur')
        .innerJoin('roles as r', 'r.id', 'ur.role_id')
        .select(['r.code', 'r.scope', 'r.mfa_required'])
        .where('ur.user_id', '=', userId)
        .execute(),
      db
        .selectFrom('user_roles as ur')
        .innerJoin('role_permissions as rp', 'rp.role_id', 'ur.role_id')
        .select('rp.permission_code')
        .distinct()
        .where('ur.user_id', '=', userId)
        .execute(),
      db
        .selectFrom('user_permission_overrides')
        .select(['permission_code', 'effect'])
        .where('user_id', '=', userId)
        .execute(),
      db.selectFrom('user_branches').select('branch_id').where('user_id', '=', userId).execute(),
    ]);

    const permissions = new Set<Permission>();
    for (const p of perms) if (KNOWN.has(p.permission_code)) permissions.add(p.permission_code as Permission);
    for (const o of overrides) if (o.effect === 'ALLOW' && KNOWN.has(o.permission_code)) permissions.add(o.permission_code as Permission);
    for (const o of overrides) if (o.effect === 'DENY') permissions.delete(o.permission_code as Permission);

    const roleCodes = roles.map((r) => r.code as RoleCode);
    return {
      roles: roleCodes,
      permissions,
      scope: roles.length ? widestScope(roles.map((r) => r.scope as Scope)) : 'ASSIGNED',
      branchIds: branches.map((b) => b.branch_id),
      mfaRequired: roles.some((r) => r.mfa_required),
      collectorOnly: roleCodes.length > 0 && roleCodes.every((r) => r === 'COLLECTION_EMPLOYEE'),
    };
  }
}

/**
 * Row-scope helpers. Services call these instead of hand-rolling branch filters so list
 * endpoints cannot leak rows from other branches.
 */
export const scope = {
  /** Branch ids to filter on, or null when the user sees every branch. [] means "nothing". */
  branchFilter(auth: AuthContext): string[] | null {
    if (auth.scope === 'ALL') return null;
    if (auth.scope === 'BRANCH') return auth.branchIds;
    return [];
  },

  canAccessBranch(auth: AuthContext, branchId: string): boolean {
    return auth.scope === 'ALL' || (auth.scope === 'BRANCH' && auth.branchIds.includes(branchId));
  },

  /** Out-of-scope rows are reported as not found so their existence isn't disclosed. */
  assertBranch(auth: AuthContext, branchId: string, what = 'Record'): void {
    if (!scope.canAccessBranch(auth, branchId)) throw notFound(what);
  },

  /** For create/update targets the user named explicitly, a clear 403 is more useful than 404. */
  assertBranchWritable(auth: AuthContext, branchId: string): void {
    if (!scope.canAccessBranch(auth, branchId)) throw forbidden('BRANCH_OUT_OF_SCOPE', 'You cannot act on this branch');
  },

  has(auth: AuthContext, p: Permission): boolean {
    return auth.permissions.has(p);
  },
};
