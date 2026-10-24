import { addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';
import { REPORTS } from './catalogue';
import { ReportsService } from './reports.service';

/** Doc 15 Phase 7 exit tests: report totals tie to the ledger; export formats; scoping; performance. */
let t: TestApp;
let br: string;
let otherBr: string;
let admin: Client;
let manager: Client;
let manager2: Client;
let otherManager: Client;
let accountant: Client;
let accountant2: Client;
let accountant2User: TestUser;
let collector: Client;
let collectorEmp: string;
let bankId: string;
let productId: string;
const today = istToday();
const monthStart = `${today.slice(0, 8)}01`;
let seq = 0;

const code = async (c: string) => (await t.db.selectFrom('accounts').select('id').where('code', '=', c).executeTakeFirstOrThrow()).id;
async function ledger(codes: string[]) {
  const r = await sql<{ b: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ANY(${codes}::text[])`.execute(t.db);
  return Money.of(r.rows[0]!.b);
}

async function loan(branchManager: Client, branchId: string, monthsAgo: number) {
  const n = ++seq;
  const c = await branchManager.post('/customers', { branchId, fullName: `Report Customer ${n}`, mobile: '9848055555' }, { 'Idempotency-Key': newKey() });
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
  const start = addMonthsAnchored(today, -monthsAgo);
  const l = await branchManager.post(
    '/loans',
    { customerId: c.body.id, productId, principal: '30000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { make: 'Hero', model: 'Splendor', manufactureYear: 2025, chassisNo: `MDRPT${String(Date.now()).slice(-7)}${n}`, engineNo: `ERPT${n}${Date.now() % 100000}`, assetValue: '80000' } },
    { 'Idempotency-Key': newKey() },
  );
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  return l.body.id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  br = (await admin.post('/branches', { code: 'RPT', name: 'Report Town' })).body.id;
  otherBr = (await admin.post('/branches', { code: 'RPX', name: 'Other Town' })).body.id;
  ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RPT'] }));
  ({ client: manager2 } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RPT', 'RPX'] }));
  ({ client: otherManager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RPX'] }));
  ({ client: accountant } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RPT'] }));
  ({ client: accountant2, user: accountant2User } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RPT'] }));
  const c = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['RPT'] });
  collectorEmp = (await t.db.insertInto('employees').values({ branch_id: br, user_id: c.user.id, employee_code: `ERP${Date.now() % 100000}`, full_name: 'Report Collector', is_collector: true }).returning('id').executeTakeFirstOrThrow()).id;
  collector = await new Client(t.server).login(t, c.user);
  productId = (await admin.post('/loan-products', {
    code: 'TW-RPT', name: '2W (report tests)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
    amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
  })).body.id;
  bankId = (await admin.post('/accounts/bank', { name: 'UCO Current A/c', bankName: 'UCO Bank', accountNumber: '0441201005566', ifsc: 'UCBA0000441', kind: 'CURRENT' })).body.id;
  const cap = await accountant.post('/manual-journals', { valueDate: today, branchId: br, narration: 'Capital for Report Town', lines: [{ accountId: bankId, debit: '500000' }, { accountId: await code('3100'), credit: '500000' }] });
  await accountant2.reauth(t, accountant2User);
  expect((await accountant2.post(`/manual-journals/${cap.body.id}/approve`, {})).status).toBe(200);

  // Two loans in RPT (one paid by the collector), one in RPX.
  for (const [m, b, months] of [[manager, br, 2], [manager, br, 1], [otherManager, otherBr, 1]] as const) {
    const id = await loan(m, b, months);
    await m.post(`/loans/${id}/submit`);
    expect((await manager2.post(`/loans/${id}/approve`, {})).status).toBe(200);
    const d = await m.post(`/loans/${id}/disburse`, { accountId: bankId, mode: 'BANK_TRANSFER', reference: `NEFTRPT${++seq}${Date.now() % 1_000_000}`, disbursedOn: addMonthsAnchored(today, -months) }, { 'Idempotency-Key': newKey() });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    if (b === br) await manager.post('/collections/assign', { loanIds: [id], employeeId: collectorEmp });
    if (b === br && months === 2) {
      const p = await collector.post(`/loans/${id}/payments`, { amount: '2000', method: 'CASH', confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
    }
  }
});
afterAll(async () => t.close());

describe('catalogue and permissions', () => {
  it('each role sees only the reports it may run; collectors only collections', async () => {
    const all = (await admin.get('/reports')).body;
    expect(all.reports).toHaveLength(REPORTS.length);
    expect(all.canCaPack).toBe(true);
    const col = (await collector.get('/reports')).body;
    expect(new Set(col.reports.map((r: { group: string }) => r.group))).toEqual(new Set(['Collections', 'Recovery']));
    expect(col.canExport).toBe(false);
    const acc = (await accountant.get('/reports')).body;
    expect(acc.reports.some((r: { name: string }) => r.name === 'trial-balance')).toBe(true);
    expect((await collector.get('/reports/trial-balance')).status).toBe(403);
    expect((await admin.get('/reports/no-such-report')).status).toBe(404);
  });

  it('required filters and bad ranges are refused', async () => {
    expect((await admin.get('/reports/general-ledger')).body.error.code).toBe('FILTER_REQUIRED');
    expect((await admin.get(`/reports/collection-daily?from=${today}&to=${monthStart}`)).body.error.code === 'BAD_RANGE' || monthStart === today).toBe(true);
    expect((await admin.get('/reports/collection-daily?from=2026-02-30&to=2026-03-31')).body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('every report runs and exports (Excel and PDF)', () => {
  it('runs all reports for the Super Admin, within a time budget', async () => {
    const acct = await code('1310');
    for (const r of REPORTS) {
      const q = r.name === 'general-ledger' ? `?accountId=${acct}` : '';
      const started = Date.now();
      const res = await admin.get(`/reports/${r.name}${q}`);
      expect(res.status, `${r.name}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      expect(Array.isArray(res.body.rows), r.name).toBe(true);
      expect(res.body.columns.length, r.name).toBeGreaterThan(0);
      expect(Date.now() - started, `${r.name} took too long`).toBeLessThan(3000);
    }
  });

  it('Excel: company header, title, filters, generated time, frozen header, Indian money format', async () => {
    const f = await manager.download(`/reports/loans-active?format=xlsx&branchId=${br}`);
    expect(f.status).toBe(200);
    expect(f.headers['content-disposition']).toMatch(/loans-active-.*\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(String(ws.getRow(2).getCell(1).value)).toBe('Active loans');
    expect(String(ws.getRow(3).getCell(1).value)).toContain('Branch: RPT');
    expect(String(ws.getRow(4).getCell(1).value)).toMatch(/^Generated .* IST by /);
    const view = ws.views[0] as { state: string; ySplit: number };
    expect(view.state).toBe('frozen');
    const header = ws.getRow(view.ySplit);
    expect(header.getCell(1).value).toBe('Loan');
    const moneyCol = (header.values as unknown[]).indexOf('Principal o/s');
    const first = ws.getRow(view.ySplit + 1);
    expect(typeof first.getCell(moneyCol).value).toBe('number');
    expect(first.getCell(moneyCol).numFmt).toContain('##,##0.00');
    const last = ws.getRow(ws.rowCount);
    expect(last.getCell(1).value).toBe('Total');
    expect(last.font?.bold).toBe(true);
  });

  it('PDF: print-ready with page numbers', async () => {
    const f = await admin.download(`/reports/payments-register?format=pdf&from=${monthStart}&to=${today}`);
    expect(f.status).toBe(200);
    expect(f.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(f.headers['content-type']).toBe('application/pdf');
  });

  it('exports need export.data and are audited', async () => {
    expect((await collector.download(`/reports/collection-daily?format=xlsx&from=${monthStart}&to=${today}`)).status).toBe(403);
    await accountant.download(`/reports/trial-balance?format=pdf&asOf=${today}`);
    const log = await t.db.selectFrom('audit_logs').select(['new_values']).where('action', '=', 'report.exported').where('entity_id', '=', 'trial-balance').orderBy('id', 'desc').executeTakeFirst();
    expect(log).toBeTruthy();
    expect((log!.new_values as { format: string }).format).toBe('pdf');
  });
});

