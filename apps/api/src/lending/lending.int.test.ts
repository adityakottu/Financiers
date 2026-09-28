import { addDays, addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { branchId, Client, createTestApp, createUser, newKey, signedIn, TestApp, TestUser } from '../test/harness';

let t: TestApp;
let kkd: string;
let rjy: string;
let admin: Client;
let adminUser: TestUser;
let maker: Client; // branch manager who creates loans
let checker: Client; // second branch manager who approves
let product2W: { id: string };
let productTV: { id: string };
let bankAccountId: string;
const today = istToday();

const twoWheeler = {
  code: 'TW-STD',
  name: '2 Wheeler Standard',
  category: 'TWO_WHEELER',
  interestMethod: 'FLAT',
  rateMin: '12',
  rateDefault: '24',
  rateMax: '30',
  amountMin: '10000',
  amountMax: '300000',
  tenureMin: 3,
  tenureMax: 36,
  allowedFrequencies: ['MONTHLY', 'WEEKLY'],
  roundingUnit: '1',
  feeRules: [
    { code: 'PROCESSING', label: 'Processing fee', basis: 'PCT_OF_PRINCIPAL', value: '2', gstRatePct: '18', mode: 'DEDUCT_FROM_DISBURSAL' },
    { code: 'DOCUMENTATION', label: 'Documentation fee', basis: 'FLAT', value: '500', gstRatePct: '18', mode: 'ADD_TO_FIRST_INSTALLMENT' },
  ],
  penaltyRule: { type: 'FLAT_PER_INSTALLMENT', value: '100', graceDays: 3 },
  maxLtvPct: '90',
  approvalLimit: '150000',
};

const vehicle = (n: number) => ({
  make: 'Hero',
  model: 'Splendor Plus',
  manufactureYear: 2026,
  chassisNo: `MBLHA10AMGHC${String(n).padStart(5, '0')}`,
  engineNo: `HA10EFGHC${String(n).padStart(5, '0')}`,
  registrationNo: `AP05 AB ${String(n % 10000).padStart(4, '0')}`,
  assetValue: '120000',
});

let seq = 0;
async function verifiedCustomer(branch = kkd, client = maker) {
  const c = await client.post('/customers', { branchId: branch, fullName: `Loan Customer ${++seq}`, mobile: '9848099999' }, { 'Idempotency-Key': newKey() });
  expect(c.status).toBe(201);
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
  return c.body.id as string;
}

function loanBody(customerId: string, over: Record<string, unknown> = {}) {
  const n = ++seq;
  return {
    customerId,
    productId: product2W.id,
    principal: '100000',
    annualRate: '24',
    frequency: 'MONTHLY',
    numInstallments: 12,
    disbursementDate: today,
    firstDueDate: addMonthsAnchored(today, 1),
    asset: vehicle(n),
    ...over,
  };
}

async function createLoan(over: Record<string, unknown> = {}, customerId?: string) {
  const res = await maker.post('/loans', loanBody(customerId ?? (await verifiedCustomer()), over), { 'Idempotency-Key': newKey() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; loanNo: string; assetNo: string };
}

async function approved(over: Record<string, unknown> = {}) {
  const loan = await createLoan(over);
  expect((await maker.post(`/loans/${loan.id}/submit`)).status).toBe(200);
  const a = await checker.post(`/loans/${loan.id}/approve`, {});
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return loan;
}

async function disbursed(over: Record<string, unknown> = {}, disbursedOn = today) {
  const loan = await approved(over);
  const r = await maker.post(`/loans/${loan.id}/disburse`, { accountId: bankAccountId, mode: 'BANK_TRANSFER', reference: `UTR${Date.now()}${seq}`, disbursedOn }, { 'Idempotency-Key': newKey() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return loan;
}

beforeAll(async () => {
  t = await createTestApp();
  kkd = await branchId(t.db, 'KKD');
  rjy = await branchId(t.db, 'RJY');
  ({ client: admin, user: adminUser } = await signedIn(t, ['SUPER_ADMIN']));
  ({ client: maker } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  ({ client: checker } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  const p = await admin.post('/loan-products', twoWheeler);
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  product2W = p.body;
  const tv = await admin.post('/loan-products', {
    ...twoWheeler,
    code: 'ELEC-STD',
    name: 'Consumer Electronics',
    category: 'ELECTRONICS',
    interestMethod: 'REDUCING_EMI',
    allowedFrequencies: ['MONTHLY'],
    feeRules: [],
    maxLtvPct: undefined,
    penaltyRule: { type: 'PCT_PA_ON_OVERDUE', value: '36', graceDays: 0 },
  });
  expect(tv.status, JSON.stringify(tv.body)).toBe(201);
  productTV = tv.body;
  const bank = await admin.post('/accounts/bank', { name: 'SBI Current A/c', bankName: 'State Bank of India', accountNumber: '30123456789', ifsc: 'SBIN0000123', kind: 'CURRENT' });
  expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  bankAccountId = bank.body.id;
});
afterAll(async () => t.close());

describe('loan products', () => {
  it('validates product rules', async () => {
    const bad = await admin.post('/loan-products', { ...twoWheeler, code: 'BAD', rateDefault: '40' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('rateDefault');
  });

  it('only product managers can create products', async () => {
    expect((await maker.post('/loan-products', { ...twoWheeler, code: 'NOPE' })).status).toBe(403);
  });

  it('changes create a new version; the old version stays for existing loans', async () => {
    const p = await admin.post('/loan-products', { ...twoWheeler, code: 'TW-VER' });
    const v2 = await admin.put(`/loan-products/${p.body.id}`, { ...twoWheeler, code: 'TW-VER', rateDefault: '22' });
    expect(v2.body.version).toBe(2);
    const old = await t.db.selectFrom('loan_products').select(['is_latest', 'rate_default']).where('id', '=', p.body.id).executeTakeFirstOrThrow();
    expect(old).toMatchObject({ is_latest: false, rate_default: '24.0000' });
    expect((await admin.put(`/loan-products/${p.body.id}`, { ...twoWheeler, code: 'TW-VER' })).body.error.code).toBe('NOT_LATEST');
    const audit = await t.db.selectFrom('audit_logs').select('action').where('entity_id', '=', v2.body.id).executeTakeFirstOrThrow();
    expect(audit.action).toBe('product.versioned');
  });
});

describe('calculator', () => {
  it('product preview reproduces the golden schedule and reports APR', async () => {
    const r = await maker.post('/loans/calculate', { productId: product2W.id, principal: '100000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: '2026-09-05', firstDueDate: '2026-10-05' });
    expect(r.status).toBe(200);
    const s = r.body.schedule;
    expect(s.totals.interest).toBe('24000.00');
    expect(s.totals.netDisbursed).toBe('97640.00'); // 2% processing + 18% GST deducted
    expect(s.rows[0].fees).toBe('590.00'); // documentation fee + GST with installment 1
    expect(r.body.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.body.violations).toEqual([]);
  });

  it('reports product limit violations without failing the preview', async () => {
    const r = await maker.post('/loans/calculate', { productId: product2W.id, principal: '500000', annualRate: '40', frequency: 'DAILY', numInstallments: 12, disbursementDate: today, firstDueDate: addDays(today, 1) });
    expect(r.status).toBe(200);
    expect(r.body.violations.map((v: { path: string }) => v.path).sort()).toEqual(['annualRate', 'frequency', 'principal']);
  });

  it('stand-alone calculator works for any method', async () => {
    const r = await maker.post('/loans/calculator', { method: 'REDUCING_EMI', principal: '100000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: '2026-09-05', firstDueDate: '2026-10-05' });
    expect(r.body.schedule.rows[0].total).toBe('9456.00');
  });

  it('engine refusals come back as 422 with a clear code', async () => {
    const r = await maker.post('/loans/calculator', { method: 'FLAT', principal: '100000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: '2026-09-05', firstDueDate: '2026-09-05' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CALC_FIRST_DUE');
  });
});

describe('creating loans', () => {
  it('creates a draft with number, schedule, asset, timeline and audit — exactly once per key', async () => {
    const customerId = await verifiedCustomer();
    const body = loanBody(customerId);
    const key = newKey();
    const res = await maker.post('/loans', body, { 'Idempotency-Key': key });
    expect(res.status).toBe(201);
    expect(res.body.loanNo).toMatch(/^LN-KKD-\d{4}-\d{6}$/);
    expect(res.body.assetNo).toMatch(/^AST-\d{4}-\d{6}$/);
    const again = await maker.post('/loans', body, { 'Idempotency-Key': key });
    expect(again.body).toEqual(res.body);
    expect(await t.db.selectFrom('loans').select('id').where('customer_id', '=', customerId).execute()).toHaveLength(1);

    const loan = await maker.get(`/loans/${res.body.id}`);
    expect(loan.body).toMatchObject({ status: 'DRAFT', principal: '100000.00', total_payable: '124590.00', net_disbursement: '97640.00' });
    expect(loan.body.installments).toHaveLength(12);
    expect(loan.body.assets[0]).toMatchObject({ status: 'PENDING', registration_no: expect.stringMatching(/^AP05AB\d{4}$/) });
    const events = await t.db.selectFrom('customer_events').select('event_type').where('loan_id', '=', res.body.id).execute();
    expect(events.map((e) => e.event_type)).toContain('LOAN_CREATED');
  });

  it('refuses a stale preview', async () => {
    const customerId = await verifiedCustomer();
    const res = await maker.post('/loans', { ...loanBody(customerId), previewHash: 'a'.repeat(64) }, { 'Idempotency-Key': newKey() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PREVIEW_CHANGED');
  });

  it('enforces product limits and category-specific asset fields', async () => {
    const customerId = await verifiedCustomer();
    const over = await maker.post('/loans', loanBody(customerId, { principal: '500000' }), { 'Idempotency-Key': newKey() });
    expect(over.status).toBe(400);
    const ltv = await maker.post('/loans', loanBody(customerId, { principal: '115000' }), { 'Idempotency-Key': newKey() });
    expect(ltv.body.error.message).toMatch(/at most 90%/);
    const noChassis = await maker.post('/loans', loanBody(customerId, { asset: { make: 'Hero', model: 'X', manufactureYear: 2026, engineNo: 'E123456' } }), { 'Idempotency-Key': newKey() });
    expect(noChassis.status).toBe(400);
    expect(noChassis.body.error.details[0].path).toBe('asset.chassisNo');
  });

  it('one vehicle cannot be financed twice while a loan on it is live', async () => {
    const asset = vehicle(9001);
    await createLoan({ asset });
    const dup = await maker.post('/loans', loanBody(await verifiedCustomer(), { asset: { ...asset, chassisNo: 'OTHERCHASSIS1' } }), { 'Idempotency-Key': newKey() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ASSET_ALREADY_FINANCED');
  });

  it('a cancelled loan frees the vehicle', async () => {
    const asset = vehicle(9002);
    const first = await createLoan({ asset });
    expect((await maker.post(`/loans/${first.id}/cancel`, { reason: 'Customer changed mind' })).status).toBe(200);
    await createLoan({ asset });
  });

  it('other branches cannot see or act on the loan', async () => {
    const loan = await createLoan();
    const { client: rjyManager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RJY'] });
    expect((await rjyManager.get(`/loans/${loan.id}`)).status).toBe(404);
    expect((await rjyManager.post(`/loans/${loan.id}/submit`)).status).toBe(404);
    const custRjy = await verifiedCustomer(rjy, rjyManager);
    expect((await maker.post('/loans', loanBody(custRjy), { 'Idempotency-Key': newKey() })).status).toBe(404);
  });
});

describe('approval', () => {
  it('maker-checker: the creator cannot approve their own loan', async () => {
    const loan = await createLoan();
    await maker.post(`/loans/${loan.id}/submit`);
    const self = await maker.post(`/loans/${loan.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER');
    expect((await checker.post(`/loans/${loan.id}/approve`, {})).status).toBe(200);
  });

  it('KYC must be verified', async () => {
    const customerId = await verifiedCustomer();
    await t.db.updateTable('customers').set({ kyc_status: 'PARTIAL' }).where('id', '=', customerId).execute();
    const loan = await createLoan({}, customerId);
    await maker.post(`/loans/${loan.id}/submit`);
    const r = await checker.post(`/loans/${loan.id}/approve`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('KYC_NOT_VERIFIED');
  });

  it('loans above the product approval limit need Management', async () => {
    const loan = await createLoan({ principal: '160000', asset: { ...vehicle(9100), assetValue: '200000' } });
    await maker.post(`/loans/${loan.id}/submit`);
    const r = await checker.post(`/loans/${loan.id}/approve`, {});
    expect(r.body.error.code).toBe('APPROVAL_LIMIT');
    const { client: mgmt } = await signedIn(t, ['MANAGEMENT']);
    expect((await mgmt.post(`/loans/${loan.id}/approve`, { note: 'Good repayment history' })).status).toBe(200);
  });

  it('rejection needs a reason and releases the asset', async () => {
    const loan = await createLoan();
    await maker.post(`/loans/${loan.id}/submit`);
    expect((await checker.post(`/loans/${loan.id}/reject`, {})).status).toBe(400);
    expect((await checker.post(`/loans/${loan.id}/reject`, { note: 'Income not verified' })).status).toBe(200);
    const a = await t.db.selectFrom('assets').select('status').where('loan_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(a.status).toBe('CANCELLED');
    expect((await checker.post(`/loans/${loan.id}/approve`, {})).body.error.code).toBe('INVALID_STATE');
  });
});

describe('disbursement', () => {
  it('posts one balanced journal: principal receivable, net paid, fee income, GST, fees receivable', async () => {
    const loan = await approved();
    const r = await maker.post(`/loans/${loan.id}/disburse`, { accountId: bankAccountId, mode: 'BANK_TRANSFER', reference: 'UTR123456', disbursedOn: today }, { 'Idempotency-Key': newKey() });
    expect(r.status).toBe(200);
    const j = await admin.get(`/loans/${loan.id}/journal`);
    expect(j.body.data).toHaveLength(1);
    const lines = j.body.data[0].lines.map((l: { code: string; debit: string; credit: string }) => [l.code, l.debit, l.credit]);
    expect(lines).toEqual([
      ['1310', '100000.00', '0.00'],
      [expect.stringMatching(/^1210-/), '0.00', '97640.00'],
      ['4210', '0.00', '2000.00'],
      ['2310', '0.00', '360.00'],
      ['1330', '590.00', '0.00'],
      ['4220', '0.00', '500.00'],
      ['2310', '0.00', '90.00'],
    ]);
    const l = await maker.get(`/loans/${loan.id}`);
    expect(l.body).toMatchObject({ status: 'ACTIVE', principal_outstanding: '100000.00', fees_outstanding: '590.00', interest_outstanding: '0.00', balance_payable: '124590.00', dpd: 0 });
    expect(l.body.assets[0].status).toBe('ACTIVE');
  });

  it('is idempotent and cannot happen twice', async () => {
    const loan = await approved();
    const body = { accountId: bankAccountId, mode: 'BANK_TRANSFER', reference: 'UTR-ONCE', disbursedOn: today };
    const key = newKey();
    const results = await Promise.all([1, 2, 3].map(() => maker.post(`/loans/${loan.id}/disburse`, body, { 'Idempotency-Key': key })));
    expect(results.every((x) => x.status === 200)).toBe(true);
    const again = await maker.post(`/loans/${loan.id}/disburse`, body, { 'Idempotency-Key': newKey() });
    expect(again.body.error.code).toBe('INVALID_STATE');
    const entries = await t.db.selectFrom('journal_entries').select('id').where('source_id', '=', loan.id).where('entry_type', '=', 'DISBURSEMENT').execute();
    expect(entries).toHaveLength(1);
  });

  it('checks the payout account, the date and the permission', async () => {
    const loan = await approved();
    const cash = await t.db.selectFrom('accounts').select('id').where('code', '=', '1110-KKD').executeTakeFirstOrThrow();
    const cashRjy = await t.db.selectFrom('accounts').select('id').where('code', '=', '1110-RJY').executeTakeFirstOrThrow();
    const send = (b: Record<string, unknown>, c = maker) => c.post(`/loans/${loan.id}/disburse`, { accountId: bankAccountId, mode: 'BANK_TRANSFER', reference: 'R1', disbursedOn: today, ...b }, { 'Idempotency-Key': newKey() });
    expect((await send({ accountId: cash.id })).body.error.code).toBe('ACCOUNT_MISMATCH');
    expect((await send({ accountId: cashRjy.id, mode: 'CASH' })).status).toBe(404); // another branch's cash
    expect((await send({ disbursedOn: addDays(today, 1) })).body.error.code).toBe('FUTURE_DATE');
    expect((await send({ mode: 'UPI', reference: undefined })).status).toBe(400);
    const { client: collector } = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    expect((await send({}, collector)).status).toBe(403);
    expect((await send({ accountId: cash.id, mode: 'CASH', reference: undefined })).status).toBe(200);
  });
});

describe('end-of-day jobs', () => {
  it('accrues interest, marks overdue and assesses penal charges — once', async () => {
    // Disbursed 3 months ago: installments 1–2 are past due, 3 is due today.
    const start = addMonthsAnchored(today, -3);
    const loan = await disbursed({ disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1) }, start);
    const run = await admin.post('/jobs/daily', { date: today });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.skipped).toBeUndefined();

    const l = (await maker.get(`/loans/${loan.id}`)).body;
    const [i1, i2, i3, i4] = l.installments;
    expect([i1.status, i2.status, i3.status, i4.status]).toEqual(['OVERDUE', 'OVERDUE', 'DUE_TODAY', 'UPCOMING']);
    expect(i1.penalty_due).toBe('100.00'); // flat ₹100 once past 3-day grace
    expect(i2.penalty_due).toBe('100.00');
    expect(i3.penalty_due).toBe('0.00');
    expect(l.interest_outstanding).toBe('6000.00'); // 3 × ₹2,000 accrued
    expect(l.penalty_outstanding).toBe('200.00');
    expect(l.dpd).toBeGreaterThan(28);
    expect(Number(l.overdue_amount)).toBe(10333 + 590 + 100 + 10333 + 100);

    const again = await admin.post('/jobs/daily', { date: today });
    expect(again.body.skipped).toBe(true);
    const penalties = await t.db.selectFrom('loan_charges').select('id').where('loan_id', '=', loan.id).where('charge_type', '=', 'PENALTY').execute();
    expect(penalties).toHaveLength(2);
    const accruals = await t.db.selectFrom('journal_entries').select('id').where('source_id', '=', loan.id).where('entry_type', '=', 'ACCRUAL').execute();
    expect(accruals).toHaveLength(1);
  });

  it('daily percentage penal charges accrue once per day across catch-up runs', async () => {
    const start = addMonthsAnchored(today, -2);
    const loan = await disbursed({ productId: productTV.id, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { description: 'LED TV', make: 'Samsung', model: 'UA43', serialNo: `SN${Date.now()}` } }, start);
    // Days before today were already closed for earlier tests' loans; force-run three fresh past dates for this loan.
    await t.db.deleteFrom('job_runs').execute();
    for (const d of [addDays(today, -3), addDays(today, -2), addDays(today, -1)]) {
      expect((await admin.post('/jobs/daily', { date: d })).status).toBe(200);
    }
    const charges = await t.db.selectFrom('loan_charges').select(['assessed_on', 'amount']).where('loan_id', '=', loan.id).where('charge_type', '=', 'PENALTY').orderBy('assessed_on').execute();
    expect(charges.map((c) => c.assessed_on)).toEqual([addDays(today, -3), addDays(today, -2), addDays(today, -1)]);
    expect(new Set(charges.map((c) => c.amount)).size).toBe(1); // same overdue amount → same daily charge
  });

  it('refuses future dates and non-admins', async () => {
    expect((await admin.post('/jobs/daily', { date: addDays(today, 1) })).status).toBe(422);
    expect((await maker.post('/jobs/daily', {})).status).toBe(403);
  });
});

describe('statements', () => {
  it('statement comes from the ledger and matches the loan balances', async () => {
    const start = addMonthsAnchored(today, -2);
    const loan = await disbursed({ disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1) }, start);
    await t.db.deleteFrom('job_runs').where('business_date', '=', today).execute();
    await admin.post('/jobs/daily', { date: today });
    const s = (await maker.get(`/loans/${loan.id}/statement`)).body;
    const l = (await maker.get(`/loans/${loan.id}`)).body;
    const expected = Money.sum([l.principal_outstanding, l.interest_outstanding, l.fees_outstanding, l.penalty_outstanding].map((x: string) => Money.of(x)));
    expect(s.summary.outstanding).toBe(expected.toString());
    expect(s.summary.principalDisbursed).toBe('100000.00');
    expect(s.lines[0].type).toBe('Disbursement');
    expect(s.schedule).toHaveLength(12);
  });

  it('exports Excel and PDF', async () => {
    const loan = await disbursed();
    const x = await maker.download(`/loans/${loan.id}/statement?format=xlsx`);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect(x.bytes.subarray(0, 2).toString()).toBe('PK');
    const p = await maker.download(`/loans/${loan.id}/statement?format=pdf`);
    expect(p.headers['content-type']).toBe('application/pdf');
    expect(p.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('search, scope and dashboard', () => {
  it('finds loans by number, registration and chassis', async () => {
    const asset = vehicle(9300);
    const loan = await createLoan({ asset });
    const hit = async (q: string) => (await maker.get(`/search?q=${encodeURIComponent(q)}`)).body;
    expect((await hit(loan.loanNo)).data[0]).toMatchObject({ type: 'loan', id: loan.id });
    expect((await hit('ap-05-ab-9300')).matchedBy).toBe('REGISTRATION');
    expect((await hit('ap05ab9300')).data[0].id).toBe(loan.id);
    expect((await hit(asset.chassisNo.toLowerCase())).data[0].id).toBe(loan.id);
  });

  it('customer results show the active loan', async () => {
    const customerId = await verifiedCustomer();
    await t.db.updateTable('customers').set({ full_name: 'Venkateswara Distinct' }).where('id', '=', customerId).execute();
    const loan = await createLoan({}, customerId);
    const r = await maker.get('/search?q=Venkateswara Distinct');
    expect(r.body.data[0].activeLoan).toMatchObject({ id: loan.id, status: 'DRAFT' });
  });

  it('collectors see only loans (and customers) assigned to them', async () => {
    const loan = await disbursed();
    const collectorUser = await createUser(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
    const emp = await t.db.insertInto('employees').values({ branch_id: kkd, user_id: collectorUser.id, employee_code: `C${Date.now()}`.slice(0, 20), full_name: 'Field Collector', is_collector: true }).returning('id').executeTakeFirstOrThrow();
    const collector = await new Client(t.server).login(t, collectorUser);
    expect((await collector.get(`/loans/${loan.id}`)).status).toBe(404);
    await t.db.updateTable('loans').set({ assigned_collector_id: emp.id }).where('id', '=', loan.id).execute();
    expect((await collector.get(`/loans/${loan.id}`)).status).toBe(200);
    expect((await collector.get('/loans')).body.data.map((x: { id: string }) => x.id)).toEqual([loan.id]);
    const l = await t.db.selectFrom('loans').select('customer_id').where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect((await collector.get(`/customers/${l.customer_id}`)).status).toBe(200);
  });

  it('dashboard shows real loan figures', async () => {
    const d = await admin.get('/dashboard/summary');
    expect(d.body.loans.active).toBeGreaterThan(0);
    expect(Number(d.body.loans.principalOutstanding)).toBeGreaterThan(0);
    expect(d.body.loans.byCategory.length).toBeGreaterThan(0);
  });
});

describe('ledger integrity (runs last)', () => {
  it('the trial balance balances', async () => {
    const r = await admin.get('/accounts');
    expect(r.body.totals.balanced).toBe(true);
    const loanReceivable = r.body.data.find((a: { code: string }) => a.code === '1310');
    expect(Number(loanReceivable.balance)).toBeGreaterThan(0);
  });

  it('every loan’s receivable in the ledger equals its outstanding balances', async () => {
    const rows = await sql<{ loan_no: string; code: string; ledger: string; loan_value: string }>`
      SELECT l.loan_no, a.code,
        coalesce(sum(jl.debit - jl.credit), 0)::text AS ledger,
        (CASE a.code WHEN '1310' THEN l.principal_outstanding WHEN '1320' THEN l.interest_outstanding
                     WHEN '1330' THEN l.fees_outstanding ELSE l.penalty_outstanding END)::text AS loan_value
      FROM loans l
      CROSS JOIN accounts a
      LEFT JOIN journal_lines jl ON jl.loan_id = l.id AND jl.account_id = a.id
      WHERE l.status = 'ACTIVE' AND a.code IN ('1310', '1320', '1330', '1340')
      GROUP BY l.id, a.code`.execute(t.db);
    expect(rows.rows.length).toBeGreaterThan(0);
    const mismatches = rows.rows.filter((r) => !Money.of(r.ledger).eq(Money.of(r.loan_value)));
    expect(mismatches).toEqual([]);
  });

  it('journals cannot be changed, even directly in the database', async () => {
    await expect(sql`UPDATE journal_lines SET debit = debit + 1 WHERE debit > 0`.execute(t.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM journal_entries`.execute(t.db)).rejects.toThrow(/append-only/);
  });

  it('account ledger shows running balances', async () => {
    const acc = await t.db.selectFrom('accounts').select('id').where('code', '=', '1310').executeTakeFirstOrThrow();
    const r = await admin.get(`/accounts/${acc.id}/ledger?from=${addMonthsAnchored(today, -6)}&to=${today}`);
    expect(r.status).toBe(200);
    const last = r.body.lines[r.body.lines.length - 1];
    expect(last.balance).toBe(r.body.closingBalance);
    expect(adminUser.id).toBeTruthy();
  });
});
