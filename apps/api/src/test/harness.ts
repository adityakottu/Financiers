import type { INestApplication } from '@nestjs/common';
import type { RoleCode } from '@fin/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app';
import { hashPassword } from '../auth/password';
import { generateSecret, totp } from '../auth/totp';
import { CryptoService } from '../common/crypto.service';
import { AppConfig, loadConfig } from '../config/config';
import { createDb, Db } from '../db/db';
import { TEST_DATABASE_URL } from './global-setup';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'Correct#Horse42battery';

export interface TestApp {
  app: INestApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  db: Db;
  config: AppConfig;
  crypto: CryptoService;
  close: () => Promise<void>;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    APP_ORIGIN: ORIGIN,
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    BLIND_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
    ENFORCE_MFA: 'true',
    TRUST_PROXY: '1',
    FILE_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'fin-files-')),
    ...overrides,
  });
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = testConfig(overrides);
  const app = await createApp(config);
  await app.init();
  const db = createDb(TEST_DATABASE_URL, 5);
  return {
    app,
    server: app.getHttpServer(),
    db,
    config,
    crypto: new CryptoService(config),
    close: async () => {
      await db.destroy();
      await app.close();
    },
  };
}

export async function branchId(db: Db, code: string): Promise<string> {
  return (await db.selectFrom('branches').select('id').where('code', '=', code).executeTakeFirstOrThrow()).id;
}

export interface TestUser {
  id: string;
  username: string;
  password: string;
  totpSecret: string | null;
}

/** Creates a ready-to-use user directly in the DB (password already changed, MFA enrolled if the role needs it). */
export async function createUser(
  t: TestApp,
  roles: RoleCode[],
  opts: { branches?: string[]; mfa?: boolean; mustChangePassword?: boolean; status?: 'ACTIVE' | 'DISABLED' } = {},
): Promise<TestUser> {
  const username = `u${randomUUID().slice(0, 8)}`;
  const needsMfa = opts.mfa ?? roles.some((r) => ['SUPER_ADMIN', 'MANAGEMENT', 'ACCOUNTANT'].includes(r));
  const totpSecret = needsMfa ? generateSecret() : null;
  const u = await t.db
    .insertInto('users')
    .values({
      username,
      full_name: `Test ${username}`,
      password_hash: await hashPassword(PASSWORD),
      must_change_password: opts.mustChangePassword ?? false,
      mfa_enabled: needsMfa,
      totp_secret_enc: totpSecret ? t.crypto.encrypt(totpSecret, 'users.totp_secret') : null,
      status: opts.status ?? 'ACTIVE',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const roleRows = await t.db.selectFrom('roles').select('id').where('code', 'in', roles).execute();
  await t.db.insertInto('user_roles').values(roleRows.map((r) => ({ user_id: u.id, role_id: r.id }))).execute();
  const branchCodes = opts.branches ?? ['HQ'];
  for (const code of branchCodes) {
    await t.db.insertInto('user_branches').values({ user_id: u.id, branch_id: await branchId(t.db, code) }).execute();
  }
  return { id: u.id, username, password: PASSWORD, totpSecret };
}

/** Cookie-carrying HTTP client that sends the CSRF header and Origin like the web app does. */
export class Client {
  private cookies = new Map<string, string>();
  /** Each client looks like a different device/IP, as it would behind the load balancer. */
  readonly ip = `10.${rnd()}.${rnd()}.${rnd()}`;

  constructor(private readonly server: TestApp['server']) {}

  get csrf() {
    return this.cookies.get('fin_csrf') ?? '';
  }

  private capture(res: request.Response) {
    const set = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const c of set ?? []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || value === '') this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
    return res;
  }

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async send(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    let r = request(this.server)[method](`/api/v1${path}`).set('Cookie', this.cookieHeader()).set('X-Forwarded-For', this.ip);
    if (method !== 'get') r = r.set('Origin', ORIGIN).set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    if (body !== undefined) r = r.send(body as object);
    return this.capture(await r);
  }

  /** GET a binary response (xlsx, pdf) as bytes. */
  async download(path: string) {
    const res = await request(this.server)
      .get(`/api/v1${path}`)
      .set('Cookie', this.cookieHeader())
      .set('X-Forwarded-For', this.ip)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    return { status: res.status, headers: res.headers, bytes: res.body as Buffer };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.send('get', path, undefined, headers);
  }
  post(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.send('post', path, body ?? {}, headers);
  }
  put(path: string, body: unknown, headers?: Record<string, string>) {
    return this.send('put', path, body, headers);
  }
  patch(path: string, body: unknown, headers?: Record<string, string>) {
    return this.send('patch', path, body, headers);
  }
  delete(path: string) {
    return this.send('delete', path);
  }

  /** Full sign-in including the TOTP step when the user has MFA. */
  async login(t: TestApp, user: TestUser) {
    const res = await this.post('/auth/login', { identifier: user.username, password: user.password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.mfaRequired) {
      // Allow repeated logins within one 30 s window in tests (replay protection is tested separately).
      await t.db.updateTable('users').set({ totp_last_step: null }).where('id', '=', user.id).execute();
      const v = await this.post('/auth/mfa/verify', { code: totp(user.totpSecret!) });
      if (v.status !== 200) throw new Error(`mfa failed: ${v.status} ${JSON.stringify(v.body)}`);
    }
    return this;
  }

  /** Step-up re-authentication for endpoints marked @RequireRecentAuth. */
  async reauth(t: TestApp, user: TestUser) {
    await t.db.updateTable('users').set({ totp_last_step: null }).where('id', '=', user.id).execute();
    const r = await this.post('/auth/reauth', {
      password: user.password,
      ...(user.totpSecret ? { code: totp(user.totpSecret) } : {}),
    });
    if (r.status !== 200) throw new Error(`reauth failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

export async function signedIn(t: TestApp, roles: RoleCode[], opts: Parameters<typeof createUser>[2] = {}) {
  const user = await createUser(t, roles, opts);
  const client = await new Client(t.server).login(t, user);
  return { user, client };
}

export const newKey = () => randomUUID();
function rnd() {
  return Math.floor(Math.random() * 254) + 1;
}
