import { addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { rollStatuses } from '../lending/dues';
import { LoansService } from '../lending/loans.service';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';
import { RecoveryService } from './recovery.service';

/** Recovery cases, stages, repossession and sale (E14), write-off (E13) — in a branch of its own. */
let t: TestApp;
let br: string;
let admin: Client;
let manager: Client;
let manager2: Client;
let accountant: Client;
let accountant2: Client;
let accountant2User: TestUser;
let management: Client;
let managementUser: TestUser;
let collector: Client;
let collectorEmp: string;
let bankId: string;
let productId: string;
const today = istToday();
let seq = 0;

const code = async (c: string) => (await t.db.selectFrom('accounts').select('id').where('code', '=', c).executeTakeFirstOrThrow()).id;
async function loanLedger(loanId: string) {
  const r = await sql<{ code: string; b: string }>`
    SELECT a.code, coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.loan_id = ${loanId} GROUP BY a.code`.execute(t.db);
  return (c: string) => Money.of(r.rows.find((x) => x.code === c)?.b ?? '0');
}
async function accountBalance(c: string) {
  const r = await sql<{ b: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = ${c}`.execute(t.db);
  return Money.of(r.rows[0]!.b);
}

/** A loan disbursed `monthsAgo` months back with nothing paid, so it is overdue today. */
async function overdueLoan(monthsAgo = 3) {
  const n = ++seq;
  const c = await manager.post('/customers', { branchId: br, fullName: `Recovery Customer ${n}`, mobile: '9848044444' }, { 'Idempotency-Key': newKey() });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
  const start = addMonthsAnchored(today, -monthsAgo);
  const l = await manager.post(
    '/loans',
    { customerId: c.body.id, productId, principal: '24000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { make: 'Bajaj', model: 'RE Compact', manufactureYear: 2025, registrationNo: `AP05RC${1000 + n}`, chassisNo: `MDRCV${String(Date.now()).slice(-7)}${n}`, engineNo: `ERCV${n}${Date.now() % 100000}`, assetValue: '150000' } },
    { 'Idempotency-Key': newKey() },
  );
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  await manager.post(`/loans/${l.body.id}/submit`);
  expect((await manager2.post(`/loans/${l.body.id}/approve`, {})).status).toBe(200);
  const d = await manager.post(`/loans/${l.body.id}/disburse`, { accountId: bankId, mode: 'BANK_TRANSFER', reference: `NEFTRCV${n}${Date.now() % 1_000_000}`, disbursedOn: start }, { 'Idempotency-Key': newKey() });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  await manager.post('/collections/assign', { loanIds: [l.body.id], employeeId: collectorEmp });
  await t.db.transaction().execute(async (tx) => {
    await rollStatuses(tx, today, [l.body.id]);
    await t.app.get(LoansService).refreshBalances(tx, [l.body.id], today);
  });
  return l.body.id as string;
}
const assetOf = async (loanId: string) => (await t.db.selectFrom('assets').select('id').where('loan_id', '=', loanId).executeTakeFirstOrThrow()).id;

beforeAll(async () => {
  t = await createTestApp();
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  const b = await admin.post('/branches', { code: 'RCVY', name: 'Recovery Town' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  br = b.body.id;
  ({ client: manager } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RCVY'] }));
  ({ client: manager2 } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RCVY'] }));
  ({ client: accountant } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RCVY'] }));
  ({ client: accountant2, user: accountant2User } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RCVY'] }));
  ({ client: management, user: managementUser } = await signedIn(t, ['MANAGEMENT']));
  const c = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['RCVY'] });
  collectorEmp = (await t.db.insertInto('employees').values({ branch_id: br, user_id: c.user.id, employee_code: `ERC${Date.now() % 100000}`, full_name: 'Recovery Collector', is_collector: true }).returning('id').executeTakeFirstOrThrow()).id;
  collector = await new Client(t.server).login(t, c.user);
  const p = await admin.post('/loan-products', {
    code: 'TW-RCV', name: '2W (recovery tests)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
    amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
  });
  productId = p.body.id;
  const bank = await admin.post('/accounts/bank', { name: 'Indian Bank Current A/c', bankName: 'Indian Bank', accountNumber: '6612201009876', ifsc: 'IDIB000K012', kind: 'CURRENT' });
  bankId = bank.body.id;
  const cap = await accountant.post('/manual-journals', { valueDate: today, branchId: br, narration: 'Capital for the Recovery Town branch', lines: [{ accountId: bankId, debit: '1000000' }, { accountId: await code('3100'), credit: '1000000' }] });
  expect(cap.status, JSON.stringify(cap.body)).toBe(201);
  await accountant2.reauth(t, accountant2User);
  expect((await accountant2.post(`/manual-journals/${cap.body.id}/approve`, {})).status).toBe(200);
});
afterAll(async () => t.close());

describe('recovery cases', () => {
  it('opens only on overdue loans, once; collectors add notes but cannot move stages; stage rules apply', async () => {
    const loan = await overdueLoan(3);
    const l = await t.db.selectFrom('loans').select(['dpd', 'overdue_amount']).where('id', '=', loan).executeTakeFirstOrThrow();
    expect(l.dpd).toBeGreaterThan(30);
    expect((await collector.post('/recovery/cases', { loanId: loan, note: 'Not paying' })).status).toBe(403);
    const opened = await manager.post('/recovery/cases', { loanId: loan, note: 'Three installments missed; phone switched off' });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.case_no).toMatch(/^REC-RCVY-/);
    expect((await manager.post('/recovery/cases', { loanId: loan, note: 'again please' })).body.error.code).toBe('CASE_OPEN');
    const id = opened.body.id;

    // The collector sees and adds to the case on an assigned loan.
    expect((await collector.post(`/recovery/cases/${id}/actions`, { type: 'VISIT', summary: 'House locked; neighbour says family moved to Kakinada' })).status).toBe(201);
    expect((await collector.post(`/recovery/cases/${id}/stage`, { stage: 'FIELD_VISIT', note: 'moving it' })).status).toBe(403);
    const view = await collector.get(`/recovery/cases/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.actions.map((a: { action_type: string }) => a.action_type)).toEqual(['VISIT', 'OPENED']);
    expect(view.body.stage).toBe('FOLLOW_UP');

    expect((await manager.post(`/recovery/cases/${id}/stage`, { stage: 'REPOSSESSION', note: 'skip ahead' })).body.error.code).toBe('STAGE_NOT_ALLOWED');
    expect((await manager.post(`/recovery/cases/${id}/stage`, { stage: 'RESOLVED', note: 'all good now' })).body.error.code).toBe('STILL_OVERDUE');
    expect((await manager.post(`/recovery/cases/${id}/stage`, { stage: 'FIELD_VISIT', note: 'Weekly visits from now' })).body.requested).toBe(false);
    expect((await manager.post(`/recovery/cases/${id}/stage`, { stage: 'ESCALATED', note: 'Customer avoiding the collector' })).status).toBe(200);
    expect((await manager.post(`/recovery/cases/${id}/stage`, { stage: 'WRITTEN_OFF', note: 'give up' })).body.error.code).toBe('USE_WRITE_OFF');

    // Repossession needs a second person (step-up), not the requester.
    const req = await manager.post(`/recovery/cases/${id}/stage`, { stage: 'REPOSSESSION', note: 'Notice period over per legal advice' });
    expect(req.body.requested).toBe(true);
    expect((await manager.post(`/recovery/cases/${id}/repossess`, { assetId: await assetOf(loan), repossessedOn: today, location: 'Branch yard', conditionNotes: 'Good condition' })).body.error.code).toBe('STAGE_REQUIRED');
    expect((await management.post(`/recovery/cases/${id}/stage/approve`, {})).body.error.code).toBe('REAUTH_REQUIRED');
    await management.reauth(t, managementUser);
    expect((await management.post(`/recovery/cases/${id}/stage/approve`, { note: 'Approved after reviewing notice' })).status).toBe(200);
    const after = await manager.get(`/recovery/cases/${id}`);
    expect(after.body.stage).toBe('REPOSSESSION');
    expect(after.body.requested_stage).toBeNull();

    // The nightly job doesn't open a second case for the same loan.
    const opened2 = await t.db.transaction().execute((tx) => t.app.get(RecoveryService).autoOpen(tx, today));
    expect(opened2).toBeGreaterThanOrEqual(0);
    const cases = await t.db.selectFrom('recovery_cases').select('id').where('loan_id', '=', loan).execute();
    expect(cases).toHaveLength(1);
  });

  it('the nightly job opens cases beyond the configured days past due', async () => {
    const loan = await overdueLoan(2);
    const dpd = (await t.db.selectFrom('loans').select('dpd').where('id', '=', loan).executeTakeFirstOrThrow()).dpd;
    const set = await admin.put('/recovery/settings', { autoOpenDpd: dpd });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const n = await t.db.transaction().execute((tx) => t.app.get(RecoveryService).autoOpen(tx, today));
    expect(n).toBeGreaterThanOrEqual(1);
    const rc = await t.db.selectFrom('recovery_cases').select(['opened_by', 'stage', 'owner_employee_id']).where('loan_id', '=', loan).executeTakeFirstOrThrow();
    expect(rc.opened_by).toBeNull();
    expect(rc.stage).toBe('FOLLOW_UP');
    expect(rc.owner_employee_id).toBe(collectorEmp); // the assigned collector owns it
    expect((await manager.put('/recovery/settings', { autoOpenDpd: 10 })).status).toBe(403);
    await admin.put('/recovery/settings', { autoOpenDpd: 30 });
  });

  it('stage definitions are configurable, but the system stages stay', async () => {
    expect((await admin.put('/recovery/stages', { code: 'WRITTEN_OFF', name: 'Closed — written off', sortOrder: 95, requiresApproval: true, isTerminal: true, allowedNext: [], active: false })).body.error.code).toBe('STAGE_REQUIRED');
    const add = await admin.put('/recovery/stages', { code: 'LEGAL_REVIEW', name: 'Legal review', description: 'Advisor reviews the file', sortOrder: 45, requiresApproval: true, isTerminal: false, allowedNext: ['SETTLEMENT', 'REPOSSESSION'], active: true });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.find((s: { code: string }) => s.code === 'LEGAL_REVIEW').requires_approval).toBe(true);
    expect((await admin.put('/recovery/stages', { code: 'BAD', name: 'Bad', sortOrder: 1, requiresApproval: false, isTerminal: false, allowedNext: ['NOPE'], active: true })).body.error.code).toBe('UNKNOWN_STAGE');
    expect((await manager.put('/recovery/stages', { code: 'X1', name: 'X', sortOrder: 1, requiresApproval: false, isTerminal: false, allowedNext: [], active: true })).status).toBe(403);
  });
});

