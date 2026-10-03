import { addDays, addMonthsAnchored } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { istToday } from '../common/dates';
import { branchId, Client, createTestApp, newKey, signedIn, TestApp, TestUser } from '../test/harness';

let t: TestApp;
let kkd: string;
let admin: Client;
let manager: Client; // KKD branch manager
let managerUser: TestUser;
let manager2: Client; // second KKD branch manager
let accountant: Client;
let accountantUser: TestUser;
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

async function code(c: string) {
  return (await t.db.selectFrom('accounts').select('id').where('code', '=', c).executeTakeFirstOrThrow()).id;
}
async function balance(accountId: string) {
  const r = await sql<{ b: string }>`SELECT coalesce(sum(debit - credit), 0)::text b FROM journal_lines WHERE account_id = ${accountId}`.execute(t.db);
  return r.rows[0]!.b;
}
async function cashAccount(empId: string) {
  return (await t.db.selectFrom('accounts').select('id').where('employee_id', '=', empId).where('subtype', '=', 'EMPLOYEE_CASH').executeTakeFirstOrThrow()).id;
}
async function category(name: string) {
  return (await t.db.selectFrom('expense_categories').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;
}

/** Active ₹12,000 loan (24% flat, 12 monthly), assigned to the collector. */
async function activeLoan() {
  const n = ++seq;
  const c = await manager.post('/customers', { branchId: kkd, fullName: `Books Customer ${n}`, mobile: '9848011111' }, { 'Idempotency-Key': newKey() });
  await t.db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', '=', c.body.id).execute();
  const start = addMonthsAnchored(today, -1);
  const l = await manager.post(
    '/loans',
    {
      customerId: c.body.id, productId, principal: '12000', annualRate: '24', frequency: 'MONTHLY', numInstallments: 12,
      disbursementDate: start, firstDueDate: addMonthsAnchored(start, 1),
      asset: { make: 'Hero', model: 'Glamour', manufactureYear: 2026, chassisNo: `MBACC${String(Date.now()).slice(-7)}${n}`, engineNo: `EACC${n}${Date.now() % 100000}`, assetValue: '80000' },
    },
    { 'Idempotency-Key': newKey() },
  );
  expect(l.status, JSON.stringify(l.body)).toBe(201);
  await manager.post(`/loans/${l.body.id}/submit`);
  expect((await manager2.post(`/loans/${l.body.id}/approve`, {})).status).toBe(200);
  expect((await manager.post(`/loans/${l.body.id}/disburse`, { accountId: bankId, mode: 'BANK_TRANSFER', reference: `D${Date.now()}${n}`, disbursedOn: start }, { 'Idempotency-Key': newKey() })).status).toBe(200);
  await manager.post('/collections/assign', { loanIds: [l.body.id], employeeId: collectorEmp });
  return l.body.id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  kkd = await branchId(t.db, 'KKD');
  ({ client: admin } = await signedIn(t, ['SUPER_ADMIN']));
  ({ client: manager, user: managerUser } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  ({ client: manager2 } = await signedIn(t, ['BRANCH_MANAGER'], { branches: ['KKD'] }));
  ({ client: accountant, user: accountantUser } = await signedIn(t, ['ACCOUNTANT'], { branches: ['KKD'] }));
  ({ client: accountant2, user: accountant2User } = await signedIn(t, ['ACCOUNTANT'], { branches: ['KKD'] }));
  ({ client: management, user: managementUser } = await signedIn(t, ['MANAGEMENT']));
  const c = await signedIn(t, ['COLLECTION_EMPLOYEE'], { branches: ['KKD'] });
  collectorEmp = (await t.db.insertInto('employees').values({ branch_id: kkd, user_id: c.user.id, employee_code: `EACC${Date.now() % 100000}`, full_name: 'Books Collector', is_collector: true }).returning('id').executeTakeFirstOrThrow()).id;
  collector = await new Client(t.server).login(t, c.user);
  await t.db.insertInto('employees').values({ branch_id: kkd, user_id: managerUser.id, employee_code: `EMGR${Date.now() % 100000}`, full_name: 'Books Manager' }).execute();
  manager = await new Client(t.server).login(t, managerUser);
  const p = await admin.post('/loan-products', {
    code: 'TW-ACC', name: '2W (accounting tests)', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateMin: '12', rateDefault: '24', rateMax: '30',
    amountMin: '5000', amountMax: '300000', tenureMin: 3, tenureMax: 36, allowedFrequencies: ['MONTHLY'], roundingUnit: '1', feeRules: [],
    penaltyRule: { type: 'NONE', value: '0', graceDays: 0 },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  productId = p.body.id;
  const b = await admin.post('/accounts/bank', { name: 'ICICI Current A/c', bankName: 'ICICI Bank', accountNumber: '002105001234', ifsc: 'ICIC0000021', kind: 'CURRENT' });
  bankId = b.body.id;
});
afterAll(async () => {
  await t.db.updateTable('accounting_periods').set({ status: 'OPEN' }).execute(); // never leave locks for other suites
  await t.close();
});

describe('expenses', () => {
  it('collector claims from own cash → manager approves → accountant posts (Dr expense / Cr cash in hand)', async () => {
    const e = await collector.post('/expenses', { branchId: kkd, categoryId: await category('Fuel'), amount: '450', expenseDate: today, paidFrom: 'EMPLOYEE_CASH', vendor: 'HP Petrol Bunk', description: 'Petrol for field visits' });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(e.body.expense_no).toMatch(/^EXP-\d{4}-\d{6}$/);
    expect((await collector.post(`/expenses/${e.body.id}/approve`)).status).toBe(403);
    expect((await accountant.post(`/expenses/${e.body.id}/post`)).body.error.code).toBe('INVALID_STATE'); // not approved yet
    expect((await manager.post(`/expenses/${e.body.id}/approve`)).status).toBe(200);
    expect((await manager.post(`/expenses/${e.body.id}/post`)).status).toBe(403);
    const posted = await accountant.post(`/expenses/${e.body.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const exp = await t.db.selectFrom('expenses').selectAll().where('id', '=', e.body.id).executeTakeFirstOrThrow();
    const lines = await t.db.selectFrom('journal_lines as l').innerJoin('accounts as a', 'a.id', 'l.account_id').select(['a.code', 'l.debit', 'l.credit', 'l.employee_id']).where('l.entry_id', '=', exp.journal_entry_id!).orderBy('l.line_no').execute();
    expect(lines[0]).toMatchObject({ code: '5300', debit: '450.00' });
    expect(lines[1]).toMatchObject({ credit: '450.00', employee_id: collectorEmp });
    expect(lines[1]!.code).toMatch(/^1120-/);
    await expect(t.db.updateTable('expenses').set({ amount: '1' }).where('id', '=', e.body.id).execute()).rejects.toThrow(/posted and cannot be changed/);
    await expect(t.db.deleteFrom('expenses').where('id', '=', e.body.id).execute()).rejects.toThrow(/permanent/);
    // The collector sees their own claim, not other people's.
    expect((await collector.get('/expenses')).body.data.every((x: { submitted_by: string }) => x.submitted_by !== accountantUser.id)).toBe(true);
  });

  it('nobody approves or posts their own expense; collectors can only claim own cash', async () => {
    const e = await manager.post('/expenses', { branchId: kkd, categoryId: await category('Office expenses'), amount: '1200', expenseDate: today, paidFrom: 'BRANCH_CASH', description: 'Printer cartridge' });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect((await manager.post(`/expenses/${e.body.id}/approve`)).body.error.code).toBe('MAKER_CHECKER');
    expect((await collector.post('/expenses', { branchId: kkd, categoryId: await category('Fuel'), amount: '10', expenseDate: today, paidFrom: 'BRANCH_CASH', description: 'x x x' })).status).toBe(403);
    const own = await accountant.post('/expenses', { branchId: kkd, categoryId: await category('Bank charges'), amount: '59', expenseDate: today, paidFrom: 'BANK', accountId: bankId, description: 'SMS alert charges' });
    await manager.post(`/expenses/${own.body.id}/approve`);
    expect((await accountant.post(`/expenses/${own.body.id}/post`)).body.error.code).toBe('MAKER_CHECKER');
    expect((await accountant2.post(`/expenses/${own.body.id}/post`)).status).toBe(200);
    expect((await accountant.post('/expenses', { branchId: kkd, categoryId: await category('Rent'), amount: '100', expenseDate: today, paidFrom: 'BANK', description: 'Rent' })).status).toBe(400);
    expect((await accountant.post('/expenses', { branchId: kkd, categoryId: await category('Rent'), amount: '100', expenseDate: addDays(today, 1), paidFrom: 'BRANCH_CASH', description: 'Rent' })).body.error.code).toBe('FUTURE_DATE');
  });

  it('reject, and reverse a posted expense (step-up; mirror entry)', async () => {
    const e = await manager.post('/expenses', { branchId: kkd, categoryId: await category('Travel'), amount: '300', expenseDate: today, paidFrom: 'BRANCH_CASH', description: 'Bus to Rajahmundry' });
    expect((await manager2.post(`/expenses/${e.body.id}/reject`, { reason: 'No ticket attached' })).body.status).toBe('REJECTED');
    const f = await manager.post('/expenses', { branchId: kkd, categoryId: await category('Travel'), amount: '320', expenseDate: today, paidFrom: 'BRANCH_CASH', description: 'Auto fare' });
    await manager2.post(`/expenses/${f.body.id}/approve`);
    await accountant.post(`/expenses/${f.body.id}/post`);
    expect((await accountant.post(`/expenses/${f.body.id}/reverse`, { reason: 'Posted to the wrong branch' })).body.error.code).toBe('REAUTH_REQUIRED');
    await accountant.reauth(t, accountantUser);
    const r = await accountant.post(`/expenses/${f.body.id}/reverse`, { reason: 'Posted to the wrong branch' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const x = (await accountant.get(`/expenses/${f.body.id}`)).body;
    expect(x.status).toBe('REVERSED');
    const rev = await t.db.selectFrom('journal_entries').select(['entry_type', 'reverses_entry_id']).where('id', '=', x.reversal_journal_entry_id).executeTakeFirstOrThrow();
    expect(rev).toEqual({ entry_type: 'REVERSAL', reverses_entry_id: x.journal_entry_id });
  });
});

describe('cash deposits', () => {
  it('collector cash → bank; cannot deposit more than held; reversal needs a second person', async () => {
    const loan = await activeLoan();
    const p = await collector.post(`/loans/${loan}/payments`, { amount: '1240', method: 'CASH' }, { 'Idempotency-Key': newKey() });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const cash = await cashAccount(collectorEmp);
    const held = Money.of(await balance(cash));
    expect(held.isPositive()).toBe(true);
    const tooMuch = await accountant.post('/banking/deposits', { fromAccountId: cash, toAccountId: bankId, amount: held.plus(Money.of('1')).toString(), depositedOn: today });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_CASH');
    const bankBefore = Money.of(await balance(bankId));
    const d = await accountant.post('/banking/deposits', { fromAccountId: cash, toAccountId: bankId, amount: '500', depositedOn: today, slipNo: 'SBI-55821' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect(d.body.depositNo).toMatch(/^DEP-\d{4}-\d{6}$/);
    expect(Money.of(await balance(cash)).toString()).toBe(held.minus(Money.of('500')).toString());
    expect(Money.of(await balance(bankId)).minus(bankBefore).toString()).toBe('500.00');
    expect((await accountant.post(`/banking/deposits/${d.body.id}/reverse`, { reason: 'Bank says slip not credited' })).body.error.code).toBe('MAKER_CHECKER');
    expect((await manager.post(`/banking/deposits/${d.body.id}/reverse`, { reason: 'Bank says slip not credited' })).status).toBe(200);
    expect(Money.of(await balance(cash)).toString()).toBe(held.toString());
    expect((await collector.post('/banking/deposits', { fromAccountId: cash, toAccountId: bankId, amount: '1', depositedOn: today })).status).toBe(403);
  });

  it('hand over to branch cash within the branch only', async () => {
    const cash = await cashAccount(collectorEmp);
    const r = await manager.post('/banking/deposits', { fromAccountId: cash, toAccountId: await code('1110-KKD'), amount: '100', depositedOn: today });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const other = await admin.post('/banking/deposits', { fromAccountId: cash, toAccountId: await code('1110-RJY'), amount: '1', depositedOn: today });
    expect(other.body.error.code).toBe('BRANCH_MISMATCH');
  });
});

describe('cheques', () => {
  const chequePay = async (loan: string, no: string) => {
    const r = await manager.post(`/loans/${loan}/payments`, { amount: '1240', method: 'CHEQUE', reference: no, chequeBank: 'Andhra Bank', chequeDate: today }, { 'Idempotency-Key': newKey() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };

  it('deposit (Dr bank / Cr cheques in hand) → clear', async () => {
    const loan = await activeLoan();
    const id = await chequePay(loan, `C${++seq}01`);
    const inHand = await code('1130-KKD');
    const before = Money.of(await balance(inHand));
    const d = await accountant.post(`/banking/cheques/${id}/deposit`, { accountId: bankId, depositedOn: today });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(Money.of(await balance(inHand)).toString()).toBe(before.minus(Money.of('1240')).toString());
    expect((await accountant.post(`/banking/cheques/${id}/deposit`, { accountId: bankId, depositedOn: today })).status).toBe(409);
    expect((await accountant.post(`/banking/cheques/${id}/clear`, { clearedOn: today })).body.chequeStatus).toBe('CLEARED');
    const list = (await accountant.get('/banking/cheques?status=CLEARED')).body.data;
    expect(list.some((c: { id: string }) => c.id === id)).toBe(true);
  });

  it('bounce after deposit: bank and installments restored, receipt cancelled, bounce charge added', async () => {
    const loan = await activeLoan();
    const instBefore = await t.db.selectFrom('loan_installments').select(['installment_no', 'total_paid', 'fees_due']).where('loan_id', '=', loan).orderBy('installment_no').execute();
    const id = await chequePay(loan, `C${++seq}02`);
    await accountant.post(`/banking/cheques/${id}/deposit`, { accountId: bankId, depositedOn: today });
    const bankBefore = Money.of(await balance(bankId));
    await accountant.reauth(t, accountantUser);
    const b = await accountant.post(`/banking/cheques/${id}/bounce`, { bouncedOn: today, reason: 'Funds insufficient', charge: '500' });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(Money.of(await balance(bankId)).toString()).toBe(bankBefore.minus(Money.of('1240')).toString());
    const p = (await admin.get(`/payments/${id}`)).body;
    expect(p).toMatchObject({ status: 'REVERSED', cheque_status: 'BOUNCED' });
    expect(p.receipt.status).toBe('CANCELLED');
    const after = await t.db.selectFrom('loan_installments').select(['installment_no', 'total_paid', 'fees_due']).where('loan_id', '=', loan).orderBy('installment_no').execute();
    expect(after.map((i) => i.total_paid)).toEqual(instBefore.map((i) => i.total_paid));
    expect(after[0]!.fees_due).toBe('500.00');
    const l = await t.db.selectFrom('loans').select(['fees_outstanding', 'principal_outstanding']).where('id', '=', loan).executeTakeFirstOrThrow();
    expect(l.fees_outstanding).toBe('500.00');
    const r1330 = await sql<{ b: string }>`SELECT coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1330' AND l.loan_id = ${loan}`.execute(t.db);
    expect(r1330.rows[0]!.b).toBe('500.00');
  });

  it('bounce before deposit just reverses the payment', async () => {
    const loan = await activeLoan();
    const id = await chequePay(loan, `C${++seq}03`);
    const inHand = await code('1130-KKD');
    const before = Money.of(await balance(inHand));
    await accountant.reauth(t, accountantUser);
    expect((await accountant.post(`/banking/cheques/${id}/bounce`, { bouncedOn: today, reason: 'Signature mismatch' })).status).toBe(200);
    expect(Money.of(await balance(inHand)).toString()).toBe(before.minus(Money.of('1240')).toString());
    expect((await collector.post(`/banking/cheques/${id}/bounce`, { bouncedOn: today, reason: 'x x x' })).status).toBe(403);
  });
});

describe('manual journals', () => {
  it('validate, then a second accountant approves with step-up; the entry carries both names', async () => {
    const office = await code('5400');
    const cash = await code('1110-KKD');
    const unbalanced = await accountant.post('/manual-journals', { valueDate: today, branchId: kkd, narration: 'Petty cash correction', lines: [{ accountId: office, debit: '100' }, { accountId: cash, credit: '90' }] });
    expect(unbalanced.status).toBe(400);
    const control = await accountant.post('/manual-journals', { valueDate: today, branchId: kkd, narration: 'Try to touch loans', lines: [{ accountId: await code('1310'), debit: '100' }, { accountId: cash, credit: '100' }] });
    expect(control.status).toBe(400);
    expect(control.body.error.details[0].message).toMatch(/kept in step with loans/);
    const ok = await accountant.post('/manual-journals', { valueDate: today, branchId: kkd, narration: 'Stationery bought from petty cash last week', lines: [{ accountId: office, debit: '240', memo: 'Registers' }, { accountId: cash, credit: '240' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await accountant.post(`/manual-journals/${ok.body.id}/approve`, {})).status).toBe(403);
    expect((await accountant2.post(`/manual-journals/${ok.body.id}/approve`, {})).body.error.code).toBe('REAUTH_REQUIRED');
    await accountant2.reauth(t, accountant2User);
    const a = await accountant2.post(`/manual-journals/${ok.body.id}/approve`, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const m = await t.db.selectFrom('manual_journals').select('journal_entry_id').where('id', '=', ok.body.id).executeTakeFirstOrThrow();
    const e = (await accountant.get(`/journals/${m.journal_entry_id}`)).body;
    expect(e).toMatchObject({ entry_type: 'MANUAL', created_by_name: expect.any(String), approved_by_name: expect.any(String) });
    expect(e.created_by_name).not.toBe(e.approved_by_name);
    expect(e.lines).toHaveLength(2);
    const list = (await accountant.get('/journals?type=MANUAL')).body.data;
    expect(list.some((j: { id: string }) => j.id === m.journal_entry_id)).toBe(true);
  });
});

describe('periods', () => {
  it('soft-lock (accountant) blocks new entries; lock (management); reopen needs a reason and step-up', async () => {
    const last = addMonthsAnchored(`${today.slice(0, 7)}-01`, -1);
    const month = last.slice(0, 7);
    expect((await accountant.post(`/periods/${today.slice(0, 7)}/soft-lock`)).body.error.code).toBe('MONTH_NOT_OVER');
    expect((await accountant.post(`/periods/${month}/soft-lock`)).status).toBe(200);
    const e = await manager.post('/expenses', { branchId: kkd, categoryId: await category('Fuel'), amount: '50', expenseDate: last, paidFrom: 'BRANCH_CASH', description: 'Late claim' });
    await manager2.post(`/expenses/${e.body.id}/approve`);
    const blocked = await accountant.post(`/expenses/${e.body.id}/post`);
    expect(blocked.body.error.code).toBe('PERIOD_SOFT_LOCKED');
    expect((await accountant.post(`/periods/${month}/lock`)).status).toBe(403);
    expect((await management.post(`/periods/${month}/lock`)).status).toBe(200);
    expect((await accountant.post(`/expenses/${e.body.id}/post`)).body.error.code).toBe('PERIOD_LOCKED');
    // The database refuses it too, even bypassing the API.
    await expect(
      t.db.transaction().execute(async (tx) => {
        await tx.insertInto('journal_entries').values({ entry_no: `X${Date.now()}`, entry_type: 'MANUAL', value_date: last, narration: 'bypass' }).execute();
      }),
    ).rejects.toThrow(/locked/);
    expect((await management.post(`/periods/${month}/reopen`, { reason: 'CA asked for a late fuel claim to be included' })).body.error.code).toBe('REAUTH_REQUIRED');
    await management.reauth(t, managementUser);
    expect((await management.post(`/periods/${month}/reopen`, { reason: 'short' })).status).toBe(400);
    expect((await management.post(`/periods/${month}/reopen`, { reason: 'CA asked for a late fuel claim to be included' })).status).toBe(200);
    expect((await accountant.post(`/expenses/${e.body.id}/post`)).status).toBe(200);
    const periods = (await accountant.get('/periods')).body.data;
    expect(periods.find((p: { month: string }) => p.month === month)).toMatchObject({ status: 'OPEN', unlock_reason: expect.stringMatching(/late fuel/) });
  });
});

describe('books', () => {
  it('trial balance balances; P&L and balance sheet tie; cash/bank summary adds up; Excel exports', async () => {
    const tb = (await admin.get(`/books/trial-balance?asOf=${today}`)).body;
    expect(tb.totals.balanced, JSON.stringify(tb.totals)).toBe(true);
    const pl = (await admin.get(`/books/profit-loss?from=${today.slice(0, 4)}-01-01&to=${today}`)).body;
    expect(Money.of(pl.totals.income).minus(Money.of(pl.totals.expenses)).toString()).toBe(pl.totals.net);
    expect(pl.expenses.some((e: { code: string }) => e.code === '5300')).toBe(true);
    const bs = (await admin.get(`/books/balance-sheet?asOf=${today}`)).body;
    expect(bs.totals.balanced, JSON.stringify({ totals: bs.totals, profit: bs.profit })).toBe(true);
    const sum = (await admin.get(`/books/summary?from=${addDays(today, -40)}&to=${today}`)).body;
    for (const a of sum.data) expect(Money.of(a.opening).plus(Money.of(a.receipts)).minus(Money.of(a.payments)).toString()).toBe(Money.of(a.closing).toString());
    expect(sum.data.some((a: { subtype: string }) => a.subtype === 'EMPLOYEE_CASH')).toBe(true);
    const day = (await admin.get(`/books/day?date=${today}`)).body;
    expect(day.entries.length).toBeGreaterThan(0);
    expect(Money.of(day.total).isPositive()).toBe(true);
    for (const p of [`/books/trial-balance?asOf=${today}&format=xlsx`, `/books/profit-loss?from=${today}&to=${today}&format=xlsx`, `/books/balance-sheet?asOf=${today}&format=xlsx`, `/books/day?date=${today}&format=xlsx`, `/books/summary?from=${today}&to=${today}&format=xlsx`]) {
      const x = await admin.download(p);
      expect(x.status, p).toBe(200);
      expect(x.bytes.subarray(0, 2).toString()).toBe('PK');
    }
  });

  it('branch-scoped accountants see their branches only; others cannot see books', async () => {
    const all = (await admin.get(`/books/trial-balance?asOf=${today}`)).body;
    const mine = (await accountant.get(`/books/trial-balance?asOf=${today}`)).body;
    expect(mine.totals.balanced).toBe(true);
    expect(Money.of(mine.totals.debit).lte(Money.of(all.totals.debit))).toBe(true);
    expect((await manager.get(`/books/trial-balance?asOf=${today}`)).status).toBe(403);
    expect((await collector.get('/journals')).status).toBe(403);
  });
});
