import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ALL_PERMISSIONS, paymentCreateSchema } from '@fin/contracts';
import { Money } from '@fin/money';
import { sql } from 'kysely';
import { AppModule } from '../app.module';
import type { RequestContext } from '../auth/context';
import { PaymentsService } from '../collections/payments.service';
import { istToday } from '../common/dates';
import { loadConfig } from '../config/config';
import { DB_TOKEN, Db } from '../db/db';
import { JobsService } from '../jobs/jobs.service';
import { LedgerService } from '../ledger/ledger.service';
import { LoansService } from '../lending/loans.service';

/**
 * Volume data for load testing (Phase 8), on top of the demo data — never in production.
 *   PERF_CUSTOMERS  customers bulk-inserted with SQL (non-financial rows; default 1,000,000 —
 *                   the search target in doc 01 §6 is "p95 < 300 ms at 1M customers")
 *   PERF_LOANS      loans created, approved and disbursed through the real services so the
 *                   ledger stays correct (default 5,000), and payments on a fifth of them
 */
async function main() {
  const config = loadConfig({ ...process.env, WORKERS: 'false' });
  if (config.production) throw new Error('Refusing to generate volume data in production');
  const customersN = Number(process.env.PERF_CUSTOMERS ?? 1_000_000);
  const loansN = Number(process.env.PERF_LOANS ?? 5_000);
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error'] });
  const db = app.get<Db>(DB_TOKEN);
  const t0 = Date.now();
  const log = (m: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}\n`);

  const branches = await db.selectFrom('branches').select(['id', 'code']).where('code', 'in', ['KKD', 'RJY']).execute();
  if (branches.length < 2) throw new Error('Load the demo data first (pnpm setup)');

  // 1. Customers in bulk: Telugu-style names, unique numbers, valid mobiles.
  const existing = Number((await sql<{ n: string }>`SELECT count(*)::text n FROM customers WHERE customer_no LIKE 'PERF-%'`.execute(db)).rows[0]!.n);
  if (existing < customersN) {
    log(`inserting ${customersN - existing} customers…`);
    const step = 100_000;
    for (let from = existing; from < customersN; from += step) {
      const to = Math.min(customersN, from + step);
      await sql`
        INSERT INTO customers (customer_no, branch_id, full_name, mobile, village_town, kyc_status, status)
        SELECT 'PERF-' || lpad(g::text, 8, '0'),
          (ARRAY[${branches[0]!.id}::uuid, ${branches[1]!.id}::uuid])[1 + g % 2],
          (ARRAY['Venkata','Lakshmi','Srinivas','Padma','Ramesh','Durga','Satya','Naga','Suresh','Anjali','Ravi','Sita','Krishna','Bhavani','Prasad'])[1 + g % 15] || ' ' ||
          (ARRAY['Rao','Reddy','Naidu','Kumari','Babu','Devi','Murthy','Varma','Chowdary','Sastry','Raju','Prasad','Kumar'])[1 + (g / 15) % 13] || ' ' || g,
          (6 + g % 4)::text || lpad((g::bigint * 7919 % 1000000000)::text, 9, '0'),
          (ARRAY['Kakinada','Rajahmundry','Pithapuram','Samalkot','Peddapuram','Tuni','Amalapuram','Mandapeta'])[1 + g % 8],
          'VERIFIED', 'ACTIVE'
        FROM generate_series(${from + 1}::int, ${to}::int) g`.execute(db);
      log(`  customers: ${to}`);
    }
    await sql`ANALYZE customers`.execute(db);
  }

  // 2. Loans through the services.
  const users = Object.fromEntries((await db.selectFrom('users').select(['id', 'username', 'full_name']).execute()).map((u) => [u.username, u]));
  const ctx = (username: string): RequestContext => ({
    auth: { userId: users[username]!.id, username, fullName: users[username]!.full_name, sessionId: null as unknown as string, roles: ['SUPER_ADMIN'], permissions: new Set(ALL_PERMISSIONS), scope: 'ALL', branchIds: [], employeeId: null, restriction: null, reauthAt: null },
    ip: '127.0.0.1',
    userAgent: 'perf-seed',
    requestId: randomUUID(),
  });
  const loans = app.get(LoansService);
  const ledger = app.get(LedgerService);
  const payments = app.get(PaymentsService);
  const tw = await db.selectFrom('loan_products').select('id').where('category', '=', 'TWO_WHEELER').where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
  const bank = await db.selectFrom('accounts').select('id').where('subtype', '=', 'BANK').orderBy('code').executeTakeFirstOrThrow();
  const done = Number((await sql<{ n: string }>`SELECT count(*)::text n FROM loans l JOIN customers c ON c.id = l.customer_id WHERE c.customer_no LIKE 'PERF-%'`.execute(db)).rows[0]!.n);
  const today = istToday();
  if (done < loansN) {
    const capital = Money.of(String((loansN - done) * 100_000));
    await db.transaction().execute((tx) => ledger.post(tx, { entryType: 'OPENING', valueDate: today, branchId: null, sourceType: 'perf', sourceId: `capital-${Date.now()}`, narration: 'Volume test capital', lines: [{ account: bank.id, debit: capital }, { account: '3100', credit: capital }], createdBy: users.admin!.id }));
    const pool = await db.selectFrom('customers').select(['id', 'branch_id']).where('customer_no', 'like', 'PERF-%').orderBy('customer_no').offset(done).limit(loansN - done).execute();
    const addMonths = (d: string, n: number) => {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCMonth(x.getUTCMonth() + n);
      return x.toISOString().slice(0, 10);
    };
    log(`creating ${pool.length} loans…`);
    for (const [i, c] of pool.entries()) {
      const k = done + i;
      const maker = ctx(c.branch_id === branches.find((b) => b.code === 'RJY')!.id ? 'manager.rjy' : 'manager.kkd');
      const start = addMonths(today, -(k % 11));
      const loan = await db.transaction().execute((tx) =>
        loans.create(tx, maker, {
          customerId: c.id, productId: tw.id, principal: String(30_000 + (k % 13) * 5_000), annualRate: '24', frequency: 'MONTHLY', numInstallments: 12 + (k % 3) * 6,
          disbursementDate: start, firstDueDate: addMonths(start, 1),
          asset: { make: 'Hero', model: 'Splendor Plus', manufactureYear: 2025, chassisNo: `MBPERF${String(k).padStart(9, '0')}`, engineNo: `EPERF${String(k).padStart(9, '0')}`, assetValue: String((30_000 + (k % 13) * 5_000) * 1.5) } as never,
        }),
      );
      await loans.submit(maker, loan.id);
      await loans.approve(ctx('admin'), loan.id, 'Volume test');
      await db.transaction().execute((tx) => loans.disburse(tx, maker, loan.id, { accountId: bank.id, mode: 'BANK_TRANSFER', reference: `PERFUTR${k}`, disbursedOn: start }));
      if ((i + 1) % 500 === 0) log(`  loans: ${done + i + 1}`);
    }
    log('end-of-day for today…');
    await db.deleteFrom('job_runs').where('business_date', '=', today).execute();
    await app.get(JobsService).runDaily(today, { userId: null });
    log('payments on a fifth of the loans…');
    const toPay = await db.selectFrom('loans as l').innerJoin('customers as c', 'c.id', 'l.customer_id').select(['l.id', 'l.next_due_amount']).where('c.customer_no', 'like', 'PERF-%').where('l.status', '=', 'ACTIVE').where(sql<boolean>`l.id::text < '0' OR random() < 0.2`).execute();
    for (const l of toPay) {
      const amount = Number(l.next_due_amount ?? 0) > 0 ? l.next_due_amount! : '1000.00';
      await db.transaction().execute((tx) => payments.record(tx, ctx('manager.kkd'), l.id, paymentCreateSchema.parse({ amount, method: 'CASH', atCounter: true, confirmDuplicate: true, notify: false })));
    }
    log(`  payments: ${toPay.length}`);
  }
  await sql`ANALYZE`.execute(db);
  const counts = await sql<{ customers: string; loans: string; payments: string; lines: string }>`SELECT (SELECT count(*) FROM customers)::text customers, (SELECT count(*) FROM loans)::text loans, (SELECT count(*) FROM payments)::text payments, (SELECT count(*) FROM journal_lines)::text lines`.execute(db);
  log(`done: ${JSON.stringify(counts.rows[0])}`);
  await app.close();
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