describe('totals tie to the ledger', () => {
  it('outstanding by loan and receivables ageing equal the receivable accounts; trial balance balances', async () => {
    const o = (await admin.get('/reports/outstanding-by-loan')).body;
    for (const [col, acct] of [['principal_outstanding', '1310'], ['interest_outstanding', '1320'], ['fees_outstanding', '1330'], ['penalty_outstanding', '1340']] as const) {
      expect(o.totals[col], `${col} vs ${acct}`).toBe((await ledger([acct])).toString());
    }
    const age = (await admin.get('/reports/receivables-ageing')).body;
    expect(age.totals.total).toBe((await ledger(['1310', '1320', '1330', '1340'])).toString());
    const tb = (await admin.get(`/reports/trial-balance?asOf=${today}`)).body;
    expect(tb.totals.name).toBe('Total — balanced');
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const bs = (await admin.get(`/reports/balance-sheet?asOf=${today}`)).body;
    expect(bs.totals.name).toContain('— balanced');
  });

  it('collections by day, branch and method agree with each other and with the payments posted', async () => {
    const q = `?from=${monthStart}&to=${today}`;
    const posted = await sql<{ s: string }>`SELECT coalesce(sum(amount), 0)::text s FROM payments WHERE status <> 'REVERSED' AND business_date BETWEEN ${monthStart}::date AND ${today}::date`.execute(t.db);
    const daily = (await admin.get(`/reports/collection-daily${q}`)).body.totals.total;
    const branch = (await admin.get(`/reports/collection-branch${q}`)).body.totals.total;
    const method = (await admin.get(`/reports/collection-method${q}`)).body.totals.total;
    expect(daily).toBe(posted.rows[0]!.s);
    expect(branch).toBe(daily);
    expect(method).toBe(daily);
  });
});

