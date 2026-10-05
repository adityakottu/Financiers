import { ROLE_CODES, SYSTEM_ROLES, type Permission, type RoleCode } from '@fin/contracts';
import { addMonthsAnchored } from '@fin/loan-engine';
import { RequestMethod } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC, RECENT_AUTH, REQUIRED_PERMISSIONS } from '../auth/context';
import { istToday } from '../common/dates';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

/**
 * Doc 12 §8 security suite: the full role × route permission matrix (generated from the code, so
 * a new route is covered automatically), IDOR, SQL injection, XSS, mass assignment, money input
 * abuse, and audit completeness.
 */
let t: TestApp;
const clients = {} as Record<RoleCode, { client: Client; user: TestUser }>;
const ZERO = '00000000-0000-4000-8000-000000000000';
const METHOD: Record<number, 'get' | 'post' | 'put' | 'delete' | 'patch'> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch' };

interface Route { method: 'get' | 'post' | 'put' | 'delete' | 'patch'; path: string; perms: Permission[] | undefined; isPublic: boolean; recent: boolean; name: string }

async function routes(): Promise<Route[]> {
  const { AppModule } = await import('../app.module');
  const out: Route[] = [];
  for (const ctrl of AppModule.forRoot(t.config).controllers ?? []) {
    const base = String(Reflect.getMetadata('path', ctrl) ?? '').replace(/^\/|\/$/g, '');
    const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata('path', fn) === undefined) continue;
      const sub = String(Reflect.getMetadata('path', fn)).replace(/^\/|\/$/g, '');
      const path = `/${[base, sub].filter(Boolean).join('/')}`.replace(/:[A-Za-z]+/g, (p) => (/date/i.test(p) ? istToday() : /token/i.test(p) ? 'x'.repeat(24) : /name|kind|type|code/i.test(p) ? 'loans-active' : ZERO));
      out.push({
        method: METHOD[Reflect.getMetadata('method', fn) as number] ?? 'get',
        path,
        perms: Reflect.getMetadata(REQUIRED_PERMISSIONS, fn) ?? Reflect.getMetadata(REQUIRED_PERMISSIONS, ctrl),
        isPublic: Reflect.getMetadata(IS_PUBLIC, fn) === true,
        recent: Reflect.getMetadata(RECENT_AUTH, fn) === true,
        name: `${(ctrl as { name: string }).name}.${name}`,
      });
    }
  }
  return out;
}

beforeAll(async () => {
  t = await createTestApp();
  for (const role of ROLE_CODES) clients[role] = await signedIn(t, [role], { branches: role === 'SUPER_ADMIN' || role === 'MANAGEMENT' ? undefined : ['KKD'] });
});
afterAll(async () => t.close());

