import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { DB_TOKEN, Db, Executor } from '../db/db';
import type { RequestContext } from '../auth/context';

/** Keys whose values must never be written to the audit log. */
const REDACT = /password|secret|token|_enc$|_hash$|bidx|totp/i;

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  branchId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  reason?: string | null;
}

/** Anonymous/system actor data for events without a signed-in user (e.g. failed login). */
export interface AuditActor {
  userId?: string | null;
  roles?: string[];
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export function sanitize(values: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!values) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    if (REDACT.test(k)) out[k] = '[REDACTED]';
    else if (Buffer.isBuffer(v)) out[k] = '[BINARY]';
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}

/** Only the fields that changed, for compact old/new values. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const b = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      oldValues[k] = a;
      newValues[k] = b;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  /** Write inside the caller's transaction so the audit row commits or rolls back with the change. */
  async record(db: Executor, ctx: RequestContext, entry: AuditEntry): Promise<void> {
    await this.recordAs(
      db,
      {
        userId: ctx.auth.userId,
        roles: ctx.auth.roles,
        sessionId: ctx.auth.sessionId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      },
      entry,
    );
  }

  async recordAs(db: Executor, actor: AuditActor, entry: AuditEntry): Promise<void> {
    await db
      .insertInto('audit_logs')
      .values({
        user_id: actor.userId ?? null,
        role_codes: actor.roles ?? [],
        session_id: actor.sessionId ?? null,
        ip: actor.ip ?? null,
        user_agent: actor.userAgent ?? null,
        request_id: actor.requestId ?? null,
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        branch_id: entry.branchId ?? null,
        old_values: sanitize(entry.oldValues) as never,
        new_values: sanitize(entry.newValues) as never,
        reason: entry.reason ?? null,
        hash: Buffer.alloc(0), // replaced by the chaining trigger
      })
      .execute();
  }

  /**
   * Recompute the hash chain from the stored rows. Any edit made by bypassing the
   * append-only trigger (e.g. a superuser) breaks the chain at that row.
   */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtId: string | null }> {
    let prev: Buffer | null = null as Buffer | null;
    let checked = 0;
    let lastId = '0';
    for (;;) {
      const rows = await sql<{ id: string; prev_hash: Buffer | null; hash: Buffer; payload: string }>`
        SELECT a.id, a.prev_hash, a.hash, audit_log_payload(a) AS payload
        FROM audit_logs a WHERE a.id > ${lastId}::bigint ORDER BY a.id LIMIT 1000`.execute(this.db);
      if (rows.rows.length === 0) break;
      for (const r of rows.rows) {
        const expectedPrev = prev ? prev.toString('hex') : null;
        const actualPrev = r.prev_hash ? r.prev_hash.toString('hex') : null;
        const expected: Buffer = createHash('sha256')
          .update((prev ? prev.toString('hex') : '') + r.payload)
          .digest();
        if (expectedPrev !== actualPrev || !expected.equals(r.hash)) {
          return { ok: false, checked, brokenAtId: r.id };
        }
        prev = r.hash;
        checked++;
        lastId = r.id;
      }
    }
    return { ok: true, checked, brokenAtId: null };
  }
}
