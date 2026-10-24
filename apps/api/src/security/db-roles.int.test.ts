import { addMonthsAnchored } from '@fin/loan-engine';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { applyRoles } from '../db/roles';
import { rollStatuses } from '../lending/dues';
import { LoansService } from '../lending/loans.service';
import { TEST_APP_DATABASE_URL, TEST_DATABASE_URL } from '../test/global-setup';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

/**
 * Doc 11 §7 / doc 12 §6: the API runs as fin_app. The database itself refuses destructive
 * statements for that role, and the whole application still works with only those grants.
 */
const asApp = TEST_APP_DATABASE_URL;
let t: TestApp;
let raw: PgClient;

beforeAll(async () => {
  await applyRoles(TEST_DATABASE_URL); // idempotent: running it again changes nothing
  raw = new PgClient({ connectionString: asApp });
  await raw.connect();
  t = await createTestApp();
});
afterAll(async () => {
  await raw?.end();
  await t?.close();
});

const denied = async (q: string) => {
  const e = await raw.query(q).then(() => null, (err: { code: string }) => err);
  expect(e?.code, q).toBe('42501'); // insufficient_privilege
};

describe('fin_app cannot destroy history', () => {
  it('refuses deletes, updates of append-only tables, truncate and DDL', async () => {
    await denied('DELETE FROM payments');
    await denied('DELETE FROM receipts');
    await denied('DELETE FROM journal_entries');
    await denied('UPDATE journal_lines SET debit = debit');
    await denied('UPDATE audit_logs SET action = action');
    await denied('UPDATE payment_allocations SET amount = amount');
    await denied('TRUNCATE audit_logs');
    await denied('CREATE TABLE sneaky (id int)');
    await denied('DROP TABLE payments');
    await denied('ALTER TABLE payments DISABLE TRIGGER ALL');
    // Reading and housekeeping still work.
    expect((await raw.query('SELECT count(*) FROM users')).rowCount).toBe(1);
    await raw.query("DELETE FROM rate_limits WHERE key = 'nothing'");
  });
});

describe('the application works with only fin_app grants', () => {
  let admin: Client;
  let manager: Client;
  let manager2: Client;
  let accountant: Client;
  let accountant2: Client;
  let accountant2User: TestUser;
  let management: Client;
  let managementUser: TestUser;

  it('lends, collects, reverses, reports and opens a recovery case', async () => {
    ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
    const br = (await admin.post('/branches', { code: 'ROLE', name: 'Role Town' })).body.id;
    expect(br).toBeTruthy();
    ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['ROLE'] }));
    ({ client: manager2 } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['ROLE'] }));
    ({ client: accountant } = await signedIn(t, ['ACCOUNTANT'], { branches: ['ROLE'] }));
    ({ client: accountant2, user: accountant2User } = await signedIn(t, ['ACCOUNTANT'], { branches: ['ROLE'] }));
    ({ client: management, user: managementUser } = await signedIn(t, ['MANAGEMENT']));
    const product = await admin.post('/loan-products', {
      code: 'TW-ROLE', name: '2W (roles)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
      amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const bank = (await admin.post('/accounts/bank', { name: 'Role Bank', bankName: 'SBI', accountNumber: '30112200001', ifsc: 'SBIN0000001', kind: 'CURRENT' })).body.id;
    const capital = (await t.db.selectFrom('accounts').select('id').where('code', '=', '3100').executeTakeFirstOrThrow()).id;
    const cap = await accountant.post('/manual-journals', { valueDate: istToday(), branchId: br, narration: 'Capital', lines: [{ accountId: bank, debit: '200000' }, { accountId: capital, credit: '200000' }] });
    expect(cap.status, JSON.stringify(cap.body)).toBe(201);
    await accountant2.reauth(t, accountant2User);
    expect((await accountant2.post(`/manual-journals/${cap.body.id}/approve`, {})).status).toBe(200);

    const c = await manager.post('/customers', { branchId: br, fullName: 'Role Customer', mobile: '9848066666' }, { 'Idempotency-Key': newKey() });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
    const start = addMonthsAnchored(istToday(), -3);
    const loan = await manager.post('/loans', { customerId: c.body.id, productId: product.body.id, principal: '24000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { make: 'TVS', model: 'Jupiter', manufactureYear: 2025, chassisNo: `MDROLE${Date.now() % 1e7}`, engineNo: `EROLE${Date.now() % 1e6}`, assetValue: '80000' } }, { 'Idempotency-Key': newKey() });
    expect(loan.status, JSON.stringify(loan.body)).toBe(201);
    await manager.post(`/loans/${loan.body.id}/submit`);
    expect((await manager2.post(`/loans/${loan.body.id}/approve`, {})).status).toBe(200);
    const d = await manager.post(`/loans/${loan.body.id}/disburse`, { accountId: bank, mode: 'BANK_TRANSFER', reference: `NEFTROLE${Date.now() % 1e6}`, disbursedOn: start }, { 'Idempotency-Key': newKey() });
    expect(d.status, JSON.stringify(d.body)).toBe(200);

    const pay = await manager.post(`/loans/${loan.body.id}/payments`, { amount: '1000', method: 'CASH', atCounter: true, confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const rev = await manager.post(`/payments/${pay.body.id}/reversal`, { reasonCode: 'WRONG_AMOUNT', reasonText: 'Entered against the wrong loan' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(201);
    await management.reauth(t, managementUser);
    expect((await management.post(`/reversals/${rev.body.id}/approve`, {})).status).toBe(200);

    expect((await accountant.get(`/reports/trial-balance?asOf=${istToday()}`)).body.totals.name).toBe('Total — balanced');
    expect((await accountant.download(`/reports/loans-active?format=xlsx`)).status).toBe(200);

    await t.db.transaction().execute(async (tx) => {
      await rollStatuses(tx, istToday(), [loan.body.id]);
      await t.app.get(LoansService).refreshBalances(tx, [loan.body.id], istToday());
    });
    const rc = await manager.post('/recovery/cases', { loanId: loan.body.id, note: 'Missed three installments' });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    expect((await manager.post(`/recovery/cases/${rc.body.id}/actions`, { type: 'CALL', summary: 'No answer' })).status).toBe(201);
    expect((await manager.post('/auth/logout', {})).status).toBeLessThan(300);
  });
});
