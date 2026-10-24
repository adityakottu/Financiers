import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { sql } from 'kysely';
import type { Db } from '../db/db';

/**
 * Rate-limit counters in PostgreSQL, so a limit holds across every API instance (the default
 * in-memory store would give each instance its own allowance). One atomic upsert per request:
 * a fixed window of `ttl` ms; once over the limit the key is blocked for `blockDuration` ms.
 */
export class PgThrottlerStorage implements ThrottlerStorage {
  private calls = 0;

  constructor(private readonly db: Db) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const k = `${throttlerName}:${key}`;
    const block = blockDuration > 0 ? blockDuration : ttl;
    const r = await sql<{ hits: number; expires_in: number; blocked_in: number }>`
      INSERT INTO rate_limits AS r (key, hits, expires_at) VALUES (${k}, 1, now() + ${ttl} * interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN r.expires_at <= now() THEN 1 ELSE r.hits + 1 END,
        expires_at = CASE WHEN r.expires_at <= now() THEN now() + ${ttl} * interval '1 millisecond' ELSE r.expires_at END,
        blocked_until = CASE
          WHEN r.blocked_until > now() THEN r.blocked_until
          WHEN (CASE WHEN r.expires_at <= now() THEN 1 ELSE r.hits + 1 END) > ${limit} THEN now() + ${block} * interval '1 millisecond'
          ELSE NULL END
      RETURNING hits,
        greatest(0, ceil(extract(epoch FROM r.expires_at - now())))::int expires_in,
        greatest(0, ceil(extract(epoch FROM coalesce(r.blocked_until, now()) - now())))::int blocked_in`.execute(this.db);
    // Expired rows are cleared now and then; the table stays small.
    if (++this.calls % 500 === 0) void sql`DELETE FROM rate_limits WHERE expires_at < now() - interval '1 hour' AND (blocked_until IS NULL OR blocked_until < now())`.execute(this.db).catch(() => undefined);
    const x = r.rows[0]!;
    return { totalHits: x.hits, timeToExpire: x.expires_in, isBlocked: x.blocked_in > 0, timeToBlockExpire: x.blocked_in };
  }
}
