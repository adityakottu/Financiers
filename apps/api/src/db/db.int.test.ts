import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../test/global-setup';
import { createDb } from './db';

describe('database pool resilience', () => {
  it('survives the server terminating idle connections (e.g. failover) and reconnects', async () => {
    const db = createDb(TEST_DATABASE_URL, 2);
    await sql`SELECT 1`.execute(db); // leave an idle client in the pool
    const admin = createDb(TEST_DATABASE_URL, 1);
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE application_name = 'financiers-api' AND pid <> pg_backend_pid() AND state = 'idle'`.execute(admin);
    await new Promise((r) => setTimeout(r, 200)); // the idle client's error event fires here
    const r = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
    expect(r.rows[0]!.ok).toBe(1);
    await db.destroy();
    await admin.destroy();
  });
});