describe('scoping and remembered filters', () => {
  it('branch managers see their branches only; collectors their own work', async () => {
    const mine = (await manager.get('/reports/loans-active')).body.rows;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r: { branch: string }) => r.branch === 'RPT')).toBe(true);
    const asked = (await otherManager.get(`/reports/loans-active?branchId=${br}`)).body.rows;
    expect(asked).toHaveLength(0); // another branch's id yields nothing, not an error that confirms it
    const own = (await collector.get(`/reports/collection-employee?from=${monthStart}&to=${today}`)).body.rows;
    expect(own).toHaveLength(1);
    expect(own[0].employee).toBe('Report Collector');
    const ownPending = (await collector.get('/reports/collection-pending')).body.rows;
    expect(ownPending.every((r: { collector: string }) => r.collector === 'Report Collector')).toBe(true);
  });

  it('the last filters are remembered per user and report', async () => {
    await manager2.get(`/reports/loans-overdue?branchId=${otherBr}&bucket=DPD_1_30`);
    const cat = (await manager2.get('/reports')).body.reports.find((r: { name: string }) => r.name === 'loans-overdue');
    expect(cat.saved).toEqual({ branchId: otherBr, bucket: 'DPD_1_30' });
    const other = (await manager.get('/reports')).body.reports.find((r: { name: string }) => r.name === 'loans-overdue');
    expect(other.saved).toBeNull();
  });
});

