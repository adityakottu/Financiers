import ExcelJS from 'exceljs';
import { addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { runIntegrityChecks } from '../integrity/checks';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

/** Phase 9: data migration (customers, running loans with E15 opening balances) and the pilot parallel run. */
let t: TestApp;
let br: string;
let admin: Client;
let adminUser: TestUser;
let manager: Client;
let managerUser: TestUser;
let management: Client;
let managementUser: TestUser;
let collector: Client;
const today = istToday();
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n');
const err = (r: { body: { error?: { code: string } } }) => r.body.error?.code;

async function ledger(loanId: string) {
  const r = await sql<{ code: string; b: string }>`
    SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.loan_id = ${loanId} GROUP BY a.code`.execute(t.db);
  return (c: string) => Money.of(r.rows.find((x) => x.code === c)?.b ?? '0');
}
const openingEquity = async () => Money.of((await sql<{ b: string }>`SELECT coalesce(sum(l.credit - l.debit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '3900'`.execute(t.db)).rows[0]!.b);

beforeAll(async () => {
  t = await createTestApp();
  ({ client: admin, user: adminUser } = await signedIn(t, ['SUPER_ADMIN']));
  const b = await admin.post('/branches', { code: 'MIGR', name: 'Migration Town' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  br = b.body.id;
  ({ client: manager, user: managerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['MIGR'] }));
  ({ client: management, user: managementUser } = await signedIn(t, ['MANAGEMENT']));
  ({ client: collector } = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['MIGR'] }));
  const p = await admin.post('/loan-products', {
    code: 'TW-MIG', name: '2W (migrated loans)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '10', rateDefault: '24', rateMax: '36',
    amountMin: '5000', amountMax: '500000', tenureMin: 3, tenureMax: 60, allowedFrequencies: ['MONTHLY', 'WEEKLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
});
afterAll(async () => t.close());

const CUSTOMER_HEADER = ['legacy_no*', 'branch_code*', 'full_name*', 'mobile*', 'relation_type', 'relation_name', 'dob', 'gender', 'village_town', 'pincode', 'whatsapp_opt_in'];

describe('templates', () => {
  it('customers and loans templates are workbooks with the columns and a how-to sheet; no ID-number columns', async () => {
    const f = await manager.download('/imports/templates/customers');
    expect(f.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.bytes as unknown as ArrayBuffer);
    const head = (wb.worksheets[0]!.getRow(1).values as string[]).slice(1);
    expect(head).toContain('legacy_no*');
    expect(head.join(',')).not.toMatch(/aadha|pan/i);
    expect(wb.worksheets[1]!.name).toBe('How to fill');
    expect((await manager.download('/imports/templates/loans')).status).toBe(200);
    expect((await collector.download('/imports/templates/loans')).status).toBe(403);
  });
});

describe('customer import', () => {
  it('validates every row, keeps the errors, and needs a second person with step-up to confirm', async () => {
    const file = csv([
      CUSTOMER_HEADER,
      ['OLD-C-1', 'MIGR', 'Kandula Venkata Rao', '9848100001', 'S/O', 'Kandula Ramaiah', '14/08/1986', 'MALE', 'Pithapuram', '533450', 'N'],
      ['OLD-C-2', 'migr', 'Lakshmi Devi Gorle', '+91 98481 00002', 'W/O', 'Gorle Suresh', '', 'FEMALE', 'Samalkot', '', 'Y'],
      ['OLD-C-3', 'MIGR', 'Bad Mobile', '12345', '', '', '31/02/1990', '', '', '', ''],
      ['OLD-C-1', 'MIGR', 'Duplicate Number', '9848100004', '', '', '', '', '', '', ''],
      ['OLD-C-5', 'NOPE', 'Unknown Branch', '9848100005', '', '', '', '', '', '', 'maybe'],
    ]);
    const up = await manager.upload('/imports', { kind: 'CUSTOMERS' }, { name: 'customers.csv', content: file });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ kind: 'CUSTOMERS', status: 'VALIDATED', rows_total: 5, rows_valid: 2, rows_invalid: 3 });
    const errors = up.body.errors as { row: number; field: string; message: string }[];
    expect(errors.find((e) => e.row === 4 && e.field === 'mobile')).toBeTruthy();
    expect(errors.find((e) => e.row === 4 && e.field === 'dob')).toBeTruthy();
    expect(errors.find((e) => e.row === 5 && e.field === 'legacy_no')?.message).toMatch(/row 2/);
    expect(errors.find((e) => e.row === 6 && e.field === 'branch_code')).toBeTruthy();
    expect(errors.find((e) => e.row === 6 && e.field === 'whatsapp_opt_in')).toBeTruthy();
    // Nothing is created by an upload.
    expect(await t.db.selectFrom('customers').select('id').where('legacy_no', 'like', 'OLD-C-%').execute()).toHaveLength(0);

    const x = await manager.download(`/imports/${up.body.id}/errors.xlsx`);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.bytes as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.rowCount).toBe(3 + errors.length);

    // The uploader cannot confirm; nor can a role without import.confirm.
    expect((await manager.post(`/imports/${up.body.id}/confirm`, {})).status).toBe(403);
    // Errors must be accepted explicitly; step-up is required.
    expect((await management.post(`/imports/${up.body.id}/confirm`, { acceptInvalid: true })).status).toBe(403);
    await management.reauth(t, managementUser);
    expect(err(await management.post(`/imports/${up.body.id}/confirm`, {}))).toBe('HAS_ERRORS');
    const ok = await management.post(`/imports/${up.body.id}/confirm`, { acceptInvalid: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'CONFIRMED', created: 2 });

    const made = await t.db.selectFrom('customers').select(['legacy_no', 'mobile', 'branch_id', 'whatsapp_opt_in', 'kyc_status']).where('legacy_no', 'like', 'OLD-C-%').orderBy('legacy_no').execute();
    expect(made).toEqual([
      { legacy_no: 'OLD-C-1', mobile: '9848100001', branch_id: br, whatsapp_opt_in: false, kyc_status: expect.any(String) },
      { legacy_no: 'OLD-C-2', mobile: '9848100002', branch_id: br, whatsapp_opt_in: true, kyc_status: expect.any(String) },
    ]);
    // Searchable by the old number.
    const s = await manager.get('/search?q=OLD-C-2');
    expect(s.body.matchedBy).toBe('LEGACY_NO');
    expect(s.body.data[0].fullName).toBe('Lakshmi Devi Gorle');

    // The same file cannot be imported twice; a confirmed batch cannot be confirmed again.
    expect(err(await manager.upload('/imports', { kind: 'CUSTOMERS' }, { name: 'again.csv', content: file }))).toBe('ALREADY_IMPORTED');
    expect(err(await management.post(`/imports/${up.body.id}/confirm`, { acceptInvalid: true }))).toBe('INVALID_STATE');
    const audit = await t.db.selectFrom('audit_logs').select('action').where('entity_id', '=', up.body.id).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(['import.confirmed', 'import.uploaded']);
  });

  it('refuses ID-number columns, unknown columns and missing required columns outright', async () => {
    const r = await manager.upload('/imports', { kind: 'CUSTOMERS' }, { name: 'c.csv', content: csv([[...CUSTOMER_HEADER, 'aadhaar_no'], ['OLD-C-9', 'MIGR', 'With Aadhaar', '9848100009', '', '', '', '', '', '', '', '123412341234']]) });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/ID numbers are never bulk-imported/);
    const m = await manager.upload('/imports', { kind: 'CUSTOMERS' }, { name: 'c.csv', content: csv([['legacy_no', 'full_name'], ['OLD-C-9', 'No Mobile']]) });
    expect(m.body.error.message).toMatch(/branch_code/);
  });

  it('the same person cannot upload and confirm, even with every permission', async () => {
    const up = await admin.upload('/imports', { kind: 'CUSTOMERS' }, { name: 'one.csv', content: csv([CUSTOMER_HEADER, ['OLD-C-20', 'MIGR', 'Sole Uploader', '9848100020', '', '', '', '', '', '', '']]) });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await admin.reauth(t, adminUser);
    expect(err(await admin.post(`/imports/${up.body.id}/confirm`, {}))).toBe('SAME_PERSON');
    expect((await manager.post(`/imports/${up.body.id}/cancel`, {})).body.status).toBe('CANCELLED');
    const b = await t.db.selectFrom('import_batches').select(['rows']).where('id', '=', up.body.id).executeTakeFirstOrThrow();
    expect(b.rows).toEqual([]); // rows that will never be imported are not kept
  });
});