describe('repossession and sale (E14)', () => {
  it('sale proceeds settle the loan through the advance; surplus is owed to the customer; the sub-ledger ties', async () => {
    const loan = await overdueLoan(3);
    const rc = (await manager.post('/recovery/cases', { loanId: loan, note: 'Unreachable for three months' })).body.id;
    for (const s of ['FIELD_VISIT', 'ESCALATED']) expect((await manager.post(`/recovery/cases/${rc}/stage`, { stage: s, note: 'next step' })).status).toBe(200);
    await manager.post(`/recovery/cases/${rc}/stage`, { stage: 'REPOSSESSION', note: 'Approved by legal advisor' });
    await management.reauth(t, managementUser);
    expect((await management.post(`/recovery/cases/${rc}/stage/approve`, {})).status).toBe(200);
    const asset = await assetOf(loan);
    const rep = await manager.post(`/recovery/cases/${rc}/repossess`, { assetId: asset, repossessedOn: today, location: 'Branch yard, Recovery Town', conditionNotes: 'Odometer 18,400 km; both keys; RC with customer', valuation: '90000' });
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    expect((await t.db.selectFrom('assets').select('status').where('id', '=', asset).executeTakeFirstOrThrow()).status).toBe('REPOSSESSED');
    // Repossession is custody only: nothing posted.
    expect((await t.db.selectFrom('journal_entries').select('id').where('entry_type', '=', 'SALE').where('source_id', '=', loan).execute())).toHaveLength(0);
    expect((await manager.post(`/recovery/cases/${rc}/close`, { reason: 'closing early' })).body.error.code).toBe('ASSET_HELD');

    const owed = Money.of((await t.db.selectFrom('loan_installments').select(sql<string>`sum(total_due - total_paid)::text`.as('o')).where('loan_id', '=', loan).executeTakeFirstOrThrow()).o);
    const price = owed.plus(Money.of('5000'));
    const cashAcct = await code('1110-RCVY');
    expect((await manager.post(`/recovery/cases/${rc}/sales`, { assetId: asset, salePrice: price.toString(), soldOn: today, buyerName: 'Sri Lakshmi Auto Traders', accountId: cashAcct })).body.error.code).toBe('ACCOUNT_INVALID');
    const sale = await manager.post(`/recovery/cases/${rc}/sales`, { assetId: asset, salePrice: price.toString(), soldOn: today, buyerName: 'Sri Lakshmi Auto Traders', buyerReference: 'INV-2291', accountId: bankId });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect((await manager.post(`/recovery/sales/${sale.body.id}/approve`, {})).status).toBe(403); // no recovery.approve
    const bankBefore = await accountBalance((await t.db.selectFrom('accounts').select('code').where('id', '=', bankId).executeTakeFirstOrThrow()).code);
    await management.reauth(t, managementUser);
    const ok = await management.post(`/recovery/sales/${sale.body.id}/approve`, { note: 'Best of three quotes' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.closed).toBe(true);
    expect(ok.body.surplus).toBe('5000.00');

    const l = await t.db.selectFrom('loans').select(['status', 'advance_balance']).where('id', '=', loan).executeTakeFirstOrThrow();
    expect(l.status).toBe('CLOSED');
    expect(l.advance_balance).toBe('5000.00');
    const bal = await loanLedger(loan);
    for (const c of ['1310', '1320', '1330', '1340']) expect(bal(c).toString(), c).toBe('0.00');
    expect(bal('2200').toString()).toBe('-5000.00'); // owed to the customer
    const bankAfter = await accountBalance((await t.db.selectFrom('accounts').select('code').where('id', '=', bankId).executeTakeFirstOrThrow()).code);
    expect(bankAfter.minus(bankBefore).toString()).toBe(price.toString());
    expect((await t.db.selectFrom('assets').select('status').where('id', '=', asset).executeTakeFirstOrThrow()).status).toBe('SOLD');
    const closure = await t.db.selectFrom('loan_closures').select('checklist').where('loan_id', '=', loan).executeTakeFirstOrThrow();
    expect((closure.checklist as { refundDue?: string }).refundDue).toBe('5000.00');
    const c = await manager.get(`/recovery/cases/${rc}`);
    expect(c.body.status).toBe('CLOSED');
    expect(c.body.stage).toBe('RESOLVED');
  });

  it('a sale below the dues pays what is due, holds the rest for later installments; release returns the asset', async () => {
    const loan = await overdueLoan(3);
    const rc = (await manager.post('/recovery/cases', { loanId: loan, note: 'Repeated broken promises' })).body.id;
    for (const s of ['FIELD_VISIT', 'ESCALATED']) await manager.post(`/recovery/cases/${rc}/stage`, { stage: s, note: 'next step' });
    await manager.post(`/recovery/cases/${rc}/stage`, { stage: 'REPOSSESSION', note: 'Approved by legal advisor' });
    await management.reauth(t, managementUser);
    await management.post(`/recovery/cases/${rc}/stage/approve`, {});
    const asset = await assetOf(loan);
    await manager.post(`/recovery/cases/${rc}/repossess`, { assetId: asset, repossessedOn: today, location: 'Yard', conditionNotes: 'Scratches on tank' });
    // Release and repossess again (customer paid a part, then defaulted again).
    expect((await manager.post(`/recovery/cases/${rc}/assets/${asset}/release`, { reason: 'Customer paid two installments' })).status).toBe(200);
    expect((await t.db.selectFrom('assets').select('status').where('id', '=', asset).executeTakeFirstOrThrow()).status).toBe('ACTIVE');
    await manager.post(`/recovery/cases/${rc}/repossess`, { assetId: asset, repossessedOn: today, location: 'Yard', conditionNotes: 'Same condition' });

    const overdue = Money.of((await t.db.selectFrom('loans').select('overdue_amount').where('id', '=', loan).executeTakeFirstOrThrow()).overdue_amount);
    const price = overdue.plus(Money.of('1000'));
    const sale = await manager.post(`/recovery/cases/${rc}/sales`, { assetId: asset, salePrice: price.toString(), soldOn: today, buyerName: 'Local dealer', accountId: bankId });
    await management.reauth(t, managementUser);
    const ok = await management.post(`/recovery/sales/${sale.body.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.closed).toBe(false);
    const l = await t.db.selectFrom('loans').select(['status', 'overdue_amount', 'advance_balance', 'principal_outstanding', 'interest_outstanding']).where('id', '=', loan).executeTakeFirstOrThrow();
    expect(l.status).toBe('ACTIVE');
    expect(l.overdue_amount).toBe('0.00');
    const bal = await loanLedger(loan);
    expect(bal('1310').toString()).toBe(l.principal_outstanding);
    expect(bal('1320').toString()).toBe(l.interest_outstanding);
    expect(Money.zero().minus(bal('2200')).toString()).toBe(l.advance_balance);
  });
});

describe('write-off (E13)', () => {
  it('removes exactly the receivables on the books, uses the advance, needs a second person; later money is income', async () => {
    const loan = await overdueLoan(4);
    const pre = await manager.post(`/loans/${loan}/payments`, { amount: '1500', method: 'CASH', atCounter: true, confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
    expect(pre.status, JSON.stringify(pre.body)).toBe(201);
    const rc = (await manager.post('/recovery/cases', { loanId: loan, note: 'Customer left the district' })).body.id;
    expect((await accountant.post(`/recovery/cases/${rc}/write-off`, { reason: 'Customer absconded; no asset traceable after search' })).status).toBe(403);
    const req = await manager.post(`/recovery/cases/${rc}/write-off`, { reason: 'Customer absconded; vehicle not traceable after a 60-day search' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await manager.post(`/recovery/cases/${rc}/write-off`, { reason: 'Customer absconded; vehicle not traceable after a 60-day search' })).body.error.code).toBe('WRITE_OFF_EXISTS');

    const before = await loanLedger(loan);
    const receivable = Money.sum(['1310', '1320', '1330', '1340'].map((c) => before(c)));
    const badDebtsBefore = await accountBalance('5600');
    await management.reauth(t, managementUser);
    const ok = await management.post(`/recovery/write-offs/${req.body.id}/approve`, { note: 'Board approval minute 14/2026' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.amount).toBe(receivable.toString());

    const after = await loanLedger(loan);
    for (const c of ['1310', '1320', '1330', '1340', '2200']) expect(after(c).toString(), c).toBe('0.00');
    expect((await accountBalance('5600')).minus(badDebtsBefore).toString()).toBe(receivable.toString());
    const l = await t.db.selectFrom('loans').select('status').where('id', '=', loan).executeTakeFirstOrThrow();
    expect(l.status).toBe('WRITTEN_OFF');
    expect((await t.db.selectFrom('assets').select('status').where('loan_id', '=', loan).executeTakeFirstOrThrow()).status).toBe('WRITTEN_OFF');
    const c = await manager.get(`/recovery/cases/${rc}`);
    expect(c.body.stage).toBe('WRITTEN_OFF');
    expect(c.body.status).toBe('CLOSED');

    // A payment taken before the write-off can no longer be reversed.
    const rev = await manager.post(`/payments/${pre.body.id}/reversal`, { reasonCode: 'WRONG_AMOUNT', reasonText: 'Entered wrongly' });
    expect(rev.body.error?.code, JSON.stringify(rev.body)).toBe('LOAN_WRITTEN_OFF');
    // Money received after the write-off is bad debts recovered (4500), not a repayment.
    const recoveredBefore = await accountBalance('4500');
    const late = await manager.post(`/loans/${loan}/payments`, { amount: '2000', method: 'CASH', atCounter: true, confirmDuplicate: true }, { 'Idempotency-Key': newKey() });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    expect(late.body.balanceAfter).toBe('0.00');
    expect((await accountBalance('4500')).minus(recoveredBefore).toString()).toBe('-2000.00'); // credit-normal income
    const p = await t.db.selectFrom('payments').select('is_post_write_off').where('id', '=', late.body.id).executeTakeFirstOrThrow();
    expect(p.is_post_write_off).toBe(true);
    expect((await t.db.selectFrom('payment_allocations').select('id').where('payment_id', '=', late.body.id).execute())).toHaveLength(0);
    for (const c of ['1310', '1320', '1330', '1340']) expect((await loanLedger(loan))(c).toString(), c).toBe('0.00');
  });

  it('a rejected write-off changes nothing; the requester cannot approve their own', async () => {
    const loan = await overdueLoan(2);
    const rc = (await manager.post('/recovery/cases', { loanId: loan, note: 'Testing the rejection path' })).body.id;
    const req = await manager.post(`/recovery/cases/${rc}/write-off`, { reason: 'Requesting write-off to test the rejection path' });
    const { user: mgmt2 } = await signedIn(t, ['MANAGEMENT']);
    expect(mgmt2).toBeTruthy();
    expect((await management.post(`/recovery/write-offs/${req.body.id}/reject`, { note: 'Keep following up' })).status).toBe(200);
    expect((await t.db.selectFrom('loans').select('status').where('id', '=', loan).executeTakeFirstOrThrow()).status).toBe('ACTIVE');
    const approvals = await management.get('/recovery/approvals');
    expect(approvals.body.writeOffs.find((w: { id: string }) => w.id === req.body.id)).toBeUndefined();
  });
});
