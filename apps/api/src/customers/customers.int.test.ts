import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchId, Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

let t: TestApp;
let kkd: string;
let manager: Client;
let managerUser: TestUser;
beforeAll(async () => {
  t = await createTestApp();
  kkd = await branchId(t.db, 'KKD');
  ({ client: manager, user: managerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
});
afterAll(async () => t.close());

let panSeq = 1000;
const nextPan = () => `QWERT${panSeq++}K`;

async function create(body: Record<string, unknown>, key = newKey(), client = manager) {
  return client.post('/customers', { branchId: kkd, fullName: 'Suresh Babu', mobile: '9848012345', ...body }, { 'Idempotency-Key': key });
}

describe('create customer', () => {
  it('assigns a formatted customer number and records the timeline', async () => {
    const res = await create({ fullName: 'Venkata Ramana', villageTown: 'Pithapuram', references: [{ name: 'Ramu', relationship: 'Brother', mobile: '9848022222' }] });
    expect(res.status).toBe(201);
    expect(res.body.customerNo).toMatch(/^CUST-\d{4}-\d{6}$/);
    const detail = await manager.get(`/customers/${res.body.id}`);
    expect(detail.headers.etag).toBe('"v1"');
    expect(detail.body).toMatchObject({ fullName: 'Venkata Ramana', villageTown: 'Pithapuram', kycStatus: 'PENDING', branchCode: 'KKD' });
    expect(detail.body.references).toHaveLength(1);
    const timeline = await manager.get(`/customers/${res.body.id}/timeline`);
    expect(timeline.body.data[0]).toMatchObject({ event_type: 'CUSTOMER_CREATED' });
  });

  it('validates Indian formats and rejects unknown fields', async () => {
    const bad = await create({ mobile: '12345', pincode: '0123', unknownField: true });
    expect(bad.status).toBe(400);
    const good = await create({ mobile: '+91 98480 12345', pincode: '533001' });
    expect(good.status).toBe(201);
  });

  it('requires an Idempotency-Key', async () => {
    const res = await manager.post('/customers', { branchId: kkd, fullName: 'No Key', mobile: '9848012345' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('a retried request creates exactly one customer', async () => {
    const key = newKey();
    const body = { fullName: 'Retry Once', mobile: '9848011111' };
    const first = await create(body, key);
    const again = await create(body, key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    const different = await create({ ...body, fullName: 'Something Else' }, key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    const rows = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Retry Once').execute();
    expect(rows).toHaveLength(1);
  });

  it('concurrent double-submits with one key still create exactly one customer', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => create({ fullName: 'Double Tap', mobile: '9848033333' }, key)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const rows = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Double Tap').execute();
    expect(rows).toHaveLength(1);
  });

  it('customer numbers stay unique and gapless under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => create({ fullName: `Numbered ${i}`, mobile: '9848044444' })));
    const seqs = results.map((r) => Number(r.body.customerNo.split('-').pop())).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(20);
    expect(seqs[19]! - seqs[0]!).toBe(19);
  });

  it('a failed create does not consume a number', async () => {
    const before = await create({ fullName: 'Before Gap' });
    const pan = nextPan();
    await create({ fullName: 'Holder', kyc: { pan } });
    const dup = await create({ fullName: 'Duplicate PAN', kyc: { pan } }); // rolls back
    expect(dup.status).toBe(409);
    const after = await create({ fullName: 'After Gap' });
    const n = (r: typeof before) => Number(r.body.customerNo.split('-').pop());
    expect(n(after) - n(before)).toBe(2);
  });
});

describe('KYC protection', () => {
  it('encrypts PAN/DL at rest, keeps only the last 4 of Aadhaar, and masks by default', async () => {
    const pan = nextPan();
    const res = await create({ fullName: 'Kyc Person', kyc: { pan, aadhaarLast4: '4321', drivingLicence: 'AP05 20190012345' } });
    const rows = await t.db.selectFrom('customer_kyc_documents').selectAll().where('customer_id', '=', res.body.id).execute();
    const panRow = rows.find((r) => r.doc_type === 'PAN')!;
    expect(panRow.number_enc!.toString('latin1')).not.toContain(pan);
    expect(panRow.number_last4).toBe(pan.slice(-4));
    const aadhaar = rows.find((r) => r.doc_type === 'AADHAAR')!;
    expect(aadhaar.number_enc).toBeNull();
    expect(aadhaar.number_bidx).toBeNull();
    expect(aadhaar.number_last4).toBe('4321');

    const detail = await manager.get(`/customers/${res.body.id}`);
    const body = JSON.stringify(detail.body);
    expect(body).not.toContain(pan);
    const kyc = Object.fromEntries(detail.body.kyc.map((k: { docType: string; masked: string }) => [k.docType, k.masked]));
    expect(kyc.PAN).toBe(`XXXXXX${pan.slice(-4)}`);
    expect(kyc.AADHAAR).toBe('XXXX XXXX 4321');
    expect(detail.body.kycStatus).toBe('PARTIAL');
  });

  it('rejects a full Aadhaar number', async () => {
    const res = await create({ kyc: { aadhaarLast4: '123456789012' } });
    expect(res.status).toBe(400);
  });

  it('reveal needs kyc.reveal + recent re-authentication, and is audited', async () => {
    const pan = nextPan();
    const res = await create({ fullName: 'Reveal Me', kyc: { pan } });
    const early = await manager.post(`/customers/${res.body.id}/kyc/PAN/reveal`);
    expect(early.body.error.code).toBe('REAUTH_REQUIRED');
    await manager.reauth(t, managerUser);
    const ok = await manager.post(`/customers/${res.body.id}/kyc/PAN/reveal`);
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe(pan);
    const aadhaar = await manager.post(`/customers/${res.body.id}/kyc/AADHAAR/reveal`);
    expect(aadhaar.status).toBe(422);
    const audit = await t.db.selectFrom('audit_logs').select(['user_id', 'new_values']).where('action', '=', 'customer.kyc_revealed').where('entity_id', '=', res.body.id).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.user_id).toBe(managerUser.id);
    expect(JSON.stringify(audit[0]!.new_values)).not.toContain(pan);
  });

  it('management sees masked KYC but cannot reveal it', async () => {
    const res = await create({ fullName: 'Mgmt View', kyc: { pan: nextPan() } });
    const { user, client } = await signedIn(t, ['MANAGEMENT']);
    const d = await client.get(`/customers/${res.body.id}`);
    expect(d.body.kyc[0].masked).toMatch(/^XXXXXX/);
    await client.reauth(t, user);
    expect((await client.post(`/customers/${res.body.id}/kyc/PAN/reveal`)).status).toBe(403);
  });

  it('masks mobiles for roles without customer.view_contact', async () => {
    const res = await create({ fullName: 'Masked Mobile', mobile: '9876500001' });
    const { user } = await signedIn(t, ['ACCOUNTANT'], { branches: ['KKD'] });
    await t.db.insertInto('user_permission_overrides').values({ user_id: user.id, permission_code: 'customer.view_contact', effect: 'DENY' }).execute();
    const c = await new Client(t.server).login(t, user);
    expect((await c.get(`/customers/${res.body.id}`)).body.mobile).toBe('98XXXXX001');
  });

  it('verification moves KYC to VERIFIED; changing a number resets its verification', async () => {
    const res = await create({ fullName: 'Verify Me', kyc: { pan: nextPan(), voterId: 'ABC1234567' } });
    await manager.post(`/customers/${res.body.id}/kyc/verify`, { docType: 'PAN', method: 'Original seen' });
    const v = await manager.post(`/customers/${res.body.id}/kyc/verify`, { docType: 'VOTER_ID', method: 'Original seen' });
    expect(v.body.kycStatus).toBe('VERIFIED');
    const changed = await manager.put(`/customers/${res.body.id}/kyc`, { voterId: 'XYZ7654321' });
    expect(changed.body).toMatchObject({ changed: ['VOTER_ID'], kycStatus: 'PARTIAL' });
  });
});

describe('update customer', () => {
  it('uses optimistic locking and supports clearing fields', async () => {
    const res = await create({ fullName: 'Lock Test', email: 'lock@example.in' });
    const missing = await manager.patch(`/customers/${res.body.id}`, { fullName: 'Xy' });
    expect(missing.status).toBe(428);
    const ok = await manager.patch(`/customers/${res.body.id}`, { fullName: 'Lock Tested', email: null }, { 'If-Match': '"v1"' });
    expect(ok.body.version).toBe(2);
    const stale = await manager.patch(`/customers/${res.body.id}`, { fullName: 'Overwrite' }, { 'If-Match': '"v1"' });
    expect(stale.status).toBe(412);
    const d = await manager.get(`/customers/${res.body.id}`);
    expect(d.body).toMatchObject({ fullName: 'Lock Tested', email: null, version: 2 });
  });

  it('stores text exactly as entered (no HTML interpretation server-side)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await create({ fullName: 'Xss Test', addressLine1: payload });
    const d = await manager.get(`/customers/${res.body.id}`);
    expect(d.headers['content-type']).toMatch(/application\/json/);
    expect(d.body.addressLine1).toBe(payload);
  });
});

describe('search', () => {
  it('finds by name (fuzzy), mobile, customer number, PAN, Aadhaar last 4 and DL', async () => {
    const pan = nextPan();
    const res = await create({
      fullName: 'Chandrasekhar Reddy',
      mobile: '9701234567',
      kyc: { pan, aadhaarLast4: '8765', drivingLicence: 'AP0520200099887' },
    });
    const id = res.body.id;
    const found = async (q: string) => {
      const r = await manager.get(`/search?q=${encodeURIComponent(q)}`);
      expect(r.status).toBe(200);
      return { ids: r.body.data.map((x: { id: string }) => x.id), matchedBy: r.body.matchedBy };
    };
    expect((await found('chandrasekar')).ids).toContain(id); // typo-tolerant
    expect((await found('+91 97012 34567')).matchedBy).toBe('MOBILE');
    expect((await found('9701234567')).ids).toContain(id);
    expect((await found(res.body.customerNo)).ids).toEqual([id]);
    expect((await found(pan.toLowerCase())).ids).toEqual([id]);
    expect((await found('8765')).ids).toContain(id);
    expect((await found('AP05 2020 0099887')).ids).toEqual([id]);
  });

  it('never returns customers from other branches', async () => {
    const { client: rjyManager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RJY'] });
    await create({ fullName: 'Unique Kakinada Person' });
    const r = await rjyManager.get('/search?q=Unique Kakinada');
    expect(r.body.data).toEqual([]);
  });

  it('list endpoint paginates with a cursor', async () => {
    const first = await manager.get('/customers?limit=5');
    expect(first.body.data).toHaveLength(5);
    const second = await manager.get(`/customers?limit=5&cursor=${first.body.nextCursor}`);
    const ids = new Set([...first.body.data, ...second.body.data].map((c: { id: string }) => c.id));
    expect(ids.size).toBe(10);
  });
});

describe('documents', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

  it('accepts real images/PDFs only (by content, not extension) and audits downloads', async () => {
    const c = await create({ fullName: 'Doc Owner' });
    const upload = (buf: Buffer, name: string, category = 'PHOTO') =>
      import('supertest').then(({ default: request }) =>
        request(t.server)
          .post(`/api/v1/customers/${c.body.id}/documents`)
          .set('Cookie', (manager as unknown as { cookieHeader: () => string }).cookieHeader())
          .set('Origin', 'http://localhost:3000')
          .set('X-Forwarded-For', manager.ip)
          .set('X-CSRF-Token', manager.csrf)
          .field('category', category)
          .attach('file', buf, name),
      );

    const fake = await upload(Buffer.from('<script>alert(1)</script>'), 'photo.png');
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE');

    const ok = await upload(png, '../../etc/passwd<>.png');
    expect(ok.status).toBe(201);
    expect(ok.body.file.original_name).toBe('passwd.png');

    const dl = await manager.get(`/customers/${c.body.id}/documents/${ok.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    const audit = await t.db.selectFrom('audit_logs').select('action').where('entity_id', '=', c.body.id).where('action', '=', 'customer.document_viewed').execute();
    expect(audit).toHaveLength(1);
  });
});
