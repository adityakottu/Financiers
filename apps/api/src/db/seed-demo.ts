import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/password';
import { CryptoService } from '../common/crypto.service';
import { loadConfig } from '../config/config';
import { NumberingService } from '../numbering/numbering.service';
import { createDb } from './db';
import { seed } from './seed';
import { NestFactory } from '@nestjs/core';
import { ALL_PERMISSIONS, paymentCreateSchema } from '@fin/contracts';
import { AppModule } from '../app.module';
import type { RequestContext } from '../auth/context';
import { istToday } from '../common/dates';
import { DB_TOKEN, Db } from './db';
import { JobsService } from '../jobs/jobs.service';
import { CollectionsService } from '../collections/collections.service';
import { PaymentsService } from '../collections/payments.service';
import { MessagingService } from '../messaging/messaging.service';
import { BankingService } from '../accounting/banking.service';
import { ExpensesService } from '../accounting/expenses.service';
import { ensureBranchAccounts, LedgerService } from '../ledger/ledger.service';
import { LoansService } from '../lending/loans.service';
import { StatementsService } from '../reconciliation/statements.service';
import { RecoveryService } from '../recovery/recovery.service';

/**
 * Synthetic demo data for local development and UI review (doc 12 §9).
 * Names, numbers and addresses are fictional. Refuses to run in production.
 */
const FIRST = ['Venkata', 'Srinivas', 'Lakshmi', 'Ramesh', 'Durga', 'Satyanarayana', 'Padma', 'Nagaraju', 'Sridevi', 'Suresh', 'Anjali', 'Chandra', 'Kishore', 'Bhavani', 'Prasad', 'Madhavi', 'Raju', 'Sunitha', 'Gopal', 'Vijaya'];
const LAST = ['Rao', 'Reddy', 'Naidu', 'Varma', 'Chowdary', 'Kumar', 'Devi', 'Murthy', 'Sastry', 'Babu'];
const PLACES: [string, string, string, string][] = [
  ['Pithapuram', 'Pithapuram', 'Kakinada', '533450'],
  ['Samalkot', 'Samalkot', 'Kakinada', '533440'],
  ['Peddapuram', 'Peddapuram', 'Kakinada', '533437'],
  ['Tuni', 'Tuni', 'Kakinada', '533401'],
  ['Kadiyam', 'Kadiyam', 'East Godavari', '533126'],
  ['Mandapeta', 'Mandapeta', 'Konaseema', '533308'],
  ['Kovvur', 'Kovvur', 'East Godavari', '534350'],
];
const JOBS = ['Auto driver', 'Kirana shop owner', 'Farmer', 'Tailor', 'Lorry owner', 'Teacher', 'Electrician', 'Vegetable vendor', 'Mechanic', 'Daily wage worker'];

const pick = <T>(a: T[], i: number) => a[i % a.length]!;

