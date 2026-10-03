import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totp } from './totp';
import { Client, createTestApp, createUser, ORIGIN, PASSWORD, signedIn, TestApp } from '../test/harness';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const failedLogins = (c: Client, identifier: string, n: number, password = 'Wrong#password99') =>
  Promise.all(Array.from({ length: n }, () => c.post('/auth/login', { identifier, password })));

describe('login', () => {
  it('signs in with username, email or mobile and sets hardened cookies', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    await t.db.updateTable('users').set({ email: `${user.username}@example.in`, mobile: '9' + String(Date.now()).slice(-9) }).where('id', '=', user.id).execute();
    const row = await t.db.selectFrom('users').select(['email', 'mobile']).where('id', '=', user.id).executeTakeFirstOrThrow();

    for (const identifier of [user.username, row.email!, `+91 ${row.mobile}`]) {
      const res = await new Client(t.server).post('/auth/login', { identifier, password: PASSWORD });
      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const sid = cookies.find((c) => c.startsWith('fin_sid='))!;
      expect(sid).toMatch(/HttpOnly/);
      expect(sid).toMatch(/SameSite=Strict/);
      expect(cookies.find((c) => c.startsWith('fin_csrf='))).not.toMatch(/HttpOnly/);
    }
  });

  it('gives the same generic error for unknown user and wrong password', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const c = new Client(t.server);
    const a = await c.post('/auth/login', { identifier: 'nobody-here', password: 'Whatever#123x' });
    const b = await c.post('/auth/login', { identifier: user.username, password: 'Whatever#123x' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failures, even for the correct password, and escalates', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const c = new Client(t.server);
    for (let i = 0; i < 5; i++) await c.post('/auth/login', { identifier: user.username, password: 'Wrong#password99' });
    const res = await c.post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    const u = await t.db.selectFrom('users').select(['locked_until', 'lockout_level']).where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(u.lockout_level).toBe(1);
    expect(u.locked_until!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    const audit = await t.db.selectFrom('audit_logs').select('action').where('entity_id', '=', user.id).where('action', '=', 'auth.account_locked').execute();
    expect(audit).toHaveLength(1);
  });

  it('locks unknown identifiers the same way (no account enumeration via lockout)', async () => {
    const c = new Client(t.server);
    await failedLogins(c, 'ghost-user', 5);
    const res = await c.post('/auth/login', { identifier: 'ghost-user', password: 'Anything#123x' });
    expect(res.status).toBe(429);
  });

  it('throttles an IP after 20 failures across different accounts', async () => {
    const c = new Client(t.server);
    for (let i = 0; i < 20; i++) await c.post('/auth/login', { identifier: `spray-${i}`, password: 'Guess#123456' });
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const res = await c.post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect(res.status).toBe(429);
    // A different IP is unaffected.
    expect((await new Client(t.server).post('/auth/login', { identifier: user.username, password: PASSWORD })).status).toBe(200);
  });

  it('rejects disabled users with the generic error', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER'], { status: 'DISABLED' });
    const res = await new Client(t.server).post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('records login history', async () => {
    const { user, client } = await signedIn(t, ['BRANCH_MANAGER']);
    const res = await client.get('/auth/login-history');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ success: true, reason: 'OK' });
    expect(user.id).toBeTruthy();
  });

  it('rejects unknown fields in the body', async () => {
    const res = await new Client(t.server).post('/auth/login', { identifier: 'a', password: 'b', admin: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('CSRF and origin', () => {
  it('rejects state-changing requests without a valid CSRF token', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER']);
    const cookie = `fin_sid=${(client as unknown as { cookies: Map<string, string> }).cookies.get('fin_sid')}`;
    const missing = await request(t.server).post('/api/v1/auth/logout-all').set('Cookie', cookie).set('Origin', ORIGIN);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_FAILED');
    const wrong = await request(t.server)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', 'forged-token-value');
    expect(wrong.status).toBe(403);
    // Session still works: nothing was changed.
    expect((await client.get('/auth/me')).status).toBe(200);
  });

  it('rejects cross-origin state-changing requests, including login', async () => {
    const res = await request(t.server)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ identifier: 'x', password: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('sessions', () => {
  it('logout ends the session', async () => {
    const { client } = await signedIn(t, ['BRANCH_MANAGER']);
    const sidBefore = (client as unknown as { cookies: Map<string, string> }).cookies.get('fin_sid')!;
    expect((await client.post('/auth/logout')).status).toBe(204);
    const replay = await request(t.server).get('/api/v1/auth/me').set('Cookie', `fin_sid=${sidBefore}`);
    expect(replay.status).toBe(401);
  });

  it('logout-all ends every device', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const phone = await new Client(t.server).login(t, user);
    const laptop = await new Client(t.server).login(t, user);
    const list = await laptop.get('/auth/sessions');
    expect(list.body.data.length).toBeGreaterThanOrEqual(2);
    expect(list.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect((await laptop.post('/auth/logout-all')).status).toBe(204);
    expect((await phone.get('/auth/me')).status).toBe(401);
    expect((await laptop.get('/auth/me')).status).toBe(401);
  });

  it('can revoke one other device', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const phone = await new Client(t.server).login(t, user);
    const laptop = await new Client(t.server).login(t, user);
    const other = (await laptop.get('/auth/sessions')).body.data.find((s: { current: boolean }) => !s.current);
    expect((await laptop.delete(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.get('/auth/me')).status).toBe(401);
    expect((await laptop.get('/auth/me')).status).toBe(200);
  });

  it('expires idle sessions', async () => {
    const { user, client } = await signedIn(t, ['BRANCH_MANAGER']);
    await t.db.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - 31 * 60_000) }).where('user_id', '=', user.id).execute();
    const res = await client.get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('gives collectors a longer idle window', async () => {
    const { user, client } = await signedIn(t, ['COLLECTION_EMPLOYEE']);
    await t.db.updateTable('sessions').set({ last_seen_at: new Date(Date.now() - 60 * 60_000) }).where('user_id', '=', user.id).execute();
    expect((await client.get('/auth/me')).status).toBe(200);
  });

  it('enforces the absolute session lifetime', async () => {
    const { user, client } = await signedIn(t, ['BRANCH_MANAGER']);
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', user.id).execute();
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('ends sessions of a user who gets disabled', async () => {
    const { user, client } = await signedIn(t, ['BRANCH_MANAGER']);
    await t.db.updateTable('users').set({ status: 'DISABLED' }).where('id', '=', user.id).execute();
    expect((await client.get('/auth/me')).status).toBe(401);
  });
});

describe('passwords', () => {
  it('forces a password change before anything else, then unlocks the session', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER'], { mustChangePassword: true });
    const c = await new Client(t.server).login(t, user);
    const blocked = await c.get('/customers');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE');
    expect((await c.get('/auth/me')).body.restriction).toBe('PASSWORD_CHANGE');

    const weak = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'short1' });
    expect(weak.status).toBe(400);
    const same = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body.error.code).toBe('PASSWORD_REUSED');
    const ok = await c.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'Godavari#Bridge77' });
    expect(ok.status).toBe(200);
    expect((await c.get('/customers')).status).toBe(200);
  });

  it('changing the password signs out other devices', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const other = await new Client(t.server).login(t, user);
    const me = await new Client(t.server).login(t, user);
    expect((await me.post('/auth/password/change', { currentPassword: PASSWORD, newPassword: 'Another#Secret88' })).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await me.get('/auth/me')).status).toBe(200);
  });

  it('forgot-password answers the same whether or not the account exists', async () => {
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const c = new Client(t.server);
    const a = await c.post('/auth/password/forgot', { identifier: user.username });
    const b = await c.post('/auth/password/forgot', { identifier: 'does-not-exist' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
    const outbox = await t.db.selectFrom('outbox').select('payload').where('topic', '=', 'auth.password_reset').execute();
    expect(JSON.stringify(outbox)).not.toContain(user.username);
  });

  it('reset links work once, revoke sessions and unlock the account', async () => {
    const { user: admin, client: adminClient } = await signedIn(t, ['SUPER_ADMIN']);
    const user = await createUser(t, ['BRANCH_MANAGER']);
    const victimSession = await new Client(t.server).login(t, user);
    await t.db.updateTable('users').set({ locked_until: new Date(Date.now() + 3_600_000) }).where('id', '=', user.id).execute();

    await adminClient.reauth(t, admin);
    const link = await adminClient.post(`/users/${user.id}/reset-link`);
    expect(link.status).toBe(200);
    const token = new URL(link.body.resetPath, 'http://x').searchParams.get('token')!;

    const c = new Client(t.server);
    expect((await c.post('/auth/password/reset', { token, newPassword: 'Fresh#Password123' })).status).toBe(200);
    expect((await c.post('/auth/password/reset', { token, newPassword: 'Fresh#Password456' })).body.error.code).toBe('INVALID_RESET_TOKEN');
    expect((await victimSession.get('/auth/me')).status).toBe(401);
    expect((await c.post('/auth/login', { identifier: user.username, password: 'Fresh#Password123' })).status).toBe(200);
  });
});

describe('two-factor authentication', () => {
  it('requires MFA enrolment for privileged roles and completes it', async () => {
    const user = await createUser(t, ['ACCOUNTANT'], { mfa: false });
    const c = await new Client(t.server).login(t, user);
    const blocked = await c.get('/customers');
    expect(blocked.body.error.code).toBe('MFA_SETUP');

    const setup = await c.post('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const stored = await t.db.selectFrom('users').select('totp_pending_enc').where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(stored.totp_pending_enc!.toString('latin1')).not.toContain(setup.body.secret);

    expect((await c.post('/auth/mfa/enable', { code: '000000' })).status).toBe(401);
    const enabled = await c.post('/auth/mfa/enable', { code: totp(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect((await c.get('/customers')).status).toBe(200);
  });

  it('login requires the code, rejects replay, and accepts a recovery code once', async () => {
    const user = await createUser(t, ['ACCOUNTANT']);
    const c = new Client(t.server);
    const login = await c.post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    expect((await c.get('/customers')).body.error.code).toBe('MFA_PENDING');

    const code = totp(user.totpSecret!);
    expect((await c.post('/auth/mfa/verify', { code })).status).toBe(200);
    expect((await c.get('/customers')).status).toBe(200);

    // Same code again on a new login: replay is rejected.
    const c2 = new Client(t.server);
    await c2.post('/auth/login', { identifier: user.username, password: PASSWORD });
    const replay = await c2.post('/auth/mfa/verify', { code });
    expect(replay.status).toBe(401);

    // Recovery codes: single use.
    const recovery = await c.send('post', '/auth/mfa/recovery-codes', {});
    expect(recovery.body.error.code).toBe('REAUTH_REQUIRED');
    await c.reauth(t, user);
    const codes: string[] = (await c.post('/auth/mfa/recovery-codes')).body.recoveryCodes;
    const c3 = new Client(t.server);
    await c3.post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect((await c3.post('/auth/mfa/verify', { code: codes[0] })).status).toBe(200);
    const c4 = new Client(t.server);
    await c4.post('/auth/login', { identifier: user.username, password: PASSWORD });
    expect((await c4.post('/auth/mfa/verify', { code: codes[0] })).status).toBe(401);
  });

  it('revokes the pending session after 5 wrong codes', async () => {
    const user = await createUser(t, ['ACCOUNTANT']);
    const c = new Client(t.server);
    await c.post('/auth/login', { identifier: user.username, password: PASSWORD });
    let last;
    for (let i = 0; i < 5; i++) last = await c.post('/auth/mfa/verify', { code: '123456' });
    expect(last!.status).toBe(429);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('does not let privileged roles switch MFA off', async () => {
    const { user, client } = await signedIn(t, ['MANAGEMENT']);
    await client.reauth(t, user);
    const res = await client.post('/auth/mfa/disable');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED_BY_ROLE');
  });
});

describe('route declarations', () => {
  it('every controller route declares a permission or is explicitly public', async () => {
    const { REQUIRED_PERMISSIONS, IS_PUBLIC } = await import('./context');
    const { AppModule } = await import('../app.module');
    const mod = AppModule.forRoot(t.config);
    const undeclared: string[] = [];
    for (const ctrl of mod.controllers ?? []) {
      const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (name === 'constructor' || typeof fn !== 'function') continue;
        if (Reflect.getMetadata('path', fn) === undefined) continue; // not a route handler
        const declared =
          Reflect.getMetadata(REQUIRED_PERMISSIONS, fn) !== undefined ||
          Reflect.getMetadata(IS_PUBLIC, fn) === true ||
          Reflect.getMetadata(REQUIRED_PERMISSIONS, ctrl) !== undefined;
        if (!declared) undeclared.push(`${(ctrl as { name: string }).name}.${name}`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
