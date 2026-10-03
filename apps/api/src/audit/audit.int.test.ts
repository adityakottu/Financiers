import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db/db';
import { TEST_DATABASE_URL } from '../test/global-setup';
import { branchId, createTestApp, newKey, signedIn, TestApp } from '../test/harness';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('audit log', () => {
  it('records who changed what, with old and new values', async () => {
    const { user, client } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const kkd = await branchId(t.db, 'KKD');
    const created = await client.post('/customers', { branchId: kkd, fullName: 'Audit Person', mobile: '9123456780' }, { 'Idempotency-Key': newKey() });
    const upd = await client.patch(`/customers/${created.body.id}`, { villageTown: 'Samalkot' }, { 'If-Match': '"v1"' });
    expect(upd.status).toBe(200);
    const rows = await t.db
      .selectFrom('audit_logs')
      .select(['action', 'user_id', 'role_codes', 'ip', 'branch_id', 'old_values', 'new_values', 'request_id'])
      .where('entity_id', '=', created.body.id)
      .orderBy('id')
      .execute();
    expect(rows.map((r) => r.action)).toEqual(['customer.created', 'customer.updated']);
    expect(rows[1]).toMatchObject({
      user_id: user.id,
      role_codes: ['BRANCH_MANAGER'],
      branch_id: kkd,
      old_values: { village_town: null },
      new_values: { village_town: 'Samalkot' },
    });
    expect(rows[1]!.ip).toBeTruthy();
    expect(rows[1]!.request_id).toBeTruthy();
  });

  it('is append-only for the application', async () => {
    await expect(sql`UPDATE audit_logs SET action = 'tampered'`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_logs`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_logs`.execute(t.db)).rejects.toThrow(/append-only/);
  });

  it('hash chain verifies, and detects tampering done by bypassing the trigger', async () => {
    const { client } = await signedIn(t, ['SUPER_ADMIN']);
    const ok = await client.get('/audit-logs/verify');
    expect(ok.body.ok).toBe(true);
    expect(ok.body.checked).toBeGreaterThan(0);

    // Simulate a DBA editing history: disable the guard, change a row, restore the guard.
    const raw = createDb(TEST_DATABASE_URL, 1);
    const victim = await raw.selectFrom('audit_logs').select('id').orderBy('id').limit(1).offset(1).executeTakeFirstOrThrow();
    await sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`.execute(raw);
    await sql`UPDATE audit_logs SET reason = 'edited later' WHERE id = ${victim.id}`.execute(raw);
    await sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`.execute(raw);
    const broken = await client.get('/audit-logs/verify');
    expect(broken.body.ok).toBe(false);
    expect(broken.body.brokenAtId).toBe(victim.id);

    // Put it back so later tests see a valid chain.
    await sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only`.execute(raw);
    await sql`UPDATE audit_logs SET reason = NULL WHERE id = ${victim.id}`.execute(raw);
    await sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only`.execute(raw);
    await raw.destroy();
    expect((await client.get('/audit-logs/verify')).body.ok).toBe(true);
  });

  it('stays a single linear chain under concurrent writers', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const kkd = await branchId(t.db, 'KKD');
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        client.post('/customers', { branchId: kkd, fullName: `Parallel ${i}`, mobile: '9000000000' }, { 'Idempotency-Key': newKey() }),
      ),
    );
    const { client: admin } = await signedIn(t, ['SUPER_ADMIN']);
    expect((await admin.get('/audit-logs/verify')).body.ok).toBe(true);
  });

  it('lets branch-scoped users see only their branches’ entries, and filters work', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RJY'] });
    const rjy = await branchId(t.db, 'RJY');
    const res = await client.get('/audit-logs?limit=200');
    expect(res.status).toBe(200);
    for (const row of res.body.data) expect(row.branch_id).toBe(rjy);
    const verify = await client.get('/audit-logs/verify');
    expect(verify.status).toBe(403);

    const { client: admin } = await signedIn(t, ['SUPER_ADMIN']);
    const filtered = await admin.get('/audit-logs?action=customer.&limit=5');
    expect(filtered.body.data.length).toBeGreaterThan(0);
    for (const row of filtered.body.data) expect(row.action.startsWith('customer.')).toBe(true);
    const page2 = await admin.get(`/audit-logs?action=customer.&limit=5&cursor=${filtered.body.nextCursor}`);
    expect(Number(page2.body.data[0].id)).toBeLessThan(Number(filtered.body.data[4].id));
  });

  it('never stores secrets in audit values', async () => {
    const rows = await t.db.selectFrom('audit_logs').select(['old_values', 'new_values']).execute();
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Correct#Horse42battery/);
    expect(text).not.toMatch(/password_hash/);
  });
});
