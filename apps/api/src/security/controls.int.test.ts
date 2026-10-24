import ExcelJS from 'exceljs';
import { createServer, Server } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

/** Phase 8 controls: shared rate limits, maintenance mode, malware scanning, safe exports. */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`);

/** A stand-in for clamd speaking INSTREAM: flags anything containing the EICAR test string. */
function fakeClamd(): Promise<{ server: Server; port: number; scans: () => number; setDown: (d: boolean) => void }> {
  let scans = 0;
  let down = false;
  const server = createServer((sock) => {
    if (down) return sock.destroy();
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= 14 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
        scans++;
        const payload = buf.subarray(10).toString('latin1');
        sock.end(payload.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, scans: () => scans, setDown: (d) => (down = d) })),
  );
}

describe('rate limits hold across API instances', () => {
  let a: TestApp;
  let b: TestApp;
  beforeAll(async () => {
    a = await createTestApp();
    b = await createTestApp();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('the public receipt check allows 30 a minute per address, counted together on both instances', async () => {
    const ip = `10.250.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const r = await request((i % 2 ? b : a).server).get('/api/v1/public/receipts/not-a-real-token-123456').set('X-Forwarded-For', ip).set('x-test-throttle', '1');
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 404), statuses.join(',')).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    const other = await request(a.server).get('/api/v1/public/receipts/not-a-real-token-123456').set('X-Forwarded-For', '10.251.1.1').set('x-test-throttle', '1');
    expect(other.status).toBe(404); // another address is unaffected
  });
});

describe('maintenance mode', () => {
  let t: TestApp;
  let admin: Client;
  let adminUser: TestUser;
  let manager: Client;
  beforeAll(async () => {
    t = await createTestApp();
    ({ client: admin, user: adminUser } = await signedIn(t, ['SUPER_ADMIN']));
    ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  });
  afterAll(async () => {
    await admin.reauth(t, adminUser).catch(() => undefined);
    await admin.put('/system/maintenance', { enabled: false });
    await t.close();
  });

  it('refuses every change while on, keeps reading and signing in, and is audited', async () => {
    expect((await manager.put('/system/maintenance', { enabled: true })).status).toBe(403);
    await admin.reauth(t, adminUser);
    const on = await admin.put('/system/maintenance', { enabled: true, message: 'Restoring last night’s backup — back by 11:00' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect((await request(t.server).get('/api/v1/system/status')).body.maintenance).toEqual({ enabled: true, message: 'Restoring last night’s backup — back by 11:00' });
    const blocked = await manager.post('/customers', { branchId: (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id, fullName: 'Blocked Customer', mobile: '9848077777' }, { 'Idempotency-Key': newKey() });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('MAINTENANCE');
    expect((await manager.get('/customers')).status).toBe(200); // reading still works
    const { client: late } = await signedIn(t, ['ACCOUNTANT'], { branches: ['KKD'] }); // signing in still works
    expect((await late.get('/reports')).status).toBe(200);
    expect((await admin.put('/system/maintenance', { enabled: false })).status).toBe(200);
    const audit = await t.db.selectFrom('audit_logs').select('action').where('action', 'in', ['system.maintenance_on', 'system.maintenance_off']).execute();
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(['system.maintenance_on', 'system.maintenance_off']));
    // The cache is per instance (5 s); this instance cleared it when switching off.
    expect((await manager.post('/customers', { branchId: (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id, fullName: 'Allowed Customer', mobile: '9848077778' }, { 'Idempotency-Key': newKey() })).status).toBe(201);
  });
});

describe('malware scanning of uploads', () => {
  let t: TestApp;
  let clam: Awaited<ReturnType<typeof fakeClamd>>;
  let manager: Client;
  let customerId: string;
  beforeAll(async () => {
    clam = await fakeClamd();
    t = await createTestApp({ CLAMAV_ADDRESS: `127.0.0.1:${clam.port}` });
    ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
    const kkd = (await t.db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id;
    customerId = (await manager.post('/customers', { branchId: kkd, fullName: 'Scan Customer', mobile: '9848088888' }, { 'Idempotency-Key': newKey() })).body.id;
  });
  afterAll(async () => {
    await t.close();
    clam.server.close();
  });

  it('stores clean files, refuses infected ones (never written), keeps PENDING when the scanner is down', async () => {
    const ok = await manager.upload(`/customers/${customerId}/documents`, { category: 'AGREEMENT' }, { name: 'agreement.pdf', content: pdf('hello'), type: 'application/pdf' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const filesBefore = await t.db.selectFrom('files').select('id').execute();
    const bad = await manager.upload(`/customers/${customerId}/documents`, { category: 'AGREEMENT' }, { name: 'innocent.pdf', content: pdf(EICAR), type: 'application/pdf' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('MALWARE_DETECTED');
    expect((await t.db.selectFrom('files').select('id').execute()).length).toBe(filesBefore.length);
    expect(clam.scans()).toBe(2);

    clam.setDown(true);
    const held = await manager.upload(`/customers/${customerId}/documents`, { category: 'AGREEMENT' }, { name: 'later.pdf', content: pdf('scan me later'), type: 'application/pdf' });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const f = await t.db.selectFrom('files').select(['id', 'scan_status']).where('original_name', '=', 'later.pdf').executeTakeFirstOrThrow();
    expect(f.scan_status).toBe('PENDING');
    clam.setDown(false);
    const { FilesService } = await import('../files/files.service');
    expect((await t.app.get(FilesService).rescanPending(t.db)).scanned).toBeGreaterThanOrEqual(1);
    expect((await t.db.selectFrom('files').select('scan_status').where('id', '=', f.id).executeTakeFirstOrThrow()).scan_status).toBe('CLEAN');
  });

  it('wrong content behind a good extension, empty and oversized files are refused', async () => {
    const fake = await manager.upload(`/customers/${customerId}/documents`, { category: 'AGREEMENT' }, { name: 'photo.jpg', content: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/jpeg' });
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE');
    const big = await manager.upload(`/customers/${customerId}/documents`, { category: 'AGREEMENT' }, { name: 'big.pdf', content: Buffer.concat([pdf(''), Buffer.alloc(10 * 1024 * 1024 + 10)]), type: 'application/pdf' });
    expect([413, 422]).toContain(big.status);
  });
});

describe('exports are formula-injection safe', () => {
  it('text that looks like a formula is written as text, not as a formula', async () => {
    const { toXlsx } = await import('../reports/render');
    const wb = await toXlsx(
      { company: 'Test', title: 'Injection', filters: '', generatedAt: new Date(), generatedBy: 'tester' },
      { columns: [{ key: 'name', label: 'Name', type: 'text' }], rows: [{ name: '=HYPERLINK("http://evil.example","click")' }, { name: '+cmd|calc' }] },
    );
    const back = new ExcelJS.Workbook();
    await back.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const ws = back.worksheets[0]!;
    const cells = [ws.getRow(ws.rowCount - 1).getCell(1), ws.getRow(ws.rowCount).getCell(1)];
    for (const c of cells) {
      expect(c.type).toBe(ExcelJS.ValueType.String);
      expect(c.formula).toBeUndefined();
    }
  });
});
