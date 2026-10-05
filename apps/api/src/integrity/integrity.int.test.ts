import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/db';
import { Client, createTestApp, signedIn, TestApp } from '../test/harness';
import { runIntegrityChecks } from './checks';

/**
 * Doc 12 §6 / doc 14 §4: the checks pass on a healthy database and catch each kind of tampering.
 * Tampering happens inside a transaction that is rolled back, so no other suite sees it.
 */
let t: TestApp;
let admin: Client;
let manager: Client;

beforeAll(async () => {
  t = await createTestApp();
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
});
afterAll(async () => t.close());

class Rollback extends Error {}
/** Run `tamper` as the database owner (bypassing triggers), then the checks, then roll back. */
async function tampered(tamper: string[]) {
  let result: Awaited<ReturnType<typeof runIntegrityChecks>> = [];
  await t.db
    .transaction()
    .execute(async (tx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(tx); // owner bypasses the guard triggers
      for (const s of tamper) await sql.raw(s).execute(tx); // eslint-disable-line no-restricted-syntax
      await sql`SET LOCAL session_replication_role = origin`.execute(tx);
      result = await runIntegrityChecks(tx as unknown as Db);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return Object.fromEntries(result.map((c) => [c.code, c]));
}

describe('integrity checks', () => {
  it('pass on a healthy database, via the API, and are recorded', async () => {
    const r = await admin.post('/integrity/run', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const c of r.body.checks) expect(c.ok, `${c.code}: ${c.detail} ${JSON.stringify(c.samples)}`).toBe(true);
    const runs = await admin.get('/integrity/runs');
    expect(runs.body[0].ok).toBe(true);
    expect(runs.body[0].trigger).toBe('MANUAL');
    expect((await manager.post('/integrity/run', {})).status).toBe(403);
  });

  it('catch an unbalanced entry, a falsified loan balance and an edited audit record', async () => {
    const line = await t.db.selectFrom('journal_lines').select(['id']).where('debit', '>', '0').executeTakeFirst();
    const audit = await t.db.selectFrom('audit_logs').select('id').orderBy('id').executeTakeFirstOrThrow();
    const loan = await t.db.selectFrom('loans').select('id').where('status', '=', 'ACTIVE').executeTakeFirst();
    const tamper = [
      ...(line ? [`UPDATE journal_lines SET debit = debit + 1 WHERE id = '${line.id}'`] : []),
      `UPDATE audit_logs SET action = 'tampered' WHERE id = ${audit.id}`,
      ...(loan ? [`UPDATE loans SET principal_outstanding = principal_outstanding + 100 WHERE id = '${loan.id}'`] : []),
    ];
    const r = await tampered(tamper);
    expect(r.AUDIT_CHAIN!.ok).toBe(false);
    expect(r.AUDIT_CHAIN!.detail).toContain(String(audit.id));
    if (line) {
      expect(r.ENTRIES_BALANCED!.ok).toBe(false);
      expect(r.TRIAL_BALANCE!.ok).toBe(false);
    }
    if (loan) {
      expect(r.LOAN_SUBLEDGER!.ok).toBe(false);
      expect(r.RECEIVABLE_CONTROL!.ok).toBe(false);
    }
    // Nothing persisted: the real database is still healthy.
    const after = await runIntegrityChecks(t.db);
    expect(after.filter((c) => !c.ok).map((c) => c.code)).toEqual([]);
  });

  it('catch negative cash', async () => {
    const acct = await t.db.selectFrom('accounts').select(['id', 'code']).where('subtype', '=', 'CASH').executeTakeFirstOrThrow();
    const entry = await t.db.selectFrom('journal_entries').select('id').executeTakeFirst();
    if (!entry) return;
    const r = await tampered([`INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit) VALUES ('${entry.id}', 999, '${acct.id}', 0, 99999999)`]);
    expect(r.CASH_NOT_NEGATIVE!.ok).toBe(false);
    expect(r.CASH_NOT_NEGATIVE!.samples!.join(' ')).toContain(acct.code);
  });
});
