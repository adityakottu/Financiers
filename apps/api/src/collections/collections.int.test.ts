import { addDays, addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { LedgerService } from '../ledger/ledger.service';
import { accrueInterest } from '../lending/dues';
import { MessagingService } from '../messaging/messaging.service';
import { MetaWhatsAppProvider, Msg91Provider, ProviderError } from '../messaging/providers';
import { branchId, Client, createTestApp, newKey, ORIGIN, signedIn, TestApp, TestUser } from '../test/harness';
import { CollectionsService } from './collections.service';
import { PaymentsService } from './payments.service';
import { rupeesInWords } from './receipt';

let t: TestApp;
let kkd: string;
let rjy: string;
let admin: Client;
let manager: Client; // KKD branch manager: creates and disburses loans, assigns collectors
let managerUser: TestUser;
let checker: Client; // second KKD manager: approves loans and reversals
let checkerUser: TestUser;
let collector: Client;
let collectorEmp: string;
let otherCollector: Client;
let otherCollectorEmp: string;
let rjyCollectorEmp: string;
let productId: string;
let bankAccountId: string;
const today = istToday();
let seq = 0;

const product = {
  code: 'TW-COL',
  name: '2 Wheeler (collections tests)',
  category: 'TWO_WHEELER',
  interestMethod: 'FLAT',
  rateMin: '12',
  rateDefault: '24',
  rateMax: '30',
  amountMin: '5000',
  amountMax: '300000',
  tenureMin: 3,
  tenureMax: 36,
  allowedFrequencies: ['MONTHLY', 'WEEKLY'],
  roundingUnit: '1',
  feeRules: [],
  penaltyRule: { type: 'FLAT_PER_INSTALLMENT', value: '100', graceDays: 3 },
  approvalLimit: '250000',
};

async function employee(userId: string, branch: string, collectorFlag = true) {
  const e = await t.db
    .insertInto('employees')
    .values({ branch_id: branch, user_id: userId, employee_code: `E${Date.now() % 1_000_000}${++seq}`, full_name: `Collector ${seq}`, is_collector: collectorFlag })
    .returning('id')
    .executeTakeFirstOrThrow();
  return e.id;
}

async function customer(whatsapp = false) {
  const c = await manager.post('/customers', { branchId: kkd, fullName: `Payer ${++seq}`, mobile: '9848012345', whatsappOptIn: whatsapp }, { 'Idempotency-Key': newKey() });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED', whatsapp_opt_in: whatsapp, whatsapp_opt_in_at: whatsapp ? new Date() : null }).where('id', '=', c.body.id).execute();
  return c.body.id as string;
}

/**
 * ₹12,000 at 24% flat, 12 monthly installments of ₹1,240 (₹1,000 principal + ₹240 interest).
 * Disbursed two months ago, so installment 1 is overdue and installment 2 falls due about today.
 */
async function activeLoan(opts: { whatsapp?: boolean; assign?: string | null; start?: string; over?: Record<string, unknown> } = {}) {
  const start = opts.start ?? addMonthsAnchored(today, -2);
  const n = ++seq;
  const create = await manager.post(
    '/loans',
    {
      customerId: await customer(opts.whatsapp),
      productId,
      principal: '12000',
      annualRate: '24',
      frequency: 'MONTHLY',
      numInstallments: 12,
      disbursementDate: start,
      firstDueDate: addMonthsAnchored(start, 1),
      asset: { make: 'Honda', model: 'Shine', manufactureYear: 2026, chassisNo: `ME4COL${String(Date.now()).slice(-6)}${String(n).padStart(4, '0')}`, engineNo: `JCCOL${n}${Date.now() % 100000}`, assetValue: '90000' },
      ...(opts.over ?? {}),
    },
    { 'Idempotency-Key': newKey() },
  );
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const id = create.body.id as string;
  expect((await manager.post(`/loans/${id}/submit`)).status).toBe(200);
  expect((await checker.post(`/loans/${id}/approve`, {})).status).toBe(200);
  const d = await manager.post(`/loans/${id}/disburse`, { accountId: bankAccountId, mode: 'BANK_TRANSFER', reference: `DISB${Date.now()}${n}`, disbursedOn: start }, { 'Idempotency-Key': newKey() });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  if (opts.assign !== null) {
    const a = await manager.post('/collections/assign', { loanIds: [id], employeeId: opts.assign ?? collectorEmp });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
  }
  return { id, loanNo: create.body.loanNo as string };
}

const pay = (client: Client, loanId: string, body: Record<string, unknown>, key = newKey()) => client.post(`/loans/${loanId}/payments`, { notify: true, ...body }, { 'Idempotency-Key': key });

async function installments(loanId: string) {
  return t.db.selectFrom('loan_installments').selectAll().where('loan_id', '=', loanId).orderBy('installment_no').execute();
}

/** The ledger must agree with the loan: per-loan control-account balances = the loan's own figures. */
async function expectLedgerTiesOut(loanId: string) {
  const r = await sql<{ code: string; bal: string }>`
    SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::text bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.loan_id = ${loanId} AND a.code IN ('1310', '1320', '1330', '1340', '2200') GROUP BY a.code`.execute(t.db);
  const bal = (c: string) => Money.of(r.rows.find((x) => x.code === c)?.bal ?? '0');
  const loan = await t.db.selectFrom('loans').selectAll().where('id', '=', loanId).executeTakeFirstOrThrow();
  expect(bal('1310').toString(), 'principal').toBe(Money.of(loan.principal_outstanding).toString());
  expect(bal('1320').toString(), 'accrued interest').toBe(Money.of(loan.interest_outstanding).toString());
  expect(bal('1340').toString(), 'penal').toBe(Money.of(loan.penalty_outstanding).toString());
  expect(Money.zero().minus(bal('2200')).toString(), 'advance').toBe(Money.of(loan.advance_balance).toString());
  const tb = await sql<{ d: string; c: string }>`SELECT sum(debit)::text d, sum(credit)::text c FROM journal_lines`.execute(t.db);
  expect(tb.rows[0]!.d).toBe(tb.rows[0]!.c);
}

beforeAll(async () => {
  t = await createTestApp();
  kkd = await branchId(t.db, 'KKD');
  rjy = await branchId(t.db, 'RJY');
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  ({ client: manager, user: managerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  ({ client: checker, user: checkerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  const c1 = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
  collectorEmp = await employee(c1.user.id, kkd);
  collector = await new Client(t.server).login(t, c1.user); // re-login so the session sees the employee link
  const c2 = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
  otherCollectorEmp = await employee(c2.user.id, kkd);
  otherCollector = c2.client;
  const c3 = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['RJY'] });
  rjyCollectorEmp = await employee(c3.user.id, rjy);
  await employee(managerUser.id, kkd, false);
  const p = await admin.post('/loan-products', product);
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  productId = p.body.id;
  const bank = await admin.post('/accounts/bank', { name: 'HDFC Collections A/c', bankName: 'HDFC Bank', accountNumber: '50200012345678', ifsc: 'HDFC0001234', kind: 'CURRENT' });
  expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  bankAccountId = bank.body.id;
});
afterAll(async () => t.close());

describe('assignment', () => {
  it('assigns loans to a collector of the same branch, with history', async () => {
    const loan = await activeLoan({ assign: null });
    const r = await manager.post('/collections/assign', { loanIds: [loan.id], employeeId: collectorEmp, reason: 'Area: Gandhi Nagar' });
    expect(r.body).toEqual({ changed: 1 });
    const again = await manager.post('/collections/assign', { loanIds: [loan.id], employeeId: otherCollectorEmp });
    expect(again.body).toEqual({ changed: 1 });
    const hist = (await manager.get(`/loans/${loan.id}/collections`)).body.assignments;
    expect(hist).toHaveLength(2);
    expect(hist.filter((a: { to_at: string | null }) => a.to_at === null)).toHaveLength(1);
  });

  it('refuses another branch’s collector, non-collectors, and people without the permission', async () => {
    const loan = await activeLoan({ assign: null });
    expect((await manager.post('/collections/assign', { loanIds: [loan.id], employeeId: rjyCollectorEmp })).status).toBe(404); // out of scope
    const r = await admin.post('/collections/assign', { loanIds: [loan.id], employeeId: rjyCollectorEmp });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BRANCH_MISMATCH');
    const mgrEmp = (await t.db.selectFrom('employees').select('id').where('user_id', '=', managerUser.id).executeTakeFirstOrThrow()).id;
    expect((await manager.post('/collections/assign', { loanIds: [loan.id], employeeId: mgrEmp })).body.error.code).toBe('NOT_A_COLLECTOR');
    expect((await collector.post('/collections/assign', { loanIds: [loan.id], employeeId: collectorEmp })).status).toBe(403);
  });

  it('a collector sees only assigned loans, and cannot collect on others', async () => {
    const mine = await activeLoan();
    const theirs = await activeLoan({ assign: otherCollectorEmp });
    const day = (await collector.get('/collections/my-day')).body;
    expect(day.cards.some((c: { id: string }) => c.id === mine.id)).toBe(true);
    expect(day.cards.some((c: { id: string }) => c.id === theirs.id)).toBe(false);
    expect((await pay(collector, theirs.id, { amount: '100', method: 'CASH' })).status).toBe(404);
  });
});

describe('lists', () => {
  it('installments due / overdue, and loans by collector', async () => {
    const loan = await activeLoan({ assign: null });
    const overdue = (await manager.get('/collections/installments?view=OVERDUE')).body;
    expect(overdue.data.some((r: { loan_id: string; collector_name: string | null }) => r.loan_id === loan.id && r.collector_name === null)).toBe(true);
    expect(Money.of(overdue.total).isPositive()).toBe(true);
    const none = (await manager.get('/loans?status=ACTIVE&collector=none')).body.data;
    expect(none.some((l: { id: string }) => l.id === loan.id)).toBe(true);
    await manager.post('/collections/assign', { loanIds: [loan.id], employeeId: collectorEmp });
    const mine = (await manager.get(`/loans?collector=${collectorEmp}`)).body.data;
    expect(mine.find((l: { id: string }) => l.id === loan.id).collector_name).toMatch(/^Collector/);
    const masked = (await collector.get('/collections/installments?view=OVERDUE')).body.data;
    expect(masked.every((r: { collector_name: string }) => r.collector_name !== null)).toBe(true); // collectors see only their loans
  });
});

describe('recording payments', () => {
  it('previews, then records cash: allocation, installments, journal, receipt, balances', async () => {
    const loan = await activeLoan();
    const before = await installments(loan.id);
    const due = before.filter((i) => i.due_date <= today);
    expect(due.length).toBeGreaterThanOrEqual(1);

    const pv = await collector.post(`/loans/${loan.id}/payments/preview`, { amount: '2000' });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.lines[0]).toMatchObject({ installmentNo: 1, component: 'INTEREST', amount: '240.00' });
    expect(pv.body.installmentsCleared).toEqual([1]);
    expect(await t.db.selectFrom('payments').select('id').where('loan_id', '=', loan.id).execute()).toHaveLength(0); // preview writes nothing

    const r = await pay(collector, loan.id, { amount: '2000', method: 'CASH', location: 'Gandhi Nagar' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.paymentNo).toMatch(/^PAY-\d{4}-\d{6}$/);
    expect(r.body.receiptNo).toMatch(/^REC-KKD-\d{4}-\d{6}$/);
    expect(r.body.installmentsCleared).toEqual([1]);
    expect(r.body.components.interest).toBe(due.length >= 2 ? '480.00' : '240.00');

    const after = await installments(loan.id);
    expect(after[0]).toMatchObject({ status: 'PAID', principal_paid: '1000.00', interest_paid: '240.00' });
    expect(after[0]!.paid_on).toBe(today);

    const p = await t.db.selectFrom('payments').selectAll().where('id', '=', r.body.id).executeTakeFirstOrThrow();
    const lines = await t.db
      .selectFrom('journal_lines as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['a.code', 'a.subtype', 'l.debit', 'l.credit', 'l.employee_id'])
      .where('l.entry_id', '=', p.journal_entry_id!)
      .orderBy('l.line_no')
      .execute();
    expect(lines[0]).toMatchObject({ subtype: 'EMPLOYEE_CASH', debit: '2000.00', employee_id: collectorEmp });
    expect(Money.sum(lines.map((l) => Money.of(l.credit))).toString()).toBe('2000.00');
    await expectLedgerTiesOut(loan.id);

    const detail = (await manager.get(`/payments/${r.body.id}`)).body;
    expect(detail.allocations.length).toBeGreaterThan(1);
    expect(detail.receipt.status).toBe('ISSUED');
    expect(detail.collectedByName).toMatch(/^Collector/);
  });

  it('UPI goes to the branch UPI clearing account; a bank transfer to the chosen bank account', async () => {
    const loan = await activeLoan();
    const upi = await pay(collector, loan.id, { amount: '500', method: 'UPI', reference: `UPI${Date.now()}` });
    expect(upi.status, JSON.stringify(upi.body)).toBe(201);
    const bt = await pay(manager, loan.id, { amount: '700', method: 'BANK_TRANSFER', reference: `UTR${Date.now()}`, accountId: bankAccountId });
    expect(bt.status, JSON.stringify(bt.body)).toBe(201);
    const codes = await t.db
      .selectFrom('payments as p')
      .innerJoin('accounts as a', 'a.id', 'p.debit_account_id')
      .select(['p.method', 'a.code'])
      .where('p.loan_id', '=', loan.id)
      .orderBy('p.received_at')
      .execute();
    expect(codes).toEqual([
      { method: 'UPI', code: '1250-KKD' },
      { method: 'BANK_TRANSFER', code: expect.stringMatching(/^1210-/) },
    ]);
    expect((await pay(manager, loan.id, { amount: '700', method: 'BANK_TRANSFER', reference: 'UTR1' })).status).toBe(400); // account required
  });

  it('validates: positive amount, reference for non-cash, cheque details', async () => {
    const loan = await activeLoan();
    for (const body of [{ amount: '0', method: 'CASH' }, { amount: '-5', method: 'CASH' }, { amount: '10.555', method: 'CASH' }, { amount: '100', method: 'UPI' }, { amount: '100', method: 'CHEQUE', reference: '123456' }]) {
      const r = await pay(collector, loan.id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    const chq = await pay(manager, loan.id, { amount: '1240', method: 'CHEQUE', reference: '004512', chequeBank: 'SBI Kakinada', chequeDate: today });
    expect(chq.status, JSON.stringify(chq.body)).toBe(201);
    const p = await t.db.selectFrom('payments').select(['cheque_status', 'debit_account_id']).where('id', '=', chq.body.id).executeTakeFirstOrThrow();
    expect(p.cheque_status).toBe('RECEIVED');
  });

  it('cash in the field needs an employee record; counter cash goes to branch cash', async () => {
    const loan = await activeLoan();
    const r = await pay(checker, loan.id, { amount: '300', method: 'CASH' }); // checker has no employee record
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('NOT_AN_EMPLOYEE');
    const c = await pay(checker, loan.id, { amount: '300', method: 'CASH', atCounter: true });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const a = await t.db.selectFrom('payments as p').innerJoin('accounts as a', 'a.id', 'p.debit_account_id').select('a.code').where('p.id', '=', c.body.id).executeTakeFirstOrThrow();
    expect(a.code).toBe('1110-KKD');
  });

  it('paying more than is due holds the excess as customer advance (not as early income)', async () => {
    const loan = await activeLoan();
    const due = (await installments(loan.id)).filter((i) => i.due_date <= today).length * 1240;
    const r = await pay(collector, loan.id, { amount: String(due + 500), method: 'CASH' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.components.advance).toBe('500.00');
    const l = await t.db.selectFrom('loans').select(['advance_balance', 'overdue_amount']).where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect(l.advance_balance).toBe('500.00');
    expect(l.overdue_amount).toBe('0.00');
    await expectLedgerTiesOut(loan.id);
  });

  it('refuses more than the full balance, and closes the loan on exact full settlement', async () => {
    const loan = await activeLoan();
    const over = await pay(collector, loan.id, { amount: '20000', method: 'CASH' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('EXCEEDS_BALANCE');
    expect(over.body.error.details.maxAmount).toBe('14880.00');
    const r = await pay(collector, loan.id, { amount: '14880', method: 'CASH' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ fullSettlement: true, loanClosed: true, balanceAfter: '0.00' });
    const l = await t.db.selectFrom('loans').select(['status', 'closed_at', 'principal_outstanding', 'interest_outstanding']).where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('CLOSED');
    expect(l.principal_outstanding).toBe('0.00');
    const closure = await t.db.selectFrom('loan_closures').selectAll().where('loan_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(closure).toMatchObject({ status: 'CLOSED', principal_paid: '12000.00', interest_paid: '2880.00' });
    const asset = await t.db.selectFrom('assets').select('status').where('loan_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(asset.status).toBe('CLOSED');
    // All remaining interest was recognised on settlement, so nothing is left accrued or receivable.
    await expectLedgerTiesOut(loan.id);
    expect((await pay(collector, loan.id, { amount: '10', method: 'CASH' })).body.error.code).toBe('LOAN_NOT_ACTIVE');
  });

  it('a product with excess handling REJECT refuses overpayment', async () => {
    const p = await admin.post('/loan-products', { ...product, code: 'TW-NOADV', allocationRule: { mode: 'INSTALLMENT_WISE', order: ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'], excessHandling: 'REJECT' } });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const loan = await activeLoan({ over: { productId: p.body.id } });
    const due = (await installments(loan.id)).filter((i) => i.due_date <= today).length * 1240;
    const r = await pay(collector, loan.id, { amount: String(due + 1), method: 'CASH' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('OVERPAYMENT_NOT_ALLOWED');
  });
});

describe('duplicate protection', () => {
  it('the same Idempotency-Key records once, even when sent concurrently', async () => {
    const loan = await activeLoan();
    const key = newKey();
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay(collector, loan.id, { amount: '1240', method: 'CASH' }, key)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true').length).toBe(4);
    expect(await t.db.selectFrom('payments').select('id').where('loan_id', '=', loan.id).execute()).toHaveLength(1);
  });

  it('warns about the same amount on the same loan within minutes, unless confirmed', async () => {
    const loan = await activeLoan();
    expect((await pay(collector, loan.id, { amount: '600', method: 'CASH' })).status).toBe(201);
    const dup = await pay(collector, loan.id, { amount: '600', method: 'CASH' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.error.details.paymentNo).toMatch(/^PAY-/);
    expect((await pay(collector, loan.id, { amount: '600', method: 'CASH', confirmDuplicate: true })).status).toBe(201);
  });

  it('a UTR / UPI transaction id can be used only once, even under a race', async () => {
    const a = await activeLoan();
    const b = await activeLoan();
    const utr = `UTR${Date.now()}RACE`;
    const rs = await Promise.all([
      pay(manager, a.id, { amount: '400', method: 'BANK_TRANSFER', reference: utr, accountId: bankAccountId }),
      pay(manager, b.id, { amount: '400', method: 'BANK_TRANSFER', reference: utr, accountId: bankAccountId }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error.code).toBe('DUPLICATE_REFERENCE');
    const lower = await pay(manager, b.id, { amount: '400', method: 'BANK_TRANSFER', reference: utr.toLowerCase(), accountId: bankAccountId });
    expect(lower.status).toBe(409); // case-insensitive
  });

  it('concurrent different payments on one loan never over-settle an installment', async () => {
    const loan = await activeLoan();
    const rs = await Promise.all(['700', '701', '702', '703'].map((amt) => pay(collector, loan.id, { amount: amt, method: 'CASH' })));
    expect(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.body))).toBe(true);
    const inst = await installments(loan.id);
    for (const i of inst) expect(Money.of(i.total_paid ?? '0').lte(Money.of(i.total_due ?? '0'))).toBe(true);
    const paid = Money.sum(inst.map((i) => Money.of(i.total_paid ?? '0')));
    const adv = Money.of((await t.db.selectFrom('loans').select('advance_balance').where('id', '=', loan.id).executeTakeFirstOrThrow()).advance_balance);
    expect(paid.plus(adv).toString()).toBe('2806.00');
    await expectLedgerTiesOut(loan.id);
  });
});

describe('records are permanent', () => {
  it('the database refuses edits and deletes of payments, allocations and receipts', async () => {
    const loan = await activeLoan();
    const r = await pay(collector, loan.id, { amount: '1240', method: 'CASH' });
    await expect(t.db.updateTable('payments').set({ amount: '1' }).where('id', '=', r.body.id).execute()).rejects.toThrow(/cannot be edited/);
    await expect(t.db.deleteFrom('payments').where('id', '=', r.body.id).execute()).rejects.toThrow(/permanent/);
    await expect(t.db.updateTable('payment_allocations').set({ amount: '1' }).where('payment_id', '=', r.body.id).execute()).rejects.toThrow();
    await expect(t.db.deleteFrom('receipts').where('payment_id', '=', r.body.id).execute()).rejects.toThrow(/permanent/);
    await expect(t.db.updateTable('receipts').set({ receipt_no: 'X' }).where('payment_id', '=', r.body.id).execute()).rejects.toThrow();
  });

  it('allocations must add up to the payment (checked at commit)', async () => {
    const loan = await activeLoan();
    const r = await pay(collector, loan.id, { amount: '1240', method: 'CASH' });
    const p = await t.db.selectFrom('payments').selectAll().where('id', '=', r.body.id).executeTakeFirstOrThrow();
    await expect(
      t.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('payment_allocations')
          .values({ payment_id: p.id, loan_id: loan.id, installment_id: null, component: 'ADVANCE', amount: '5', seq: 99, rule_snapshot: '{}' })
          .execute();
      }),
    ).rejects.toThrow(/do not add up/);
  });
});

describe('receipts', () => {
  it('PDF receipt, and a public verification page with minimal data', async () => {
    const loan = await activeLoan();
    const r = await pay(collector, loan.id, { amount: '1240', method: 'CASH' });
    const pdf = await collector.download(`/payments/${r.body.id}/receipt.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.bytes.subarray(0, 4).toString()).toBe('%PDF');
    const token = r.body.verifyUrl.split('/r/')[1];
    const v = await request(t.server).get(`/api/v1/public/receipts/${token}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ receiptNo: r.body.receiptNo, status: 'ISSUED', amount: '1240.00' });
    expect(v.body.loanNo).toMatch(/^•+\d{4}$/);
    expect(v.body.customer).toMatch(/^Payer \d+\.$/);
    expect(JSON.stringify(v.body)).not.toContain('9848012345');
    expect((await request(t.server).get('/api/v1/public/receipts/not-a-real-token-xxxxxxxx')).status).toBe(404);
  });

  it('amounts in words use the Indian system', () => {
    expect(rupeesInWords('1240')).toBe('Rupees One Thousand Two Hundred Forty Only');
    expect(rupeesInWords('123456.50')).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
    expect(rupeesInWords('25000000')).toBe('Rupees Two Crore Fifty Lakh Only');
  });
});

describe('reversal (two people)', () => {
  it('request → approve: installments, balances and receipt restored; journal mirrored', async () => {
    const loan = await activeLoan();
    const before = await installments(loan.id);
    const r = await pay(collector, loan.id, { amount: '2000', method: 'CASH' });
    const req = await collector.post(`/payments/${r.body.id}/reversal`, { reasonCode: 'WRONG_AMOUNT', reasonText: 'Customer paid 1,200 not 2,000' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await collector.post(`/payments/${r.body.id}/reversal`, { reasonCode: 'OTHER', reasonText: 'again please' })).status).toBe(409);

    const list = (await checker.get('/reversals')).body.data;
    const item = list.find((x: { payment_id: string }) => x.payment_id === r.body.id);
    expect(item.canDecide).toBe(true);

    // The approver must have re-entered their password recently.
    const stale = await checker.post(`/reversals/${req.body.id}/approve`, {});
    expect(stale.status).toBe(403);
    await checker.reauth(t, checkerUser);
    const ok = await checker.post(`/reversals/${req.body.id}/approve`, { note: 'Checked with customer' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const after = await installments(loan.id);
    expect(after.map((i) => [i.principal_paid, i.interest_paid])).toEqual(before.map((i) => [i.principal_paid, i.interest_paid]));
    const p = (await admin.get(`/payments/${r.body.id}`)).body;
    expect((await manager.get(`/payments/${r.body.id}`)).body.journal).toBeNull(); // no ledger.view
    expect(p.status).toBe('REVERSED');
    expect(p.receipt.status).toBe('CANCELLED');
    expect(p.journal).toHaveLength(2);
    expect(p.journal[1].entry_type).toBe('REVERSAL');
    await expectLedgerTiesOut(loan.id);
    expect((await collector.download(`/payments/${r.body.id}/receipt.pdf`)).status).toBe(200); // still printable, watermarked
  });

  it('the requester cannot approve their own request; rejection puts the payment back', async () => {
    const loan = await activeLoan();
    const r = await pay(manager, loan.id, { amount: '500', method: 'CASH', atCounter: true });
    const req = await manager.post(`/payments/${r.body.id}/reversal`, { reasonCode: 'DUPLICATE', reasonText: 'Entered twice by mistake' });
    await manager.reauth(t, managerUser);
    const self = await manager.post(`/reversals/${req.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER');
    expect((await collector.post(`/reversals/${req.body.id}/approve`, {})).status).toBe(403); // no permission
    const rej = await checker.post(`/reversals/${req.body.id}/reject`, { note: 'Not a duplicate' });
    expect(rej.status).toBe(200);
    expect((await manager.get(`/payments/${r.body.id}`)).body.status).toBe('POSTED');
  });

  it('reversing the settling payment reopens the loan and the asset', async () => {
    const loan = await activeLoan();
    const r = await pay(collector, loan.id, { amount: '14880', method: 'CASH' });
    expect(r.body.loanClosed).toBe(true);
    const req = await collector.post(`/payments/${r.body.id}/reversal`, { reasonCode: 'WRONG_LOAN', reasonText: 'Recorded on the wrong loan' });
    await checker.reauth(t, checkerUser);
    const ok = await checker.post(`/reversals/${req.body.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.loanReopened).toBe(true);
    const l = await t.db.selectFrom('loans').select(['status', 'principal_outstanding']).where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect(l).toEqual({ status: 'ACTIVE', principal_outstanding: '12000.00' });
    expect((await t.db.selectFrom('loan_closures').select('status').where('loan_id', '=', loan.id).executeTakeFirstOrThrow()).status).toBe('VOIDED');
    expect((await t.db.selectFrom('assets').select('status').where('loan_id', '=', loan.id).executeTakeFirstOrThrow()).status).toBe('ACTIVE');
    // Interest recognised early on settlement stays booked as receivable (it is still owed on the schedule).
    await expectLedgerTiesOut(loan.id);
  });
});

describe('advances applied on the due date', () => {
  it('nightly applies a held advance to the installment that fell due, and a reversal can unwind it', async () => {
    // Disbursed yesterday, first installment due in a month: nothing is due, so the whole payment is advance.
    const loan = await activeLoan({ start: addDays(today, -1) });
    const r = await pay(collector, loan.id, { amount: '1500', method: 'CASH' });
    expect(r.body.components.advance).toBe('1500.00');
    const firstDue = (await installments(loan.id))[0]!.due_date;

    const ledger = t.app.get(LedgerService);
    const payments = t.app.get(PaymentsService);
    await t.db.transaction().execute(async (tx) => {
      await accrueInterest(tx, ledger, firstDue, { loanIds: [loan.id] });
      expect(await payments.applyAdvancesDue(tx, firstDue)).toBeGreaterThanOrEqual(1);
    });
    const inst = await installments(loan.id);
    expect(inst[0]).toMatchObject({ principal_paid: '1000.00', interest_paid: '240.00' });
    const l = await t.db.selectFrom('loans').select('advance_balance').where('id', '=', loan.id).executeTakeFirstOrThrow();
    expect(l.advance_balance).toBe('260.00');
    const app = await t.db.selectFrom('advance_applications').selectAll().where('loan_id', '=', loan.id).executeTakeFirstOrThrow();
    expect(app).toMatchObject({ amount: '1240.00', status: 'APPLIED' });
    await expectLedgerTiesOut(loan.id);

    // Reversing the payment must first undo the advance application that used it.
    const req = await collector.post(`/payments/${r.body.id}/reversal`, { reasonCode: 'OTHER', reasonText: 'Cash was counterfeit' });
    await checker.reauth(t, checkerUser);
    expect((await checker.post(`/reversals/${req.body.id}/approve`, {})).status).toBe(200);
    expect((await t.db.selectFrom('advance_applications').select('status').where('id', '=', app.id).executeTakeFirstOrThrow()).status).toBe('REVERSED');
    const after = await installments(loan.id);
    expect(after[0]).toMatchObject({ principal_paid: '0.00', interest_paid: '0.00' });
    expect((await t.db.selectFrom('loans').select('advance_balance').where('id', '=', loan.id).executeTakeFirstOrThrow()).advance_balance).toBe('0.00');
    await expectLedgerTiesOut(loan.id);
  });
});

describe('visits and promises to pay', () => {
  it('records visits; promises resolve as kept / broken by what was paid', async () => {
    const kept = await activeLoan();
    const broken = await activeLoan();
    const v = await collector.post(`/loans/${kept.id}/visits`, { outcome: 'PROMISED', promisedAmount: '1000', promisedDate: today, notes: 'Will pay after market' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await collector.post(`/loans/${broken.id}/visits`, { outcome: 'PROMISED', promisedAmount: '1000', promisedDate: today })).status).toBe(201);
    expect((await collector.post(`/loans/${kept.id}/visits`, { outcome: 'PROMISED' })).status).toBe(400);
    expect((await collector.post(`/loans/${kept.id}/visits`, { outcome: 'PROMISED', promisedAmount: '10', promisedDate: addDays(today, -1) })).body.error.code).toBe('PAST_DATE');
    expect((await pay(collector, kept.id, { amount: '1000', method: 'CASH' })).status).toBe(201);

    const svc = t.app.get(CollectionsService);
    const n = await svc.resolvePromises(t.db, addDays(today, 1));
    expect(n).toBeGreaterThanOrEqual(2);
    const k = await t.db.selectFrom('promises_to_pay').select(['status', 'paid_amount']).where('loan_id', '=', kept.id).executeTakeFirstOrThrow();
    expect(k).toEqual({ status: 'KEPT', paid_amount: '1000.00' });
    expect((await t.db.selectFrom('promises_to_pay').select('status').where('loan_id', '=', broken.id).executeTakeFirstOrThrow()).status).toBe('BROKEN');
    const act = (await collector.get(`/loans/${kept.id}/collections`)).body;
    expect(act.visits[0].outcome).toBe('PROMISED');
  });

  it('my-day totals and the team summary agree on what was collected', async () => {
    const day = (await collector.get('/collections/my-day')).body;
    const summary = (await manager.get('/collections/summary')).body;
    const row = summary.collectors.find((c: { id: string }) => c.id === collectorEmp);
    const fromSummary = Money.sum(['cash', 'upi', 'bank', 'cheque'].map((k) => Money.of(row[k])));
    expect(fromSummary.toString()).toBe(Money.of(day.totals.collected).toString());
    expect(Number(day.totals.payments)).toBe(Number(row.payments));
    expect(Money.of(day.totals.cashInHand).isPositive()).toBe(true);
    expect((await collector.get('/collections/summary')).status).toBe(403);
  });
});

describe('messaging', () => {
  it('payment confirmations are queued by SMS, and on WhatsApp only with consent; the log provider marks them SIMULATED', async () => {
    const withWa = await activeLoan({ whatsapp: true });
    const noWa = await activeLoan({ whatsapp: false });
    const a = await pay(collector, withWa.id, { amount: '1240', method: 'CASH' });
    const b = await pay(collector, noWa.id, { amount: '1240', method: 'CASH' });
    expect(a.body.messages.map((m: { status: string }) => m.status)).toEqual(['QUEUED', 'QUEUED']);
    expect(b.body.messages.map((m: { status: string }) => m.status)).toEqual(['QUEUED']);
    const relay = await admin.post('/messages/relay');
    expect(relay.status).toBe(200);
    const msgs = await t.db.selectFrom('messages').select(['channel', 'status', 'body', 'provider']).where('payment_id', '=', a.body.id).orderBy('channel').execute();
    expect(msgs.map((m) => [m.channel, m.status, m.provider])).toEqual([
      ['SMS', 'SIMULATED', 'log'],
      ['WHATSAPP', 'SIMULATED', 'log'],
    ]);
    expect(msgs[0]!.body).toContain(a.body.receiptNo);
    expect(msgs[0]!.body).toContain('Rs.1,240.00');
  });

  it('collectors see masked numbers unless allowed; manual sends are limited per loan per day', async () => {
    const loan = await activeLoan();
    for (let i = 0; i < 3; i++) {
      const s = await collector.post(`/loans/${loan.id}/messages`, { channel: 'SMS', eventCode: 'OVERDUE' });
      expect(s.status, JSON.stringify(s.body)).toBe(201);
    }
    const limited = await collector.post(`/loans/${loan.id}/messages`, { channel: 'SMS', eventCode: 'OVERDUE' });
    expect(limited.body.error.code).toBe('MESSAGE_LIMIT');
    const wa = await manager.post(`/loans/${(await activeLoan()).id}/messages`, { channel: 'WHATSAPP', eventCode: 'DUE_REMINDER' });
    expect(wa.body).toMatchObject({ status: 'SKIPPED', reason: 'Customer has not agreed to WhatsApp messages' });
    const logs = (await manager.get(`/messages?loanId=${loan.id}`)).body.data;
    expect(logs[0].to_number).toBe('9848012345'); // branch manager may see contact numbers
  });

  it('reminders follow the rules and fire once per installment', async () => {
    const loan = await activeLoan();
    const inst = (await installments(loan.id)).find((i) => i.due_date > today)!;
    const msvc = t.app.get(MessagingService);
    const dayBefore = addDays(inst.due_date, -1);
    const n1 = await msvc.queueReminders(t.db, dayBefore);
    const n2 = await msvc.queueReminders(t.db, dayBefore);
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBe(0);
    const m = await t.db.selectFrom('messages').select(['event_code', 'channel', 'status', 'body']).where('installment_id', '=', inst.id).orderBy('channel').execute();
    // SMS and WhatsApp rules both fire; without WhatsApp consent that one is recorded as skipped, with the reason.
    expect(m.map((x) => [x.event_code, x.channel, x.status])).toEqual([
      ['DUE_REMINDER', 'SMS', 'QUEUED'],
      ['DUE_REMINDER', 'WHATSAPP', 'SKIPPED'],
    ]);
    expect(m[0]!.body).toContain(loan.loanNo);
  });

  it('template edits may only use the event’s placeholders', async () => {
    const tpl = (await admin.get('/message-templates')).body.data.find((x: { event_code: string; channel: string }) => x.event_code === 'DUE_REMINDER' && x.channel === 'SMS');
    const bad = await admin.put(`/message-templates/${tpl.id}`, { body: 'Hi {{name}}, pay {{pan}} now', isActive: true });
    expect(bad.status).toBe(400);
    const ok = await admin.put(`/message-templates/${tpl.id}`, { body: 'Hi {{name}}, Rs.{{amount}} for {{loan_no}} is due on {{due_date}}. - {{company}}', dltTemplateId: '1107161234567890123', isActive: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.variables).toEqual(['name', 'amount', 'loan_no', 'due_date', 'company']);
    expect((await manager.put(`/message-templates/${tpl.id}`, { body: tpl.body, isActive: true })).status).toBe(403);
  });

  it('provider payloads match the official APIs, and failures are classified', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (status: number, body: unknown) => (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const msg = { to: '9848012345', body: 'x', params: ['Ravi', '1,240.00'], dltTemplateId: '1107161234567890123', waTemplateName: 'payment_received', waLanguage: 'en' };

    const wa = new MetaWhatsAppProvider({ phoneNumberId: '1234567890', accessToken: 'tok', apiVersion: 'v21.0' }, fake(200, { messages: [{ id: 'wamid.ABC' }] }));
    expect(await wa.send(msg)).toEqual({ status: 'SENT', providerMessageId: 'wamid.ABC' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '919848012345',
      type: 'template',
      template: { name: 'payment_received', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: '1,240.00' }] }] },
    });
    const sms = new Msg91Provider('key', fake(200, { type: 'success', message: 'req-123' }));
    expect(await sms.send(msg)).toEqual({ status: 'SENT', providerMessageId: 'req-123' });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ template_id: '1107161234567890123', short_url: '0', recipients: [{ mobiles: '919848012345', var1: 'Ravi', var2: '1,240.00' }] });
    expect((calls[1]!.init.headers as Record<string, string>).authkey).toBe('key');

    await expect(new Msg91Provider('key', fake(200, {})).send({ ...msg, dltTemplateId: null })).rejects.toMatchObject({ retryable: false });
    await expect(new MetaWhatsAppProvider({ phoneNumberId: '1', accessToken: 't', apiVersion: 'v21.0' }, fake(503, { error: { message: 'busy' } })).send(msg)).rejects.toMatchObject({ retryable: true });
    await expect(new MetaWhatsAppProvider({ phoneNumberId: '1', accessToken: 't', apiVersion: 'v21.0' }, fake(400, { error: { message: 'bad template' } })).send(msg)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('provider webhooks', () => {
  let w: TestApp;
  const appSecret = 'meta-app-secret-for-tests';
  beforeAll(async () => {
    w = await createTestApp({ WHATSAPP_APP_SECRET: appSecret, WHATSAPP_VERIFY_TOKEN: 'verify-token-123456', MSG91_WEBHOOK_TOKEN: 'msg91-token-abcdefghijklmnopqrstuvwxyz' });
  });
  afterAll(async () => w.close());

  it('Meta: verification handshake, signature required, statuses only move forward', async () => {
    const ok = await request(w.server).get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-token-123456', 'hub.challenge': '1158201444' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect((await request(w.server).get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token-0000000', 'hub.challenge': '1' })).status).toBe(403);

    const msg = await w.db.selectFrom('messages').select('id').where('channel', '=', 'WHATSAPP').where('status', '=', 'SIMULATED').executeTakeFirstOrThrow();
    await w.db.updateTable('messages').set({ status: 'SENT', provider: 'meta', provider_message_id: 'wamid.TEST1' }).where('id', '=', msg.id).execute();
    const send = (statuses: unknown[], sign = true) => {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses } }] }] });
      const sig = 'sha256=' + createHmac('sha256', sign ? appSecret : 'wrong').update(body).digest('hex');
      return request(w.server).post('/api/v1/webhooks/whatsapp').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(body);
    };
    expect((await send([{ id: 'wamid.TEST1', status: 'read' }], false)).status).toBe(403);
    expect((await send([{ id: 'wamid.TEST1', status: 'read' }])).body).toEqual({ updated: 1 });
    expect((await send([{ id: 'wamid.TEST1', status: 'delivered' }])).body).toEqual({ updated: 0 }); // late, ignored
    const m = await w.db.selectFrom('messages').select(['status', 'read_at']).where('id', '=', msg.id).executeTakeFirstOrThrow();
    expect(m.status).toBe('READ');
    expect(m.read_at).not.toBeNull();
    const events = await w.db.selectFrom('message_events').select('status').where('message_id', '=', msg.id).execute();
    expect(events.map((e) => e.status)).toEqual(expect.arrayContaining(['READ', 'DELIVERED']));
  });

  it('MSG91: shared token required; delivery and failure reports applied', async () => {
    const msg = await w.db.selectFrom('messages').select('id').where('channel', '=', 'SMS').where('status', '=', 'SIMULATED').executeTakeFirstOrThrow();
    await w.db.updateTable('messages').set({ status: 'SENT', provider: 'msg91', provider_message_id: 'req-777' }).where('id', '=', msg.id).execute();
    const body = [{ requestId: 'req-777', report: [{ desc: 'DELIVERED', status: '1', number: '919848012345' }] }];
    expect((await request(w.server).post('/api/v1/webhooks/msg91').query({ token: 'nope' }).send(body)).status).toBe(403);
    const r = await request(w.server).post('/api/v1/webhooks/msg91').query({ token: 'msg91-token-abcdefghijklmnopqrstuvwxyz' }).send(body);
    expect(r.body).toEqual({ updated: 1 });
    expect((await w.db.selectFrom('messages').select('status').where('id', '=', msg.id).executeTakeFirstOrThrow()).status).toBe('DELIVERED');
  });

  it('unconfigured webhooks do not exist; webhooks ignore browser origins but need no session', async () => {
    expect((await request(t.server).post('/api/v1/webhooks/msg91').query({ token: 'x' }).send([])).status).toBe(404);
    expect((await request(w.server).post('/api/v1/webhooks/msg91').set('Origin', 'https://evil.example').query({ token: 'msg91-token-abcdefghijklmnopqrstuvwxyz' }).send([])).status).toBe(403);
    expect(ORIGIN).toBeTruthy();
  });
});