const LOAN_HEADER = ['legacy_loan_no*', 'customer_ref*', 'product_code*', 'principal*', 'annual_rate*', 'frequency*', 'installments*', 'disbursement_date*', 'first_due_date*', 'installment_amount', 'installments_paid*', 'part_paid', 'principal_outstanding*', 'penalty_outstanding', 'asset_make', 'asset_model', 'manufacture_year', 'registration_no', 'chassis_no', 'engine_no', 'asset_value'];
const start1 = addMonthsAnchored(today, -9);
const start2 = addMonthsAnchored(today, -6);
const loanRow = (o: { no: string; cust: string; start: string; paid: number; part?: string; outstanding: string; penalty?: string; inst?: string; reg: string }) => [
  o.no, o.cust, 'TW-MIG', '60000', '24', 'MONTHLY', 18, dmy(o.start), dmy(addMonthsAnchored(o.start, 1)), o.inst ?? '', o.paid, o.part ?? '', o.outstanding, o.penalty ?? '', 'Hero', 'Splendor Plus', 2025, o.reg, `MBLMIG${o.reg}`, `HAMIG${o.reg}`, '90000',
];

describe('running-loan import (E15 opening balances)', () => {
  let l1Outstanding = '';
  let migrated: { id: string; legacy_no: string }[] = [];

  it('every row is checked by creating the loan for real and rolling back; mismatches are explained', async () => {
    const before = await t.db.selectFrom('loans').select(sql<string>`count(*)::text`.as('n')).executeTakeFirstOrThrow();
    const up = await manager.upload('/imports', { kind: 'LOANS', cutoverDate: today }, {
      name: 'loans-v1.csv',
      content: csv([
        LOAN_HEADER,
        loanRow({ no: 'OLD-L-1', cust: 'OLD-C-1', start: start1, paid: 7, part: '1000', outstanding: '1', reg: 'AP05MG1001' }),
        loanRow({ no: 'OLD-L-2', cust: 'OLD-C-404', start: start1, paid: 1, outstanding: '50000', reg: 'AP05MG1002' }),
        loanRow({ no: 'OLD-L-3', cust: 'OLD-C-2', start: today, paid: 0, outstanding: '60000', reg: 'AP05MG1003' }),
        loanRow({ no: 'OLD-L-5', cust: 'OLD-C-2', start: start1, paid: 7, outstanding: '1', inst: '4999', reg: 'AP05MG1005' }),
      ]),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ status: 'REJECTED', rows_valid: 0, rows_invalid: 4 });
    const e = up.body.errors as { row: number; field: string; message: string }[];
    const m1 = e.find((x) => x.row === 2)!;
    expect(m1.field).toBe('principal_outstanding');
    l1Outstanding = /principal outstanding is ₹([\d.]+)/.exec(m1.message)![1]!;
    expect(e.find((x) => x.row === 3)).toMatchObject({ field: 'customer_ref' });
    expect(e.find((x) => x.row === 4)).toMatchObject({ field: 'disbursement_date' });
    expect(e.find((x) => x.row === 5)).toMatchObject({ field: 'installment_amount' });
    expect(e.find((x) => x.row === 5)!.message).toMatch(/app's installment is ₹\d+\.\d\d, the old system's ₹4999/);
    // The dry run left nothing behind.
    expect((await t.db.selectFrom('loans').select(sql<string>`count(*)::text`.as('n')).executeTakeFirstOrThrow()).n).toBe(before.n);
    expect(await t.db.selectFrom('assets').select('id').where('registration_no', 'like', 'AP05MG%').execute()).toHaveLength(0);
  });

  it('a clean file is confirmed by a second person: loans active, paid installments marked, E15 posted, everything ties', async () => {
    // Loan 2: 3 of 6 due installments paid, ₹500 penal brought over. Its outstanding comes from the dry run too.
    const probe = await manager.upload('/imports', { kind: 'LOANS', cutoverDate: today }, { name: 'probe.csv', content: csv([LOAN_HEADER, loanRow({ no: 'OLD-L-4', cust: 'OLD-C-2', start: start2, paid: 3, outstanding: '1', penalty: '500', reg: 'AP05MG1004' })]) });
    const l4Outstanding = /principal outstanding is ₹([\d.]+)/.exec(probe.body.errors[0].message)![1]!;
    const equityBefore = await openingEquity();

    const up = await manager.upload('/imports', { kind: 'LOANS', cutoverDate: today }, {
      name: 'loans-v2.csv',
      content: csv([
        LOAN_HEADER,
        loanRow({ no: 'OLD-L-1', cust: 'OLD-C-1', start: start1, paid: 7, part: '1000', outstanding: l1Outstanding, reg: 'AP05MG1001' }),
        loanRow({ no: 'OLD-L-4', cust: 'OLD-C-2', start: start2, paid: 3, outstanding: l4Outstanding, penalty: '500', reg: 'AP05MG1004' }),
      ]),
    });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ status: 'VALIDATED', rows_valid: 2, rows_invalid: 0 });
    const totals = up.body.totals as Record<string, string>;
    expect(Money.of(totals.principal!).eq(Money.of(l1Outstanding).plus(Money.of(l4Outstanding)))).toBe(true);
    expect(totals.penalty).toBe('500.00');

    await management.reauth(t, managementUser);
    const ok = await management.post(`/imports/${up.body.id}/confirm`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.created).toBe(2);
    expect(ok.body.totals).toEqual(totals); // the confirmation produced exactly what was validated

    migrated = await t.db.selectFrom('loans').select(['id', 'legacy_no']).where('legacy_no', 'in', ['OLD-L-1', 'OLD-L-4']).orderBy('legacy_no').execute() as { id: string; legacy_no: string }[];
    expect(migrated).toHaveLength(2);
    const l1 = await t.db.selectFrom('loans').selectAll().where('id', '=', migrated[0]!.id).executeTakeFirstOrThrow();
    expect(l1).toMatchObject({ status: 'ACTIVE', migrated_on: today, created_by: managerUser.id, approved_by: managementUser.id, principal_outstanding: l1Outstanding });
    const inst = await t.db.selectFrom('loan_installments').select(['installment_no', 'status', 'total_paid', 'interest_accrued_at', 'due_date']).where('loan_id', '=', l1.id).orderBy('installment_no').execute();
    expect(inst.slice(0, 7).every((i) => i.status === 'PAID')).toBe(true);
    expect(inst[7]!.total_paid).toBe('1000.00');
    // Interest due by the cut-over is in the opening balance, so it is never accrued again.
    expect(inst.filter((i) => i.due_date <= today).every((i) => i.interest_accrued_at !== null)).toBe(true);
    expect(inst.filter((i) => i.due_date > today && i.installment_no > 8).every((i) => i.interest_accrued_at === null)).toBe(true);

    for (const m of migrated) {
      const loan = await t.db.selectFrom('loans').select(['principal_outstanding', 'interest_outstanding', 'fees_outstanding', 'penalty_outstanding']).where('id', '=', m.id).executeTakeFirstOrThrow();
      const g = await ledger(m.id);
      expect(g('1310').toString()).toBe(loan.principal_outstanding);
      expect(g('1320').toString()).toBe(loan.interest_outstanding);
      expect(g('1340').toString()).toBe(loan.penalty_outstanding);
      const e = await t.db.selectFrom('journal_entries').select(['entry_type', 'value_date']).where('source_type', '=', 'loan').where('source_id', '=', m.id).execute();
      expect(e).toEqual([{ entry_type: 'OPENING', value_date: today }]); // no disbursement entry: the money left years ago, in the old books
    }
    const l4 = await t.db.selectFrom('loans').select(['penalty_outstanding', 'overdue_amount', 'dpd']).where('id', '=', migrated[1]!.id).executeTakeFirstOrThrow();
    expect(l4.penalty_outstanding).toBe('500.00');
    expect(Number(l4.dpd)).toBeGreaterThan(0);
    expect((await openingEquity()).minus(equityBefore).toString()).toBe(totals.total);

    // Found by the old number; the loan page shows it.
    const s = await manager.get('/search?q=OLD-L-4');
    expect(s.body.matchedBy).toBe('LEGACY_NO');
    expect((await manager.get(`/loans/${migrated[1]!.id}`)).body.legacy_no).toBe('OLD-L-4');

    // Business as usual afterwards: a payment and the nightly job keep everything tied.
    const pay = await manager.post(`/loans/${migrated[0]!.id}/payments`, { amount: '500', method: 'CASH', atCounter: true, confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const checks = await runIntegrityChecks(t.db);
    expect(checks.filter((c) => !c.ok).map((c) => `${c.code}: ${c.detail} ${c.samples?.join(' | ')}`)).toEqual([]);

    // A loan file with errors can never be confirmed, even partly.
    const bad = await manager.upload('/imports', { kind: 'LOANS', cutoverDate: today }, { name: 'mixed.csv', content: csv([LOAN_HEADER, loanRow({ no: 'OLD-L-1', cust: 'OLD-C-1', start: start1, paid: 7, outstanding: '1', reg: 'AP05MG1011' }), loanRow({ no: 'OLD-L-6', cust: 'OLD-C-404', start: start1, paid: 1, outstanding: '1', reg: 'AP05MG1006' })]) });
    expect(bad.body.status).toBe('REJECTED');
    expect(bad.body.errors[0].message).toMatch(/already in the app/);
  });

  it('a future cut-over or a missing cut-over is refused', async () => {
    const file = csv([LOAN_HEADER, loanRow({ no: 'OLD-L-7', cust: 'OLD-C-1', start: start1, paid: 1, outstanding: '1', reg: 'AP05MG1007' })]);
    expect((await manager.upload('/imports', { kind: 'LOANS' }, { name: 'x.csv', content: file })).status).toBe(400);
    expect(err(await manager.upload('/imports', { kind: 'LOANS', cutoverDate: addMonthsAnchored(today, 1) }, { name: 'x.csv', content: file }))).toBe('FUTURE_DATE');
  });

  describe('pilot parallel run', () => {
    it('compares the old day sheet with the app loan by loan, and signs off only with explanations and a closed day', async () => {
      const header = ['loan_ref*', 'amount*', 'method*', 'receipt_no', 'collector'];
      const sheet = csv([header, ['OLD-L-1', '500', 'cash', 'BK-1/001', 'Ravi'], ['OLD-L-4', '700', 'CASH', 'BK-1/002', 'Ravi'], ['OLD-L-99', '100', 'UPI', '', '']]);
      expect((await collector.upload('/pilot/days', { branchId: br, date: today }, { name: 'day.csv', content: sheet })).status).toBe(403);
      const bad = await manager.upload('/pilot/days', { branchId: br, date: today }, { name: 'day.csv', content: csv([header, ['OLD-L-1', '-5', 'CARD']]) });
      expect(err(bad)).toBe('INVALID_ROWS');
      expect(bad.body.error.details).toHaveLength(2);

      const up = await manager.upload('/pilot/days', { branchId: br, date: today }, { name: 'day.csv', content: sheet });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      const c = up.body.comparison;
      expect(c.summary).toMatchObject({ oldTotal: '1300.00', appTotal: '500.00', difference: '-800.00', matched: 1, differences: 2, dayClosedInApp: false });
      expect(c.lines.find((l: { legacyNo: string }) => l.legacyNo === 'OLD-L-1').status).toBe('MATCHED');
      expect(c.lines.find((l: { legacyNo: string }) => l.legacyNo === 'OLD-L-4').status).toBe('ONLY_IN_OLD');
      expect(c.unknown).toEqual([expect.objectContaining({ loanRef: 'OLD-L-99' })]);
      expect(c.byMethod.find((m: { method: string }) => m.method === 'CASH')).toMatchObject({ old: '1200.00', app: '500.00' });

      // Another branch's manager cannot see it.
      const other = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] });
      expect((await other.client.get(`/pilot/days/${up.body.id}`)).status).toBe(404);

      expect(err(await manager.post(`/pilot/days/${up.body.id}/sign-off`, {}))).toBe('NOTE_REQUIRED');
      expect(err(await manager.post(`/pilot/days/${up.body.id}/sign-off`, { note: 'OLD-L-4 paid at home after the counter closed; entered in the app next morning. OLD-L-99 is a typo for OLD-L-9.' }))).toBe('DAY_OPEN');
      await t.db.insertInto('business_days').values({ branch_id: br, business_date: today, status: 'CLOSED', closed_by: managementUser.id, closed_at: new Date() }).onConflict((oc) => oc.columns(['branch_id', 'business_date']).doUpdateSet({ status: 'CLOSED' })).execute();
      const s = await manager.post(`/pilot/days/${up.body.id}/sign-off`, { note: 'OLD-L-4 paid at home after the counter closed; entered in the app next morning. OLD-L-99 is a typo for OLD-L-9.' });
      expect(s.status, JSON.stringify(s.body)).toBe(200);

      // Frozen at sign-off, and the day cannot be replaced.
      const day = await manager.get(`/pilot/days/${up.body.id}`);
      expect(day.body.frozen).toBe(true);
      expect(day.body.comparison.summary.differences).toBe(2);
      expect(err(await manager.upload('/pilot/days', { branchId: br, date: today }, { name: 'day.csv', content: sheet }))).toBe('SIGNED_OFF');
      const list = await manager.get(`/pilot/days?branchId=${br}`);
      expect(list.body.exit).toEqual({ signedOffDays: 1, cleanDays: 0, explainedDays: 1, target: 10 });
    });
  });
});