async function main() {
  await import('reflect-metadata');
  const config = loadConfig({ ...process.env, WORKERS: 'false' }); // no background relay or scheduler while seeding
  if (config.production) throw new Error('Refusing to load demo data in production');
  const demoPassword = process.env.DEMO_PASSWORD;
  if (!demoPassword) throw new Error('DEMO_PASSWORD is required');
  const db = createDb(config.databaseUrl, 2);
  const crypto = new CryptoService(config);
  const numbering = new NumberingService();

  await seed(db, {
    adminUsername: process.env.SEED_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? demoPassword,
    companyName: 'Godavari Finance Pvt Ltd',
  });

  await db.transaction().execute(async (tx) => {
    const company = await tx.selectFrom('companies').select('id').executeTakeFirstOrThrow();
    await tx
      .updateTable('companies')
      .set({ trade_name: 'Godavari Finance', address: 'Main Road, Kakinada, Andhra Pradesh 533001', phone: '0884-2345678', receipt_footer: 'Thank you. Please keep this receipt for your records.' })
      .execute();
    for (const [code, name] of [
      ['KKD', 'Kakinada'],
      ['RJY', 'Rajahmundry'],
    ]) {
      await tx.insertInto('branches').values({ company_id: company.id, code: code!, name: name!, address: `${name}, Andhra Pradesh` }).onConflict((oc) => oc.column('code').doNothing()).execute();
    }
    const branches = await tx.selectFrom('branches').select(['id', 'code', 'name']).execute();
    for (const b of branches) await ensureBranchAccounts(tx, b);
    const byCode = Object.fromEntries(branches.map((b) => [b.code, b.id]));
    const roles = Object.fromEntries((await tx.selectFrom('roles').select(['id', 'code']).execute()).map((r) => [r.code, r.id]));
    const hash = await hashPassword(demoPassword);

    const users: [string, string, string, string[]][] = [
      ['manager.kkd', 'Ravi Shankar', 'BRANCH_MANAGER', ['KKD']],
      ['manager.rjy', 'Sarada Devi', 'BRANCH_MANAGER', ['RJY']],
      ['collector.kkd', 'Naresh Babu', 'COLLECTION_EMPLOYEE', ['KKD']],
      ['accounts.kkd', 'Lakshmi Prasanna', 'ACCOUNTANT', ['KKD', 'RJY']],
    ];
    for (const [username, fullName, role, bcodes] of users) {
      const exists = await tx.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst();
      if (exists) continue;
      const u = await tx.insertInto('users').values({ username, full_name: fullName, password_hash: hash, must_change_password: false }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('user_roles').values({ user_id: u.id, role_id: roles[role]! }).execute();
      for (const bc of bcodes) await tx.insertInto('user_branches').values({ user_id: u.id, branch_id: byCode[bc]! }).execute();
      await tx
        .insertInto('employees')
        .values({ branch_id: byCode[bcodes[0]!]!, user_id: u.id, employee_code: `E-${username.split('.')[0]!.slice(0, 3).toUpperCase()}${bcodes[0]}`, full_name: fullName, designation: role === 'BRANCH_MANAGER' ? 'Branch Manager' : 'Field Officer', is_collector: role === 'COLLECTION_EMPLOYEE', mobile: '98480' + String(Math.floor(10000 + Math.random() * 89999)) })
        .onConflict((oc) => oc.column('employee_code').doNothing())
        .execute();
    }

    const existing = await tx.selectFrom('customers').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    if (Number(existing.n) > 0) return;
    const creator = await tx.selectFrom('users').select('id').where('username', '=', 'manager.kkd').executeTakeFirstOrThrow();
    for (let i = 0; i < 36; i++) {
      const branchCode = i % 3 === 2 ? 'RJY' : 'KKD';
      const [town, mandal, district, pin] = pick(PLACES, i * 7);
      const fullName = `${pick(FIRST, i * 3)} ${pick(LAST, i * 5)}`;
      const customerNo = await numbering.next(tx, 'CUSTOMER', { branchCode });
      const c = await tx
        .insertInto('customers')
        .values({
          id: undefined,
          customer_no: customerNo,
          branch_id: byCode[branchCode]!,
          full_name: fullName,
          relation_type: i % 4 === 1 ? 'W/O' : 'S/O',
          relation_name: `${pick(FIRST, i + 4)} ${pick(LAST, i * 5)}`,
          gender: i % 4 === 1 || i % 5 === 2 ? 'FEMALE' : 'MALE',
          dob: `19${70 + (i % 25)}-0${(i % 9) + 1}-1${i % 9}`,
          mobile: `9${String(700000000 + i * 1234567).slice(0, 9)}`,
          address_line1: `${10 + i}-${(i % 7) + 1}-${i + 3}, ${pick(['Gandhi Nagar', 'Ramalayam Street', 'Main Road', 'Rice Mill Road'], i)}`,
          village_town: town,
          mandal,
          district,
          state: 'Andhra Pradesh',
          pincode: pin,
          occupation: pick(JOBS, i),
          monthly_income: String(12000 + (i % 9) * 3500),
          whatsapp_opt_in: i % 3 !== 0,
          whatsapp_opt_in_at: i % 3 !== 0 ? new Date() : null,
          kyc_status: i % 4 === 0 ? 'VERIFIED' : i % 4 === 3 ? 'PENDING' : 'PARTIAL',
          created_by: creator.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (i % 4 !== 3) {
        const pan = `ABCPR${String(1000 + i).padStart(4, '0')}${String.fromCharCode(65 + (i % 26))}`;
        const verified = i % 4 === 0 ? new Date() : null;
        await tx
          .insertInto('customer_kyc_documents')
          .values([
            { customer_id: c.id, doc_type: 'PAN', number_enc: crypto.encrypt(pan, 'customer_kyc.PAN'), number_last4: pan.slice(-4), number_bidx: crypto.blindIndex('PAN', pan), key_version: 1, verified_at: verified, verified_by: verified ? creator.id : null, verification_method: verified ? 'Original document seen' : null },
            { customer_id: c.id, doc_type: 'AADHAAR', number_last4: String(1000 + ((i * 373) % 9000)), verified_at: verified, verified_by: verified ? creator.id : null, verification_method: verified ? 'Original document seen' : null },
          ])
          .execute();
      }
      await tx.insertInto('customer_references').values({ customer_id: c.id, name: `${pick(FIRST, i + 9)} ${pick(LAST, i + 2)}`, relationship: pick(['Brother', 'Neighbour', 'Employer', 'Cousin'], i), mobile: `8${String(500000000 + i * 7654321).slice(0, 9)}` }).execute();
      await tx.insertInto('customer_events').values({ customer_id: c.id, actor_id: creator.id, event_type: 'CUSTOMER_CREATED', summary: `Customer ${customerNo} created` }).execute();
    }
    await tx.insertInto('audit_logs').values({ action: 'system.demo_data_loaded', request_id: randomUUID(), hash: Buffer.alloc(0) }).execute();
  });
  await db.destroy();
  await seedLoans(config, demoPassword);
  console.log('demo data loaded');
}

/**
 * Loans are created through the real services (products, maker-checker approval, disbursement
 * journals, nightly jobs), so the demo exercises the same code paths as production.
 */
async function seedLoans(config: ReturnType<typeof loadConfig>, _pw: string) {
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error'] });
  const db = app.get<Db>(DB_TOKEN);
  const loans = app.get(LoansService);
  const jobs = app.get(JobsService);
  const ledger = app.get(LedgerService);
  if (await db.selectFrom('loans').select('id').executeTakeFirst()) {
    await app.close();
    return;
  }
  const users = Object.fromEntries((await db.selectFrom('users').select(['id', 'username', 'full_name']).execute()).map((u) => [u.username, u]));
  const ctx = (username: string): RequestContext => ({
    auth: {
      userId: users[username]!.id,
      username,
      fullName: users[username]!.full_name,
      sessionId: null as unknown as string,
      roles: ['SUPER_ADMIN'],
      permissions: new Set(ALL_PERMISSIONS),
      scope: 'ALL',
      branchIds: [],
      employeeId: null,
      restriction: null,
      reauthAt: null,
    },
    ip: '127.0.0.1',
    userAgent: 'demo-seed',
    requestId: randomUUID(),
  });
  const admin = ctx('admin');

  const base = {
    rateMin: '12', rateMax: '30', amountMin: '10000', tenureMin: 3, roundingUnit: '1' as const, skipSundays: false,
    allocationRule: { mode: 'INSTALLMENT_WISE' as const, order: ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'] as ('PENALTY' | 'FEE' | 'INTEREST' | 'PRINCIPAL')[], excessHandling: 'ADVANCE' as const },
  };
  const tw = await loans.createProduct(admin, {
    ...base, code: 'TW-STD', name: '2 Wheeler Standard', category: 'TWO_WHEELER', interestMethod: 'FLAT', rateDefault: '24',
    amountMax: '250000', tenureMax: 104, allowedFrequencies: ['MONTHLY', 'WEEKLY'], maxLtvPct: '90', approvalLimit: '150000',
    feeRules: [
      { code: 'PROCESSING', label: 'Processing fee', basis: 'PCT_OF_PRINCIPAL', value: '2', gstRatePct: '18', mode: 'DEDUCT_FROM_DISBURSAL' },
      { code: 'DOCUMENTATION', label: 'Documentation fee', basis: 'FLAT', value: '500', gstRatePct: '18', mode: 'ADD_TO_FIRST_INSTALLMENT' },
    ],
    penaltyRule: { type: 'FLAT_PER_INSTALLMENT', value: '150', graceDays: 3, cap: null },
  });
  const auto = await loans.createProduct(admin, {
    ...base, code: 'AUTO-3W', name: 'Auto-rickshaw Daily', category: 'THREE_WHEELER', interestMethod: 'FLAT', rateDefault: '26',
    amountMax: '400000', tenureMax: 400, allowedFrequencies: ['DAILY', 'WEEKLY'], skipSundays: true, maxLtvPct: '85', approvalLimit: '300000',
    feeRules: [{ code: 'PROCESSING', label: 'Processing fee', basis: 'FLAT', value: '2500', gstRatePct: '18', mode: 'DEDUCT_FROM_DISBURSAL' }],
    penaltyRule: { type: 'PCT_PA_ON_OVERDUE', value: '24', graceDays: 2, cap: null },
  });
  const elec = await loans.createProduct(admin, {
    ...base, code: 'ELEC', name: 'Consumer Electronics EMI', category: 'ELECTRONICS', interestMethod: 'REDUCING_EMI', rateDefault: '18',
    amountMin: '5000', amountMax: '150000', tenureMax: 24, allowedFrequencies: ['MONTHLY'],
    feeRules: [{ code: 'PROCESSING', label: 'Processing fee', basis: 'FLAT', value: '499', gstRatePct: '18', mode: 'ADD_TO_FIRST_INSTALLMENT' }],
    penaltyRule: { type: 'FLAT_PER_INSTALLMENT', value: '100', graceDays: 5, cap: null },
  });

  let bank!: { id: string };
  await db.transaction().execute(async (tx) => {
    bank = await ledger.createBankAccount(tx, { name: 'SBI Current A/c — Kakinada', bankName: 'State Bank of India', branchName: 'Kakinada Main', accountNumber: '30112233445', ifsc: 'SBIN0000812', kind: 'CURRENT' }, users.admin!.id);
    // Owners' capital in the bank and a cash float in each branch, before any lending.
    const { Money } = await import('@fin/money');
    const opening = new Date(`${istToday()}T00:00:00Z`);
    opening.setUTCMonth(opening.getUTCMonth() - 6);
    await ledger.post(tx, {
      entryType: 'OPENING',
      valueDate: opening.toISOString().slice(0, 10),
      branchId: null,
      sourceType: 'demo',
      sourceId: 'capital',
      narration: 'Capital introduced by the partners: bank balance and branch cash floats',
      lines: [
        { account: bank.id, debit: Money.of('2500000') },
        { account: '1110-KKD', debit: Money.of('25000') },
        { account: '1110-RJY', debit: Money.of('15000') },
        { account: '3100', credit: Money.of('2540000') },
      ],
      createdBy: users.admin!.id,
    });
  });

  const customers = await db.selectFrom('customers as c').innerJoin('branches as b', 'b.id', 'c.branch_id').select(['c.id', 'b.code']).orderBy('c.customer_no').execute();
  await db.updateTable('customers').set({ kyc_status: 'VERIFIED' }).where('id', 'in', customers.slice(0, 26).map((c) => c.id)).execute();
  const today = istToday();
  const makes = [['Hero', 'Splendor Plus'], ['Honda', 'Shine 125'], ['TVS', 'Jupiter'], ['Bajaj', 'Platina 110'], ['Hero', 'HF Deluxe']];
  const tvs = [['Samsung', 'Crystal 4K 43"', 'LED TV'], ['LG', '260L Frost-free', 'Refrigerator'], ['Whirlpool', '7kg Top Load', 'Washing machine'], ['Voltas', '1.5T Inverter', 'Split AC']];

  // plan: [product, months ago disbursed (null = not disbursed), final status, principal, frequency, installments]
  const plan: [string, number | null, string, string, string, number][] = [
    ['tw', 5, 'ACTIVE', '85000', 'MONTHLY', 24], ['tw', 4, 'ACTIVE', '110000', 'MONTHLY', 24], ['tw', 3, 'ACTIVE', '72000', 'MONTHLY', 18],
    ['tw', 2, 'ACTIVE', '95000', 'MONTHLY', 24], ['tw', 1, 'ACTIVE', '60000', 'WEEKLY', 52], ['tw', 0, 'ACTIVE', '98000', 'MONTHLY', 24],
    ['elec', 4, 'ACTIVE', '42000', 'MONTHLY', 12], ['elec', 2, 'ACTIVE', '28500', 'MONTHLY', 9], ['elec', 1, 'ACTIVE', '64000', 'MONTHLY', 12],
    ['auto', 2, 'ACTIVE', '280000', 'DAILY', 300], ['auto', 1, 'ACTIVE', '240000', 'WEEKLY', 104],
    ['tw', null, 'PENDING_APPROVAL', '90000', 'MONTHLY', 24], ['elec', null, 'PENDING_APPROVAL', '35000', 'MONTHLY', 12], ['auto', null, 'PENDING_APPROVAL', '320000', 'DAILY', 330],
    ['tw', null, 'APPROVED', '76000', 'MONTHLY', 18], ['elec', null, 'APPROVED', '22000', 'MONTHLY', 6],
    ['tw', null, 'DRAFT', '100000', 'MONTHLY', 24], ['tw', null, 'REJECTED', '150000', 'MONTHLY', 36],
  ];
  const products: Record<string, { id: string }> = { tw, auto, elec };
  const addMonths = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCMonth(t.getUTCMonth() + n);
    return t.toISOString().slice(0, 10);
  };
  const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

  for (let i = 0; i < plan.length; i++) {
    const [pk, monthsAgo, status, principal, frequency, n] = plan[i]!;
    const c = customers[i]!;
    const maker = ctx(c.code === 'RJY' ? 'manager.rjy' : 'manager.kkd');
    const start = monthsAgo === null ? today : addMonths(today, -monthsAgo);
    const firstDue = frequency === 'DAILY' ? addDays(start, 1) : frequency === 'WEEKLY' ? addDays(start, 7) : addMonths(start, 1);
    const isElec = pk === 'elec';
    const [make, model, desc] = isElec ? tvs[i % tvs.length]! : pk === 'auto' ? ['Bajaj', 'RE Compact', undefined] : makes[i % makes.length]!;
    const assetValue = String(Math.round((Number(principal) / (isElec ? 0.8 : 0.82)) / 1000) * 1000);
    const asset = isElec
      ? { description: desc, make, model, serialNo: `SN${2026000 + i}`, assetValue, dealerName: 'Sri Lakshmi Electronics', hypothecationMarked: false }
      : {
          make, model, manufactureYear: 2026, registrationNo: `AP${c.code === 'RJY' ? '05' : '39'}${pk === 'auto' ? 'TA' : 'BK'}${String(4100 + i * 37).slice(-4)}`,
          chassisNo: `MB${pk === 'auto' ? 'LAU' : 'LHA'}${String(740000 + i * 911)}X`, engineNo: `E${String(530000 + i * 733)}K`,
          vehicleType: pk === 'auto' ? 'Passenger auto-rickshaw' : undefined, assetValue, dealerName: 'Godavari Motors', insurer: 'New India Assurance',
          insurancePolicyNo: `NIA/${24000 + i}`, insuranceExpiry: addMonths(start, 12), hypothecationMarked: true,
        };
    const loan = await db.transaction().execute((tx) =>
      loans.create(tx, maker, {
        customerId: c.id, productId: products[pk]!.id, principal, annualRate: pk === 'elec' ? '18' : pk === 'auto' ? '26' : '24',
        frequency: frequency as 'MONTHLY', numInstallments: n, disbursementDate: start, firstDueDate: firstDue, asset: asset as never,
      }),
    );
    if (status === 'DRAFT') continue;
    await loans.submit(maker, loan.id);
    if (status === 'PENDING_APPROVAL') continue;
    if (status === 'REJECTED') {
      await loans.reject(admin, loan.id, 'Income proof does not support this amount');
      continue;
    }
    await loans.approve(admin, loan.id, 'Documents verified');
    if (status === 'APPROVED') continue;
    await db.transaction().execute((tx) => loans.disburse(tx, maker, loan.id, { accountId: bank.id, mode: 'BANK_TRANSFER', reference: `UTR${String(88120000 + i * 173)}`, disbursedOn: start }));
  }
  // Catch up end-of-day for the last 10 days so statuses, accruals and penalties are realistic.
  await db.deleteFrom('job_runs').execute();
  for (let k = 10; k >= 0; k--) await jobs.runDaily(addDays(today, -k), { userId: null });

  // Collections today, through the real services: assignment, payments with receipts, a reversal
  // waiting for approval, visits and a promise to pay. Nothing is written around the services.
  const collections = app.get(CollectionsService);
  const payments = app.get(PaymentsService);
  const messaging = app.get(MessagingService);
  const collectorEmp = await db.selectFrom('employees').select('id').where('user_id', '=', users['collector.kkd']!.id).executeTakeFirstOrThrow();
  const kkdActive = await db
    .selectFrom('loans as l')
    .innerJoin('branches as b', 'b.id', 'l.branch_id')
    .select(['l.id', 'l.loan_no', 'l.overdue_amount', 'l.next_due_amount'])
    .where('b.code', '=', 'KKD')
    .where('l.status', '=', 'ACTIVE')
    .orderBy('l.loan_no')
    .execute();
  await collections.assign(admin, { loanIds: kkdActive.map((l) => l.id), employeeId: collectorEmp.id, reason: 'Kakinada town route' });
  const collector: RequestContext = { ...ctx('collector.kkd'), auth: { ...ctx('collector.kkd').auth, employeeId: collectorEmp.id } };
  const pay = (loanId: string, body: Record<string, unknown>, who = collector) =>
    db.transaction().execute((tx) => payments.record(tx, who, loanId, paymentCreateSchema.parse({ notify: true, ...body })));
  const amt = (v: string | null, f = 1) => (Math.max(1, Math.round(Number(v ?? '0') * f))).toFixed(2);
  const paid: string[] = [];
  for (const [i, l] of kkdActive.entries()) {
    if (Number(l.overdue_amount) <= 0 && i % 3) continue;
    const method = i % 4 === 1 ? { method: 'UPI', reference: `UPI${String(41760000 + i * 97)}` } : { method: 'CASH' };
    const amount = Number(l.overdue_amount) > 0 ? amt(l.overdue_amount, i % 2 ? 1 : 0.5) : amt(l.next_due_amount);
    if (i % 5 === 4) continue; // some customers not met today
    const r = await pay(l.id, { amount, ...method, location: 'Kakinada' });
    paid.push(r.id);
  }
  const unpaid = kkdActive.filter((l, i) => i % 5 === 4);
  if (unpaid[0]) await collections.recordVisit(collector, unpaid[0].id, { outcome: 'PROMISED', promisedAmount: amt(unpaid[0].overdue_amount || unpaid[0].next_due_amount), promisedDate: addDays(today, 2), notes: 'Will pay after Friday market' });
  if (unpaid[1]) await collections.recordVisit(collector, unpaid[1].id, { outcome: 'NOT_AVAILABLE', notes: 'House locked; neighbour says back tomorrow' });
  if (paid[1]) await payments.requestReversal(collector, paid[1], { reasonCode: 'WRONG_AMOUNT', reasonText: 'Entered 500 more than the customer paid' });
  await messaging.relayOnce(200);

  // Phase 5: expenses at each stage, a cash deposit and a cheque in hand.
  const expenses = app.get(ExpensesService);
  const banking = app.get(BankingService);
  const kkdId = (await db.selectFrom('branches').select('id').where('code', '=', 'KKD').executeTakeFirstOrThrow()).id;
  const cat = async (name: string) => (await db.selectFrom('expense_categories').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id;
  const accountant = ctx('accounts.kkd');
  const managerKkd = ctx('manager.kkd');
  const fuel = await expenses.create(collector, { branchId: kkdId, categoryId: await cat('Fuel'), amount: '380', expenseDate: today, paidFrom: 'EMPLOYEE_CASH', vendor: 'Indian Oil, Gandhi Nagar', description: 'Petrol for the Pithapuram route' });
  await expenses.approve(managerKkd, fuel.id);
  await expenses.post(accountant, fuel.id);
  const tea = await expenses.create(managerKkd, { branchId: kkdId, categoryId: await cat('Office expenses'), amount: '240', expenseDate: today, paidFrom: 'BRANCH_CASH', vendor: 'Sri Sai Tea Stall', description: 'Tea and snacks for branch meeting' });
  await expenses.approve(admin, tea.id);
  await expenses.create(collector, { branchId: kkdId, categoryId: await cat('Travel'), amount: '120', expenseDate: today, paidFrom: 'EMPLOYEE_CASH', description: 'Auto to Samalkot and back' });
  const collectorCash = await ledger.employeeCashAccount(db, collectorEmp.id);
  const held = (await db.selectFrom('journal_lines').select((eb) => eb.fn.sum<string>('debit').as('d')).select((eb) => eb.fn.sum<string>('credit').as('c')).where('account_id', '=', collectorCash.id).executeTakeFirstOrThrow());
  const cashHeld = Number(held.d ?? 0) - Number(held.c ?? 0);
  if (cashHeld > 1000) await banking.recordDeposit(managerKkd, { fromAccountId: collectorCash.id, toAccountId: bank.id, amount: (Math.floor(cashHeld / 2 / 100) * 100).toFixed(2), depositedOn: today, slipNo: 'SBI-KKD-0412' });
  const chequeLoan = kkdActive[2] ?? kkdActive[0]; // a customer already met today; leaves the unvisited ones for the collector
  if (chequeLoan) {
    const mgrEmp = await db.selectFrom('employees').select('id').where('user_id', '=', users['manager.kkd']!.id).executeTakeFirst();
    await pay(chequeLoan.id, { amount: '2000', method: 'CHEQUE', reference: '004517', chequeBank: 'Andhra Bank, Kakinada', chequeDate: today, confirmDuplicate: true }, { ...managerKkd, auth: { ...managerKkd.auth, employeeId: mgrEmp?.id ?? null } });
  }

  // Phase 6: the SBI statement since the capital came in, imported through the real parser and
  // matcher. Disbursements (by UTR), the posted UPI receipts and the cash deposit match on their
  // own; an unknown NEFT credit and two bank charges are left for the accountant to resolve.
  const dmy = (d: string) => d.split('-').reverse().join('/');
  const disb = await db.selectFrom('loans').select(['disbursed_on', 'net_disbursement', 'disbursement_reference', 'loan_no']).where('disbursement_account_id', '=', bank.id).where('disbursed_on', 'is not', null).orderBy('disbursed_on').orderBy('loan_no').execute();
  const upi = await db.selectFrom('payments').select(['amount', 'reference_no']).where('branch_id', '=', kkdId).where('method', '=', 'UPI').where('status', '=', 'POSTED').orderBy('created_at').execute();
  const dep = await db.selectFrom('cash_deposits').select(['amount', 'slip_no', 'deposited_on']).where('to_account_id', '=', bank.id).execute();
  type Row = { date: string; text: string; ref: string; debit: string; credit: string };
  const rows: Row[] = [
    ...disb.map((l) => ({ date: String(l.disbursed_on), text: `NEFT/DR/${l.disbursement_reference}/${l.loan_no}`, ref: l.disbursement_reference ?? '', debit: String(l.net_disbursement), credit: '' })),
    ...upi.map((u) => ({ date: today, text: `UPI/CR/${u.reference_no}/PhonePe`, ref: u.reference_no ?? '', debit: '', credit: String(u.amount) })),
    ...dep.map((d) => ({ date: String(d.deposited_on), text: `CASH DEPOSIT BY SELF ${d.slip_no ?? ''}`, ref: d.slip_no ?? '', debit: '', credit: String(d.amount) })),
    { date: today, text: 'NEFT/CR/N274261839/RAMANA TRADERS', ref: 'N274261839', debit: '', credit: '4500.00' },
    { date: today, text: 'SMS ALERT CHARGES QTR', ref: '', debit: '17.70', credit: '' },
  ].sort((x, y) => x.date.localeCompare(y.date));
  let paise = 2_500_000_00; // balance brought forward: the partners' capital
  const csv = ['Date,Description,Reference,Debit,Credit,Balance', ...rows.map((r) => {
    paise += Math.round(Number(r.credit || 0) * 100) - Math.round(Number(r.debit || 0) * 100);
    return [dmy(r.date), `"${r.text}"`, r.ref, r.debit, r.credit, (paise / 100).toFixed(2)].join(',');
  })].join('\n');
  const statements = app.get(StatementsService);
  await statements.import(accountant, bank.id, { buffer: Buffer.from(csv), originalname: `SBI-30112233445-${today}.csv` } as Express.Multer.File, { date: 0, description: 1, reference: 2, debit: 3, credit: 4, balance: 5, skipRows: 0, dateFormat: 'DD/MM/YYYY' }, false);
  const brs = await statements.bankReconciliation(bank.id, today);
  console.log(`bank reconciliation: unexplained ${brs.unexplained} — every remaining difference is a listed item`);

  // Phase 7: the nightly job above opened recovery cases for loans 30+ days past due. Take the
  // worst one in Kakinada through to repossession (approved by a second person), add history to
  // the others, and leave one write-off request waiting for approval.
  const recovery = app.get(RecoveryService);
  const kkdCases = await db
    .selectFrom('recovery_cases as rc')
    .innerJoin('loans as l', 'l.id', 'rc.loan_id')
    .select(['rc.id', 'l.id as loan_id', 'l.loan_no', 'l.dpd'])
    .where('rc.branch_id', '=', kkdId)
    .where('rc.status', '=', 'OPEN')
    .orderBy('l.dpd', 'desc')
    .execute();
  const notes = ['Customer says the harvest money comes next week', 'Phone switched off for three days; neighbour gave a new number', 'Wife paid ₹500 towards the overdue; promised the rest by month end'];
  for (const [i, rc] of kkdCases.entries()) {
    await recovery.addAction(collector, rc.id, { type: i % 2 ? 'CALL' : 'VISIT', summary: notes[i % notes.length]! });
  }
  const worst = kkdCases[0];
  if (worst) {
    for (const stage of ['FIELD_VISIT', 'ESCALATED']) await recovery.moveStage(managerKkd, worst.id, { stage, note: stage === 'ESCALATED' ? 'Avoiding the collector for six weeks' : 'Weekly visits' });
    await recovery.moveStage(managerKkd, worst.id, { stage: 'REPOSSESSION', note: 'Final notice period over (per legal advisor)' });
    await recovery.decideStage(admin, worst.id, true, 'Reviewed the notices and visit history');
    const asset = await db.selectFrom('assets').select('id').where('loan_id', '=', worst.loan_id).where('status', '=', 'ACTIVE').executeTakeFirst();
    if (asset) await recovery.repossess(managerKkd, worst.id, { assetId: asset.id, repossessedOn: today, location: 'Kakinada branch yard', conditionNotes: 'Running condition; both keys; RC book with the customer; minor dent on the left side', valuation: '42000' });
  }
  const second = kkdCases[1];
  if (second) await recovery.requestWriteOff(managerKkd, second.id, 'Customer has left the district; family says no contact. Vehicle not found after a 60-day search.');
  console.log(`recovery: ${kkdCases.length} open cases in Kakinada`);
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
