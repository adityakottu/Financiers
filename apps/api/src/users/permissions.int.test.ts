import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchId, Client, createTestApp, createUser, newKey, signedIn, TestApp } from '../test/harness';

let t: TestApp;
let kkd: string;
let rjy: string;
beforeAll(async () => {
  t = await createTestApp();
  kkd = await branchId(t.db, 'KKD');
  rjy = await branchId(t.db, 'RJY');
});
afterAll(async () => t.close());

const customerBody = (branch: string, name = 'Lakshmi Devi') => ({ branchId: branch, fullName: name, mobile: '9876543210' });

async function auditCount() {
  const r = await t.db.selectFrom('audit_logs').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  return Number(r.n);
}

describe('collection employee', () => {
  it('cannot reach admin, user, audit, KYC or customer-creation endpoints', async () => {
    const { client } = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    const before = await auditCount();
    const attempts = [
      await client.get('/users'),
      await client.post('/users', {}),
      await client.get('/audit-logs'),
      await client.post('/branches', { code: 'X1', name: 'X' }),
      await client.put('/settings/company', { legalName: 'Hacked' }),
      await client.post('/customers', customerBody(kkd), { 'Idempotency-Key': newKey() }),
      await client.get('/employees'),
    ];
    for (const r of attempts) expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await auditCount()).toBe(before);
  });

  it('sees no customers until loans are assigned to them (Phase 4)', async () => {
    const { client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const created = await manager.post('/customers', customerBody(kkd, 'Assigned Later'), { 'Idempotency-Key': newKey() });
    const { client } = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    expect((await client.get('/customers')).body.data).toEqual([]);
    expect((await client.get(`/customers/${created.body.id}`)).status).toBe(404);
    expect((await client.get('/search?q=Assigned')).body.data).toEqual([]);
  });
});