describe('permission matrix (every route × every role)', () => {
  it('a role without the permission is refused before anything happens — no side effects, no audit entry', async () => {
    const all = await routes();
    expect(all.length).toBeGreaterThan(150);
    for (const role of ROLE_CODES) await clients[role].client.reauth(t, clients[role].user); // step-up satisfied: the permission alone decides
    const auditBefore = Number((await sql<{ n: string }>`SELECT count(*)::text n FROM audit_logs`.execute(t.db)).rows[0]!.n);
    const failures: string[] = [];
    let checked = 0;
    for (const role of ROLE_CODES) {
      const has = new Set(SYSTEM_ROLES.find((r) => r.code === role)!.permissions);
      for (const r of all) {
        if (r.isPublic || !r.perms || r.perms.length === 0) continue; // public / any signed-in user
        if (r.perms.every((p) => has.has(p))) continue;
        const res = await clients[role].client[r.method](r.path, {});
        checked++;
        if (res.status !== 403 || res.body?.error?.code !== 'FORBIDDEN') failures.push(`${role} ${r.method.toUpperCase()} ${r.path} (${r.name}) → ${res.status} ${res.body?.error?.code ?? ''}`);
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(300);
    const auditAfter = Number((await sql<{ n: string }>`SELECT count(*)::text n FROM audit_logs`.execute(t.db)).rows[0]!.n);
    expect(auditAfter).toBe(auditBefore); // refused requests leave no trace except the security log
  });

  it('a role that has the permission is never refused by the guard (GET routes)', async () => {
    const failures: string[] = [];
    for (const role of ROLE_CODES) {
      const has = new Set(SYSTEM_ROLES.find((r) => r.code === role)!.permissions);
      // Routes declared "any signed-in user" authorise inside the handler (own records only, etc.);
      // the audit-chain check is limited to all-branch roles in its handler. Both are tested elsewhere.
      const guarded = (await routes()).filter((x) => x.method === 'get' && !x.isPublic && x.perms && x.perms.length > 0 && x.perms.every((p) => has.has(p)) && x.name !== 'AuditController.verify');
      for (const r of guarded) {
        const res = await clients[role].client.get(r.path);
        if (res.status === 403 && res.body?.error?.code === 'FORBIDDEN') failures.push(`${role} GET ${r.path} (${r.name})`);
        if (res.status >= 500) failures.push(`${role} GET ${r.path} (${r.name}) → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every route is reachable only signed in, unless explicitly public', async () => {
    const anon = (await routes()).filter((r) => !r.isPublic);
    const leaks: string[] = [];
    for (const r of anon) {
      const res = await request(t.server)[r.method](`/api/v1${r.path}`).set('Origin', 'http://localhost:3000');
      if (res.status !== 401) leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('IDOR: another branch’s records are invisible', () => {
  it('customers, loans, schedules, statements, payments and receipts of KKD are hidden from an RJY manager and an unassigned collector', async () => {
    const kkd = (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id;
    const m = clients.BRANCH_MANAGER.client;
    const { client: m2 } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const { client: rjy } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RJY'] });
    const c = await m.post('/customers', { branchId: kkd, fullName: 'Idor Customer', mobile: '9848099999' }, { 'Idempotency-Key': newKey() });
    await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
    const product = await clients.SUPER_ADMIN.client.post('/loan-products', {
      code: 'TW-IDOR', name: '2W idor', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
      amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
    });
    const start = addMonthsAnchored(istToday(), -1);
    const loan = await m.post('/loans', { customerId: c.body.id, productId: product.body.id, principal: '20000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 6, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { make: 'Hero', model: 'HF', manufactureYear: 2025, chassisNo: `MDIDOR${Date.now() % 1e7}`, engineNo: `EIDOR${Date.now() % 1e6}`, assetValue: '60000' } }, { 'Idempotency-Key': newKey() });
    await m.post(`/loans/${loan.body.id}/submit`);
    await m2.post(`/loans/${loan.body.id}/approve`, {});
    const cash = (await t.db.selectFrom('accounts').select('id').where('code', '=', '1110-KKD').executeTakeFirstOrThrow()).id;
    await t.db.transaction().execute(async (tx) => {
      const { LedgerService } = await import('../ledger/ledger.service');
      const { Money } = await import('@fin/money');
      await t.app.get(LedgerService).post(tx, { entryType: 'OPENING', valueDate: istToday(), branchId: null, sourceType: 'test', sourceId: 'idor-float', narration: 'float', lines: [{ account: cash, debit: Money.of('100000') }, { account: '3100', credit: Money.of('100000') }], createdBy: clients.SUPER_ADMIN.user.id });
    });
    const d = await m.post(`/loans/${loan.body.id}/disburse`, { accountId: cash, mode: 'CASH', disbursedOn: start }, { 'Idempotency-Key': newKey() });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const pay = await m.post(`/loans/${loan.body.id}/payments`, { amount: '500', method: 'CASH', atCounter: true, confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const paths = [`/customers/${c.body.id}`, `/loans/${loan.body.id}`, `/loans/${loan.body.id}/schedule`, `/loans/${loan.body.id}/statement`, `/payments/${pay.body.id}`, `/payments/${pay.body.id}/receipt.pdf`];
    for (const viewer of [rjy, clients.COLLECTION_EMPLOYEE.client]) {
      for (const p of paths) {
        const r = await viewer.get(p);
        expect([403, 404], `${p} → ${r.status}`).toContain(r.status);
      }
      expect((await viewer.post(`/loans/${loan.body.id}/payments`, { amount: '100', method: 'CASH', atCounter: true }, { 'Idempotency-Key': newKey() })).status).not.toBe(201);
    }
  });
});

describe('injection and hostile input', () => {
  const PAYLOADS = ["' OR '1'='1", "1; DROP TABLE users; --", "%' UNION SELECT password_hash FROM users --", '\\x00', '${7*7}', "' || pg_sleep(5) || '"];

  it('SQL injection in search, filters and sort parameters never errors, never leaks, never runs', async () => {
    const admin = clients.SUPER_ADMIN.client;
    const targets = ['/search?q=', '/customers?q=', '/loans?q=', '/payments?q=', '/recovery/cases?q=', '/audit?q=', '/loans?status=', '/payments?method=', '/reports/loans-active?category=', '/journals?type='];
    for (const base of targets) {
      for (const p of PAYLOADS) {
        const started = Date.now();
        const r = await admin.get(`${base}${encodeURIComponent(p)}`);
        expect(r.status, `${base}${p} → ${r.status}`).toBeLessThan(500);
        expect(Date.now() - started, `${base}${p} slept`).toBeLessThan(3000);
        expect(JSON.stringify(r.body)).not.toMatch(/\$argon2/);
      }
    }
    expect((await sql<{ n: string }>`SELECT count(*)::text n FROM users`.execute(t.db)).rows[0]!.n).not.toBe('0');
  });

  it('scripts and markup are stored as text and never reflected as HTML; downloads are named safely', async () => {
    const kkd = (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id;
    const xss = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
    const c = await clients.BRANCH_MANAGER.client.post('/customers', { branchId: kkd, fullName: `Xss ${xss}`.slice(0, 100), mobile: '9848012121', addressLine1: xss }, { 'Idempotency-Key': newKey() });
    if (c.status === 201) {
      const back = await clients.BRANCH_MANAGER.client.get(`/customers/${c.body.id}`);
      expect(back.headers['content-type']).toMatch(/application\/json/);
      expect(back.headers['x-content-type-options']).toBe('nosniff');
      expect(back.headers['content-security-policy']).toContain("default-src 'none'");
    } else {
      expect(c.status).toBe(400); // or refused outright by validation
    }
    const f = await clients.SUPER_ADMIN.client.download(`/reports/loans-active?format=pdf&category=${encodeURIComponent('"><x>')}`);
    expect([200, 400]).toContain(f.status);
    if (f.status === 200) expect(f.headers['content-disposition']).toMatch(/^attachment; filename="[\w.-]+"$/);
  });

  it('unknown fields are refused (no mass assignment); money must be positive with at most 2 decimals', async () => {
    const kkd = (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id;
    const m = clients.BRANCH_MANAGER.client;
    expect((await m.post('/customers', { branchId: kkd, fullName: 'Mass Assign', mobile: '9848013131', kycStatus: 'VERIFIED', id: ZERO }, { 'Idempotency-Key': newKey() })).status).toBe(400);
    const loan = await t.db.selectFrom('loans').select('id').where('status', '=', 'ACTIVE').executeTakeFirst();
    if (loan) {
      for (const amount of ['-100', '0', '10.005', '1e5', 'NaN', '99999999999999999']) {
        const r = await m.post(`/loans/${loan.id}/payments`, { amount, method: 'CASH', atCounter: true }, { 'Idempotency-Key': newKey() });
        expect([400, 404, 422], `${amount} → ${r.status}`).toContain(r.status);
      }
    }
    // There is no way to edit or delete a payment through the API.
    expect([404, 405]).toContain((await m.put(`/payments/${ZERO}`, { amount: '1' })).status);
    expect([404, 405]).toContain((await m.delete(`/payments/${ZERO}`)).status);
  });
});

describe('audit completeness', () => {
  it('each sensitive action writes exactly one audit entry', async () => {
    const admin = clients.SUPER_ADMIN.client;
    const count = async (action: string) => Number((await sql<{ n: string }>`SELECT count(*)::text n FROM audit_logs WHERE action = ${action}`.execute(t.db)).rows[0]!.n);
    const before = await count('report.exported');
    await admin.download(`/reports/trial-balance?format=xlsx&asOf=${istToday()}`);
    expect(await count('report.exported')).toBe(before + 1);
    const failedLogins = Number((await sql<{ n: string }>`SELECT count(*)::text n FROM login_events WHERE success = false`.execute(t.db)).rows[0]!.n);
    await request(t.server).post('/api/v1/auth/login').send({ identifier: clients.ACCOUNTANT.user.username, password: 'definitely-wrong-1' });
    expect(Number((await sql<{ n: string }>`SELECT count(*)::text n FROM login_events WHERE success = false`.execute(t.db)).rows[0]!.n)).toBe(failedLogins + 1);
  });
});
