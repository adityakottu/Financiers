import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DB_TOKEN, Db, Tx, isUniqueViolation, pgConstraint } from '../db/db';
import type { FinRequest } from '../auth/context';
import { badRequest, conflict } from './errors';

export interface IdemResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Exactly-once execution for create/financial endpoints (doc 02 §7).
 * The key is claimed first, and the business work and the stored response commit in the same
 * transaction. A concurrent duplicate waits on the key, then replays the winner's response; if the
 * winner fails and rolls back, the key is released and the duplicate simply runs.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB_TOKEN) private readonly db: Db) {}

  keyFrom(req: FinRequest): string {
    const key = req.get('idempotency-key');
    if (!key || !UUID_RE.test(key)) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (UUID) is required for this request');
    }
    return key.toLowerCase();
  }

  async run<T>(
    userId: string,
    key: string,
    route: string,
    requestBody: unknown,
    work: (tx: Tx) => Promise<{ status: number; body: T }>,
  ): Promise<IdemResult<T>> {
    const hash = createHash('sha256').update(route + '\n' + stableStringify(requestBody)).digest();
    const prior = await this.lookup(userId, key, route, hash);
    if (prior) return prior as IdemResult<T>;
    try {
      const result = await this.db.transaction().execute(async (tx) => {
        // Claim the key before doing any work. A concurrent request with the same key blocks on
        // this primary key until we commit, then fails the insert and replays our response —
        // instead of racing us for the business row and seeing half-finished state.
        await tx
          .insertInto('idempotency_keys')
          .values({ user_id: userId, key, route, request_hash: hash, response_status: 0, response_body: JSON.stringify({}) })
          .execute();
        const r = await work(tx);
        await tx
          .updateTable('idempotency_keys')
          .set({ response_status: r.status, response_body: JSON.stringify(r.body) })
          .where('user_id', '=', userId)
          .where('key', '=', key)
          .execute();
        return r;
      });
      return { ...result, replayed: false };
    } catch (e) {
      if (isUniqueViolation(e) && pgConstraint(e) === 'idempotency_keys_pkey') {
        const winner = await this.lookup(userId, key, route, hash);
        if (winner) return winner as IdemResult<T>;
      }
      throw e;
    }
  }

  private async lookup(userId: string, key: string, route: string, hash: Buffer): Promise<IdemResult<unknown> | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .select(['route', 'request_hash', 'response_status', 'response_body'])
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    if (row.route !== route || !row.request_hash.equals(hash)) {
      throw conflict('IDEMPOTENCY_MISMATCH', 'This Idempotency-Key was already used for a different request');
    }
    return { status: row.response_status, body: row.response_body, replayed: true };
  }
}