describe('branch manager', () => {
  it('works inside own branch only; other branches look non-existent', async () => {
    const { client: kkdManager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const { client: rjyManager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RJY'] });
    const rjyCustomer = await rjyManager.post('/customers', customerBody(rjy, 'Rajahmundry Only'), { 'Idempotency-Key': newKey() });
    expect(rjyCustomer.status).toBe(201);

    expect((await kkdManager.get(`/customers/${rjyCustomer.body.id}`)).status).toBe(404);
    expect((await kkdManager.patch(`/customers/${rjyCustomer.body.id}`, { fullName: 'Changed' }, { 'If-Match': '"v1"' })).status).toBe(404);
    const list = await kkdManager.get('/customers?q=Rajahmundry');
    expect(list.body.data).toEqual([]);

    const cross = await kkdManager.post('/customers', customerBody(rjy), { 'Idempotency-Key': newKey() });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('BRANCH_OUT_OF_SCOPE');
    const branches = await kkdManager.get('/branches');
    expect(branches.body.data.map((b: { code: string }) => b.code)).toEqual(['KKD']);
  });

  it('cannot manage users, branches or permissions', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const target = await createUser(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    for (const r of [
      await client.get('/users'),
      await client.put(`/users/${target.id}/access`, { roleCodes: ['SUPER_ADMIN'], branchIds: [] }),
      await client.post(`/users/${target.id}/disable`),
      await client.post('/branches', { code: 'NEW', name: 'New' }),
    ]) {
      expect(r.status).toBe(403);
    }
    const roles = await t.db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select('r.code')
      .where('ur.user_id', '=', target.id)
      .execute();
    expect(roles.map((r) => r.code)).toEqual(['COLLECTION_EMPLOYEE']);
  });

  it('can manage employees only in own branch', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const code = `E${Date.now().toString().slice(-6)}`;
    const ok = await client.post('/employees', { branchId: kkd, employeeCode: code, fullName: 'Ravi Kumar', isCollector: true });
    expect(ok.status).toBe(201);
    const bad = await client.post('/employees', { branchId: rjy, employeeCode: `${code}R`, fullName: 'Other', isCollector: true });
    expect(bad.status).toBe(403);
  });
});

describe('accountant', () => {
  it('can view but not create or edit customers, and cannot reveal KYC', async () => {
    const { client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
    const c = await manager.post(
      '/customers',
      { ...customerBody(kkd, 'Accountant View'), kyc: { pan: 'ABCDE1111F' } },
      { 'Idempotency-Key': newKey() },
    );
    const { user, client } = await signedIn(t, ['ACCOUNTANT'], { branches: ['KKD'] });
    expect((await client.get(`/customers/${c.body.id}`)).status).toBe(200);
    expect((await client.post('/customers', customerBody(kkd), { 'Idempotency-Key': newKey() })).status).toBe(403);
    expect((await client.patch(`/customers/${c.body.id}`, { fullName: 'X' }, { 'If-Match': '"v1"' })).status).toBe(403);
    await client.reauth(t, user);
    expect((await client.post(`/customers/${c.body.id}/kyc/PAN/reveal`)).status).toBe(403);
  });
});

describe('super admin and access changes', () => {
  it('cannot change own roles, and role changes need recent re-authentication', async () => {
    const { user, client } = await signedIn(t, ['SUPER_ADMIN']);
    const target = await createUser(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    const noStepUp = await client.put(`/users/${target.id}/access`, { roleCodes: ['BRANCH_MANAGER'], branchIds: [kkd] });
    expect(noStepUp.body.error.code).toBe('REAUTH_REQUIRED');

    await client.reauth(t, user);
    const self = await client.put(`/users/${user.id}/access`, { roleCodes: ['COLLECTION_EMPLOYEE'], branchIds: [] });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_MODIFICATION');
  });

  it('changing a user’s access signs them out and is audited', async () => {
    const { user: admin, client } = await signedIn(t, ['SUPER_ADMIN']);
    const target = await createUser(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    const targetClient = await new Client(t.server).login(t, target);
    await client.reauth(t, admin);
    const res = await client.put(`/users/${target.id}/access`, { roleCodes: ['BRANCH_MANAGER'], branchIds: [kkd, rjy] });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['BRANCH_MANAGER']);
    expect((await targetClient.get('/auth/me')).status).toBe(401);
    const entry = await t.db
      .selectFrom('audit_logs')
      .select(['old_values', 'new_values', 'user_id'])
      .where('action', '=', 'user.access_changed')
      .where('entity_id', '=', target.id)
      .executeTakeFirstOrThrow();
    expect(entry.user_id).toBe(admin.id);
    expect(entry.old_values).toMatchObject({ roles: ['COLLECTION_EMPLOYEE'] });
    expect(entry.new_values).toMatchObject({ roles: ['BRANCH_MANAGER'] });
  });

  it('never leaves the system without an active Super Admin', async () => {
    // Make `sole` the only active Super Admin.
    const sole = await createUser(t, ['SUPER_ADMIN']);
    const otherAdmins = await t.db
      .selectFrom('user_roles as ur')
      .innerJoin('roles as r', 'r.id', 'ur.role_id')
      .select('ur.user_id')
      .where('r.code', '=', 'SUPER_ADMIN')
      .where('ur.user_id', '<>', sole.id)
      .execute();
    const disabled = otherAdmins.map((o) => o.user_id);
    if (disabled.length) await t.db.updateTable('users').set({ status: 'DISABLED' }).where('id', 'in', disabled).execute();

    // A Management user granted user/permission administration through explicit overrides.
    const { user: mgmt, client } = await signedIn(t, ['MANAGEMENT']);
    await t.db
      .insertInto('user_permission_overrides')
      .values([
        { user_id: mgmt.id, permission_code: 'permission.assign', effect: 'ALLOW' },
        { user_id: mgmt.id, permission_code: 'user.manage', effect: 'ALLOW' },
      ])
      .execute();
    await client.reauth(t, mgmt);

    const demote = await client.put(`/users/${sole.id}/access`, { roleCodes: ['MANAGEMENT'], branchIds: [] });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_ADMIN');
    const disable = await client.post(`/users/${sole.id}/disable`);
    expect(disable.body.error.code).toBe('LAST_ADMIN');

    // A DENY override beats a role grant.
    await t.db.insertInto('user_permission_overrides').values({ user_id: mgmt.id, permission_code: 'audit.view', effect: 'DENY' }).execute();
    expect((await client.get('/audit-logs')).status).toBe(403);

    if (disabled.length) await t.db.updateTable('users').set({ status: 'ACTIVE' }).where('id', 'in', disabled).execute();
  });

  it('creates users with a temporary password that must be changed', async () => {
    const { user: admin, client } = await signedIn(t, ['SUPER_ADMIN']);
    await client.reauth(t, admin);
    const username = `new${Date.now().toString().slice(-6)}`;
    const weak = await client.post('/users', {
      username,
      fullName: 'New Collector',
      temporaryPassword: 'password',
      roleCodes: ['COLLECTION_EMPLOYEE'],
      branchIds: [kkd],
    });
    expect(weak.status).toBe(400);
    const res = await client.post('/users', {
      username,
      fullName: 'New Collector',
      temporaryPassword: 'Temp#Password2026',
      roleCodes: ['COLLECTION_EMPLOYEE'],
      branchIds: [kkd],
    });
    expect(res.status).toBe(201);
    expect(res.body.must_change_password).toBe(true);
    const audit = await t.db.selectFrom('audit_logs').select('new_values').where('action', '=', 'user.created').where('entity_id', '=', res.body.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.new_values)).not.toContain('Temp#Password2026');
  });
});
