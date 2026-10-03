import { addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';
import { extractUtr, parseAmount, parseCsv, parseDate } from './statement-parser';

/**
 * Doc 09 §10 cases, in a branch of its own so other suites' collectors don't affect day close.
 */
let t: TestApp;
let br: string;
let admin: Client;
let manager: Client; // branch manager (counts cash, approves small differences, closes the day)
let managerUser: TestUser;
let manager2: Client;
let manager2User: TestUser;
let accountant: Client;
let accountant2: Client;
let accountant2User: TestUser;
let management: Client;
let managementUser: TestUser;
const collectors: { client: Client; user: TestUser; emp: string }[] = [];
let bankId: string;
let productId: string;
const today = istToday();
let seq = 0;

const code = async (c: string) => (await t.db.selectFrom('accounts').select('id').where('code', '=', c).executeTakeFirstOrThrow()).id;
async function balance(accountId: string) {
  const r = await sql<{ b: string }>`SELECT coalesce(sum(debit - credit), 0)::text b FROM journal_lines WHERE account_id = ${accountId}`.execute(t.db);
  return Money.of(r.rows[0]!.b);
}
const cashOf = async (emp: string) => (await t.db.selectFrom('accounts').select('id').where('employee_id', '=', emp).where('subtype', '=', 'EMPLOYEE_CASH').executeTakeFirstOrThrow()).id;

async function loanFor(collectorIdx: number) {
  const n = ++seq;
  const c = await manager.post('/customers', { branchId: br, fullName: `Recon Customer ${n}`, mobile: '9848033333' }, { 'Idempotency-Key': newKey() });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
  const start = addMonthsAnchored(today, -1);
  const l = await manager.post(
    '/loans',
    { customerId: c.body.id, productId, principal: '12000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12, disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1), asset: { make: 'TVS', model: 'XL100', manufactureYear: 2026, chassisNo: `MDREC${String(Date.now()).slice(-7)}${n}`, engineNo: `EREC${n}${Date.now() % 100000}`, assetValue: '60000' } },
    { 'Idempotency-Key': newKey() },
  );
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  await manager.post(`/loans/${l.body.id}/submit`);
  expect((await manager2.post(`/loans/${l.body.id}/approve`, {})).status).toBe(200);
  const d = await manager.post(`/loans/${l.body.id}/disburse`, { accountId: bankId, mode: 'BANK_TRANSFER', reference: `NEFTDISB${n}${Date.now() % 1_000_000}`, disbursedOn: start }, { 'Idempotency-Key': newKey() });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  await manager.post('/collections/assign', { loanIds: [l.body.id], employeeId: collectors[collectorIdx]!.emp });
  return l.body.id as string;
}
const pay = (c: Client, loan: string, body: Record<string, unknown>) => c.post(`/loans/${loan}/payments`, { confirmDuplicate: true, ...body }, { 'Idempotency-Key': newKey() });

beforeAll(async () => {
  t = await createTestApp();
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  const b = await admin.post('/branches', { code: 'RECN', name: 'Recon Town' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  br = b.body.id;
  ({ client: manager, user: managerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RECN'] }));
  ({ client: manager2, user: manager2User } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['RECN'] }));
  ({ client: accountant } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RECN'] }));
  ({ client: accountant2, user: accountant2User } = await signedIn(t, ['ACCOUNTANT'], { branches: ['RECN'] }));
  ({ client: management, user: managementUser } = await signedIn(t, ['MANAGEMENT']));
  for (let i = 0; i < 3; i++) {
    const c = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['RECN'] });
    const emp = (await t.db.insertInto('employees').values({ branch_id: br, user_id: c.user.id, employee_code: `ER${i}${Date.now() % 100000}`, full_name: `Recon Collector ${i}`, is_collector: true }).returning('id').executeTakeFirstOrThrow()).id;
    collectors.push({ client: await new Client(t.server).login(t, c.user), user: c.user, emp });
  }
  const p = await admin.post('/loan-products', {
    code: 'TW-REC', name: '2W (recon tests)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
    amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [], penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
  });
  productId = p.body.id;
  const bank = await admin.post('/accounts/bank', { name: 'Canara Current A/c', bankName: 'Canara Bank', accountNumber: '0612201001234', ifsc: 'CNRB0000612', kind: 'CURRENT' });
  bankId = bank.body.id;
  // Partners' capital so disbursements don't overdraw the books.
  const cap = await accountant.post('/manual-journals', { valueDate: today, branchId: br, narration: 'Capital for the Recon Town branch', lines: [{ accountId: bankId, debit: '1000000' }, { accountId: await code('3100'), credit: '1000000' }] });
  expect(cap.status, JSON.stringify(cap.body)).toBe(201);
  await accountant2.reauth(t, accountant2User);
  expect((await accountant2.post(`/manual-journals/${cap.body.id}/approve`, {})).status).toBe(200);
});
afterAll(async () => t.close());

describe('statement parsing', () => {
  it('reads CSV with quotes, Indian dates and amounts, and finds UTRs', () => {
    expect(parseCsv('a,"b, c",d\r\n1,"say ""hi""",3\n')).toEqual([['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
    expect(parseDate('03/10/2026', 'DD/MM/YYYY')).toBe('2026-10-03');
    expect(parseDate('3-Oct-26', 'DD-MMM-YYYY')).toBe('2026-10-03');
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseAmount('1,23,456.78')).toBe('123456.78');
    expect(parseAmount('')).toBe('0.00');
    expect(parseAmount('12.345')).toBeNull();
    expect(extractUtr('UPI/627512345678/Ravi Kumar/okaxis')).toBe('627512345678');
    expect(extractUtr('NEFT-SBIN526270012345-RAMESH')).toBe('SBIN526270012345');
  });
});

describe('employee cash settlement', () => {
  it('exact match: expected = opening + collected − deposited; count matches', async () => {
    const c = collectors[0]!;
    const loan = await loanFor(0);
    expect((await pay(c.client, loan, { amount: '1240', method: 'CASH' })).status).toBe(201);
    const cash = await cashOf(c.emp);
    expect((await accountant.post('/banking/deposits', { fromAccountId: cash, toAccountId: bankId, amount: '1000', depositedOn: today, slipNo: 'CNB-7781' })).status).toBe(201);
    const view = (await c.client.get(`/reconciliation/settlements/${c.emp}/${today}`)).body;
    expect(view.figures).toMatchObject({ opening: '0.00', collected: '1240.00', deposited: '1000.00', expected: '240.00' });
    expect(view.can.count).toBe(false);
    expect((await c.client.post(`/reconciliation/settlements/${c.emp}/${today}/declare`, { declaredCash: '240' })).body.status).toBe('SUBMITTED');
    expect((await c.client.post(`/reconciliation/settlements/${c.emp}/${today}/count`, { countedCash: '240' })).status).toBe(403);
    const counted = await manager.post(`/reconciliation/settlements/${c.emp}/${today}/count`, { countedCash: '240' });
    expect(counted.body).toMatchObject({ status: 'MATCHED', difference: '0.00' });
  });

  it('shortage ₹500: explanation by one person, approval (step-up) by another; E11 recover from employee', async () => {
    const c = collectors[1]!;
    const loan = await loanFor(1);
    expect((await pay(c.client, loan, { amount: '2000', method: 'CASH' })).status).toBe(201);
    const s = await accountant.post(`/reconciliation/settlements/${c.emp}/${today}/count`, { countedCash: '1500' });
    expect(s.body).toMatchObject({ status: 'SHORT', difference: '500.00' });
    const id = s.body.id;
    expect((await accountant.post(`/reconciliation/settlements/${id}/differences`, { amount: '500', reasonCode: 'OTHER', resolution: 'CASH_EXCESS_INCOME', notes: 'wrong way round' })).status).toBe(400);
    expect((await accountant.post(`/reconciliation/settlements/${id}/differences`, { amount: '600', reasonCode: 'OTHER', resolution: 'RECOVER_FROM_EMPLOYEE', notes: 'too much' })).body.error.code).toBe('OVER_EXPLAINED');
    const d = await accountant.post(`/reconciliation/settlements/${id}/differences`, { amount: '500', reasonCode: 'OTHER', resolution: 'RECOVER_FROM_EMPLOYEE', notes: 'Collector admits paying a personal bill from collections' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await accountant.post(`/reconciliation/differences/${d.body.id}/approve`, {})).status).toBe(403); // no permission, and recorder
    expect((await manager.post(`/reconciliation/differences/${d.body.id}/approve`, {})).body.error.code).toBe('REAUTH_REQUIRED');
    await manager.reauth(t, managerUser);
    const a = await manager.post(`/reconciliation/differences/${d.body.id}/approve`, { note: 'Recover from salary' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const cash = await cashOf(c.emp);
    expect((await balance(cash)).toString()).toBe('1500.00'); // ledger now equals the cash counted
    const rec = await sql<{ b: string }>`SELECT coalesce(sum(debit - credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1410' AND l.employee_id = ${c.emp}`.execute(t.db);
    expect(rec.rows[0]!.b).toBe('500.00');
    const view = (await manager.get(`/reconciliation/settlements/${c.emp}/${today}`)).body;
    expect(view.status).toBe('APPROVED');
    expect(view.stale).toBe(false); // the adjustment doesn't make the count stale
  });

  it('excess ₹200 to income; differences above the threshold need Management', async () => {
    const c = collectors[2]!;
    const loan = await loanFor(2);
    expect((await pay(c.client, loan, { amount: '3000', method: 'CASH' })).status).toBe(201);
    const s = await manager.post(`/reconciliation/settlements/${c.emp}/${today}/count`, { countedCash: '4700' });
    expect(s.body).toMatchObject({ status: 'EXCESS', difference: '-1700.00' });
    const big = await manager.post(`/reconciliation/settlements/${s.body.id}/differences`, { amount: '1500', reasonCode: 'OTHER', resolution: 'TO_SUSPENSE', notes: 'Customer overpaid, not yet identified' });
    const small = await manager.post(`/reconciliation/settlements/${s.body.id}/differences`, { amount: '200', reasonCode: 'COUNTING_ERROR', resolution: 'CASH_EXCESS_INCOME', notes: 'Change not given back' });
    await manager2.reauth(t, manager2User);
    expect((await manager2.post(`/reconciliation/differences/${big.body.id}/approve`, {})).body.error.code).toBe('NEEDS_MANAGEMENT');
    expect((await manager2.post(`/reconciliation/differences/${small.body.id}/approve`, {})).status).toBe(200);
    await management.reauth(t, managementUser);
    expect((await management.post(`/reconciliation/differences/${big.body.id}/approve`, {})).status).toBe(200);
    expect((await manager.get(`/reconciliation/settlements/${c.emp}/${today}`)).body.status).toBe('APPROVED');
    expect((await balance(await cashOf(c.emp))).toString()).toBe('4700.00');
  });
});

describe('statements and matching', () => {
  let upiPayment: string;
  let neftPayment: string;
  let upiRef: string;
  let neftRef: string;
  const csv = (rows: string[]) => ['Txn Date,Narration,Ref No,Withdrawal,Deposit,Balance', ...rows].join('\n');
  const mapping = { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5, dateFormat: 'DD/MM/YYYY' };
  const d = today.split('-').reverse().join('/');

  it('imports, auto-confirms exact reference matches (UPI → E7), suggests amount/date matches, refuses invalid rows', async () => {
    const loan = await loanFor(0);
    upiRef = `6275${String(Date.now()).slice(-8)}`;
    neftRef = `SBIN5262${String(Date.now()).slice(-8)}`;
    const u = await pay(collectors[0]!.client, loan, { amount: '777', method: 'UPI', reference: upiRef });
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    upiPayment = u.body.id;
    const n = await pay(manager, loan, { amount: '888', method: 'BANK_TRANSFER', reference: neftRef, accountId: bankId });
    neftPayment = n.body.id;
    const clearing = await code('1250-RECN');
    const clearingBefore = await balance(clearing);
    const file = csv([
      `${d},UPI/${upiRef}/RECON CUSTOMER/okaxis,,,777.00,1000777.00`,
      `${d},NEFT-${neftRef}-RECON CUSTOMER,${neftRef},,888.00,1001665.00`,
      `${d},BY CASH CNB-7781,,,"1,000.00",1002665.00`,
      `${d},IMPS UNKNOWN SENDER 998877,,,4321.00,1006986.00`,
      `${d},SMS CHARGES,,17.70,,1006968.30`,
      `99/99/2026,BROKEN ROW,,,5.00,`,
    ]);
    const refused = await accountant.upload('/reconciliation/statements', { accountId: bankId, ...mapping }, { name: 'canara.csv', content: file });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('INVALID_ROWS');
    expect(refused.body.error.details.invalid[0]).toMatchObject({ row: 7 });
    const preview = await accountant.upload('/reconciliation/statements/preview', { accountId: bankId, ...mapping }, { name: 'canara.csv', content: file });
    expect(preview.body).toMatchObject({ new: 5, duplicate: 0 });
    const ok = await accountant.upload('/reconciliation/statements', { accountId: bankId, acceptInvalid: true, ...mapping }, { name: 'canara.csv', content: file });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ new: 5, invalid: 1 });
    expect(ok.body.matching.autoConfirmed).toBe(3); // UPI and NEFT by UTR, cash deposit by its slip number

    const p1 = await t.db.selectFrom('payments').select(['reconciliation_status']).where('id', '=', upiPayment).executeTakeFirstOrThrow();
    expect(p1.reconciliation_status).toBe('MATCHED');
    expect((await t.db.selectFrom('payments').select('reconciliation_status').where('id', '=', neftPayment).executeTakeFirstOrThrow()).reconciliation_status).toBe('MATCHED');
    expect((await balance(clearing)).toString()).toBe(clearingBefore.minus(Money.of('777')).toString()); // E7 moved it to the bank

    // The cash deposit's slip number is in the narration, so it matched exactly too.
    const lines = (await accountant.get(`/reconciliation/statements/lines?accountId=${bankId}`)).body.data;
    const dep = lines.find((l: { description: string }) => l.description.includes('CNB-7781'));
    expect(dep.match_status).toBe('MATCHED');
    const unknown = lines.find((l: { description: string }) => l.description.includes('UNKNOWN'));
    expect(unknown.match_status).toBe('UNMATCHED');
    const charges = lines.find((l: { description: string }) => l.description.includes('SMS'));

    // Re-importing the same file adds nothing.
    const again = await accountant.upload('/reconciliation/statements', { accountId: bankId, acceptInvalid: true, ...mapping }, { name: 'canara-again.csv', content: file });
    expect(again.body).toMatchObject({ new: 0, duplicate: 5 });

    // Unidentified credit → suspense; bank charges explained.
    const suspenseBefore = await balance(await code('2250'));
    const sus = await accountant.post(`/reconciliation/statements/lines/${unknown.id}/suspense`, { reason: 'Sender not identified; asked the bank for details' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(suspenseBefore.minus(await balance(await code('2250'))).toString()).toBe('4321.00');
    expect((await accountant.post(`/reconciliation/statements/lines/${charges.id}/ignore`, { reason: 'Bank SMS charges, booked monthly as an expense' })).status).toBe(200);
    expect((await collectors[0]!.client.get('/reconciliation/statements/lines')).status).toBe(403);
  });

  it('a payment confirmed on the statement cannot be reversed until the match is undone (E7 reversed)', async () => {
    const r = await collectors[0]!.client.post(`/payments/${upiPayment}/reversal`, { reasonCode: 'WRONG_AMOUNT', reasonText: 'Typed the wrong amount' });
    expect(r.body.error.code).toBe('RECONCILED');
    const m = await t.db.selectFrom('reconciliation_matches').select('id').where('target_id', '=', upiPayment).where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
    const clearing = await code('1250-RECN');
    const before = await balance(clearing);
    expect((await accountant.post(`/reconciliation/matches/${m.id}/undo`, { reason: 'Matched to the wrong customer' })).status).toBe(200);
    expect((await balance(clearing)).toString()).toBe(before.plus(Money.of('777')).toString());
    expect((await t.db.selectFrom('payments').select('reconciliation_status').where('id', '=', upiPayment).executeTakeFirstOrThrow()).reconciliation_status).toBe('UNRECONCILED');
    // Matching again finds it again (exact UTR) and re-confirms.
    const again = await accountant.post('/reconciliation/statements/match', { accountId: bankId });
    expect(again.body.autoConfirmed).toBe(1);
  });

  it('amount + date only is suggested, never auto-confirmed', async () => {
    const loan = await loanFor(0);
    const p = await pay(manager, loan, { amount: '432.10', method: 'BANK_TRANSFER', reference: `UTRX${Date.now()}`, accountId: bankId });
    expect(p.status).toBe(201);
    const file = csv([`${d},CREDIT FROM CUSTOMER,,,432.10,`]);
    const r = await accountant.upload('/reconciliation/statements', { accountId: bankId, ...mapping }, { name: 'c2.csv', content: file });
    expect(r.body.matching).toMatchObject({ suggested: 1, autoConfirmed: 0 });
    expect((await t.db.selectFrom('payments').select('reconciliation_status').where('id', '=', p.body.id).executeTakeFirstOrThrow()).reconciliation_status).toBe('UNRECONCILED');
    const line = (await accountant.get('/reconciliation/statements/lines?status=SUGGESTED')).body.data.find((l: { credit: string }) => l.credit === '432.10');
    expect((await accountant.post(`/reconciliation/matches/${line.matches[0].id}/confirm`)).status).toBe(200);
    expect((await t.db.selectFrom('payments').select('reconciliation_status').where('id', '=', p.body.id).executeTakeFirstOrThrow()).reconciliation_status).toBe('MATCHED');
  });

  it('bank reconciliation lists what explains the gap', async () => {
    const r = (await accountant.get(`/reconciliation/bank/${bankId}?asOf=${today}`)).body;
    expect(r.statementBalance).toBe('1006968.30');
    expect(r.bookOnly.some((x: { kind: string }) => x.kind === 'Disbursement')).toBe(true);
    expect(r.statementOnly.some((x: { match_status: string }) => x.match_status === 'IGNORED')).toBe(true);
    expect(Money.of(r.ledgerBalance).minus(Money.of(r.adjustedStatementBalance)).toString()).toBe(Money.of(r.unexplained).toString());
  });
});

describe('day close', () => {
  it('blocks until every cash count is reconciled; stale counts must be redone; closing blocks money postings; reopen needs two people', async () => {
    const c = collectors[0]!;
    // New cash after counting makes collector 0's count stale.
    const loan = await loanFor(0);
    await pay(c.client, loan, { amount: '100', method: 'CASH' });
    const board = (await manager.get(`/reconciliation/days/${br}/${today}`)).body;
    expect(board.canClose).toBe(false);
    expect(board.blockers.join(' ')).toMatch(/count again/);
    const refused = await accountant.post(`/reconciliation/days/${br}/${today}/close`);
    expect(refused.body.error.code).toBe('NOT_RECONCILED');
    const exp = (await manager.get(`/reconciliation/settlements/${c.emp}/${today}`)).body.figures.expected;
    expect((await manager.post(`/reconciliation/settlements/${c.emp}/${today}/count`, { countedCash: exp })).body.status).toBe('MATCHED');
    const closed = await accountant.post(`/reconciliation/days/${br}/${today}/close`);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const blocked = await pay(c.client, loan, { amount: '50', method: 'CASH' });
    expect(blocked.body.error.code).toBe('DAY_CLOSED');
    await expect(
      t.db.transaction().execute(async (tx) => {
        await tx.insertInto('journal_entries').values({ entry_no: `XD${Date.now()}`, entry_type: 'PAYMENT', value_date: today, branch_id: br, narration: 'bypass' }).execute();
      }),
    ).rejects.toThrow(/closed/);

    expect((await accountant.post(`/reconciliation/days/${br}/${today}/reopen-request`, { reason: 'A late payment must go on today' })).status).toBe(200);
    expect((await accountant.post(`/reconciliation/days/${br}/${today}/reopen`)).status).toBe(403);
    await management.reauth(t, managementUser);
    expect((await management.post(`/reconciliation/days/${br}/${today}/reopen`)).body.status).toBe('OPEN');
    expect((await pay(c.client, loan, { amount: '50', method: 'CASH' })).status).toBe(201);
  });

  it('board shows reconciled and difference cells; unconfirmed UPI receipts are listed', async () => {
    const b = (await management.get(`/reconciliation/board?branchId=${br}`)).body;
    const cells = b.branches[0].employees.map((e: { cells: { date: string; state: string }[] }) => e.cells.find((x) => x.date === today)!.state);
    expect(cells).toContain('RECONCILED');
    const loan = await loanFor(1);
    await pay(collectors[1]!.client, loan, { amount: '321', method: 'UPI', reference: `9988${String(Date.now()).slice(-8)}` });
    const u = (await manager.get('/reconciliation/unconfirmed-receipts?days=0')).body.data;
    expect(u.some((x: { amount: string }) => x.amount === '321.00')).toBe(true);
  });
});