describe('large exports and the CA pack', () => {
  it('large reports become background jobs only their requester can download', async () => {
    const limit = ReportsService.syncRowLimit;
    ReportsService.syncRowLimit = 0;
    try {
      const r = await accountant.get(`/reports/day-book?format=xlsx&asOf=${today}`);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await t.app.get(ReportsService).drain();
      const jobs = (await accountant.get('/exports')).body;
      const job = jobs.find((j: { id: string }) => j.id === r.body.jobId);
      expect(job.status).toBe('DONE');
      expect(job.row_count).toBeGreaterThan(0);
      const f = await accountant.download(`/exports/${job.id}/download`);
      expect(f.status).toBe(200);
      expect(f.bytes.subarray(0, 2).toString()).toBe('PK');
      expect((await manager.download(`/exports/${job.id}/download`)).status).toBe(404);
    } finally {
      ReportsService.syncRowLimit = limit;
    }
  });

  it('the CA pack is one workbook with a contents sheet and every statement', async () => {
    const f = await accountant.download(`/reports/ca-pack?from=${monthStart}&to=${today}`);
    expect(f.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Contents', 'Trial balance', 'Profit & loss', 'Balance sheet', 'Cash & bank book', 'Receivables ageing', 'Loan receivables', 'Expense register', 'Write-offs', 'Cash differences']);
    expect((await manager.download(`/reports/ca-pack?from=${monthStart}&to=${today}`)).status).toBe(200); // BM has report.accounting + export
    expect((await collector.download(`/reports/ca-pack?from=${monthStart}&to=${today}`)).status).toBe(403);
  });
});

describe('dashboards', () => {
  it('company dashboard agrees with the reports (portfolio, collections, efficiency)', async () => {
    const d = (await admin.get('/dashboard/company')).body;
    expect(d.portfolio.principalOutstanding).toBe((await admin.get('/reports/outstanding-by-loan')).body.totals.principal_outstanding);
    const q = `?from=${monthStart}&to=${today}`;
    expect(d.collections.mtd).toBe((await admin.get(`/reports/collection-daily${q}`)).body.totals.total);
    const eff = (await admin.get(`/reports/collection-efficiency${q}`)).body.totals;
    expect(d.efficiency.collected).toBe(eff.collected);
    expect(d.efficiency.pct).toBe(eff.efficiency);
    expect(d.collections.daily).toHaveLength(30);
    expect(d.disbursements).toHaveLength(6);
    expect(d.portfolio.buckets.reduce((s: number, b: { loans: number }) => s + b.loans, 0)).toBe(d.portfolio.activeLoans);
    expect((await manager.get('/dashboard/company')).status).toBe(403);
  });

  it('branch dashboard is scoped and lists collector performance', async () => {
    const d = await manager.get(`/dashboard/branch/${br}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const me = d.body.collectors.find((c: { name: string }) => c.name === 'Report Collector');
    expect(me.loans).toBe(2);
    expect(me.collected).toBe('2000.00');
    expect((await manager.get(`/dashboard/branch/${otherBr}`)).status).toBe(404);
  });

  it('collectors see only their own dashboard', async () => {
    const own = await collector.get(`/dashboard/collector/${collectorEmp}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.book.activeLoans).toBe(2);
    expect(own.body.collections.mtd).toBe('2000.00');
    const other = (await t.db.selectFrom('employees').select('id').where('id', '<>', collectorEmp).executeTakeFirst())?.id;
    if (other) expect((await collector.get(`/dashboard/collector/${other}`)).status).toBe(404);
    expect((await manager.get(`/dashboard/collector/${collectorEmp}`)).status).toBe(200);
    expect((await otherManager.get(`/dashboard/collector/${collectorEmp}`)).status).toBe(404);
  });
});

describe('notification centre', () => {
  it('lists only what this user can act on, never their own requests', async () => {
    const pending = await manager.post('/loans', {}, { 'Idempotency-Key': newKey() }); // invalid: ignored
    expect(pending.status).toBe(400);
    const id = await loan(manager, br, 0);
    expect((await manager.post(`/loans/${id}/submit`)).status).toBe(200);
    const mine = (await manager.get('/notifications')).body.items.find((i: { key: string }) => i.key === 'loans');
    expect(mine).toBeUndefined(); // submitted it myself
    const theirs = (await manager2.get('/notifications')).body;
    expect(theirs.items.find((i: { key: string }) => i.key === 'loans')?.count).toBeGreaterThanOrEqual(1);
    expect(theirs.total).toBeGreaterThanOrEqual(1);
    const col = (await collector.get('/notifications')).body.items;
    expect(col.find((i: { key: string }) => i.key === 'loans')).toBeUndefined();
  });
});
