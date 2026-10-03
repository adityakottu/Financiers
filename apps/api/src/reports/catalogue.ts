import { DPD_BUCKETS } from '@fin/contracts';
import { addDays } from '@fin/loan-engine';
import { Money } from '@fin/money';
import { RawBuilder, sql } from 'kysely';
import type { Column, Filters, ReportDef, ReportResult, Row, RunContext } from './types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rows = async <T extends Row>(c: RunContext, q: RawBuilder<T>) => (await q.execute(c.db)).rows;
/** `AND <col> = ANY(branches)` when the user is limited to some branches. */
const inBranch = (c: RunContext, col: string) => (c.branches ? sql`AND ${sql.ref(col)} = ANY(${c.branches}::uuid[])` : sql``);
const eq = (col: string, v: string | undefined) => (v ? sql`AND ${sql.ref(col)} = ${v}` : sql``);
const monthStart = (d: string) => `${d.slice(0, 8)}01`;
const period = (today: string) => ({ from: monthStart(today), to: today });
const money = (key: string, label: string, total = true, width?: number): Column => ({ key, label, type: 'money', total, width });
const text = (key: string, label: string, width?: number): Column => ({ key, label, type: 'text', width });
const int = (key: string, label: string, total = false): Column => ({ key, label, type: 'int', total, width: 9 });
const date = (key: string, label: string): Column => ({ key, label, type: 'date', width: 12 });
const pct = (key: string, label: string): Column => ({ key, label, type: 'pct', width: 10 });
const bucketOf = (dpd: number) => DPD_BUCKETS.find((b) => dpd >= b.min && (b.max === null || dpd <= b.max))!.label;
const bucketRange = (b?: string) => ({ DPD_1_30: [1, 30], DPD_31_60: [31, 60], DPD_61_90: [61, 90], DPD_90_PLUS: [91, 1_000_000] })[b ?? ''] as [number, number] | undefined;
const ratio = (num: Money, den: Money) => (den.isPositive() ? Number(num.toDecimal().div(den.toDecimal()).times(100).toFixed(2)) : null);
/** Collectors see their own loans / collections only. */
const ownLoans = (c: RunContext) => (c.ownEmployeeId ? sql`AND l.assigned_collector_id = ${c.ownEmployeeId}` : sql``);
const ownPayments = (c: RunContext) => (c.ownEmployeeId ? sql`AND p.collected_by = ${c.ownEmployeeId}` : sql``);

/* ------------------------------------------------------------------ */
/* Loans                                                               */
/* ------------------------------------------------------------------ */

const loanColumns: Column[] = [
  text('loan_no', 'Loan', 18), text('customer', 'Customer', 22), text('branch', 'Branch', 8), text('category', 'Category', 13), date('disbursed_on', 'Disbursed'),
  money('principal', 'Principal'), money('principal_outstanding', 'Principal o/s'), money('interest_outstanding', 'Interest due'), money('charges', 'Fees & penal'),
  money('overdue_amount', 'Overdue'), int('dpd', 'DPD'), date('next_due_date', 'Next due'), text('collector', 'Collector', 18),
];

async function loanList(c: RunContext, f: Filters, where: RawBuilder<unknown>, order: RawBuilder<unknown>) {
  return rows<Row>(c, sql`
    SELECT l.loan_no, c.full_name customer, b.code branch, l.category, l.disbursed_on::text, l.principal::text, l.principal_outstanding::text, l.interest_outstanding::text,
      (l.fees_outstanding + l.penalty_outstanding)::text charges, l.overdue_amount::text, l.dpd, l.next_due_date::text, e.full_name collector
    FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id LEFT JOIN employees e ON e.id = l.assigned_collector_id
    WHERE ${where} ${inBranch(c, 'l.branch_id')} ${eq('l.category', f.category)} ${eq('l.assigned_collector_id', f.employeeId)} ${ownLoans(c)}
    ORDER BY ${order}`);
}

const loans: ReportDef[] = [
  {
    name: 'loans-active',
    title: 'Active loans',
    group: 'Loans',
    description: 'Every active loan with what is outstanding, overdue and next due.',
    permission: 'report.loan',
    filters: ['branchId', 'category', 'employeeId'],
    async run(c, f) {
      return { columns: loanColumns, rows: await loanList(c, f, sql`l.status = 'ACTIVE'`, sql`b.code, l.loan_no`), notes: ['Interest due is interest that has fallen due and is unpaid (accrual basis ⚖); future interest is not a receivable.'] };
    },
  },
  {
    name: 'loans-overdue',
    title: 'Overdue loans',
    group: 'Loans',
    description: 'Active loans with anything past due, by days past due (DPD) bucket.',
    permission: 'report.loan',
    filters: ['branchId', 'category', 'employeeId', 'bucket'],
    async run(c, f) {
      const r = bucketRange(f.bucket) ?? [1, 1_000_000];
      const data = await loanList(c, f, sql`l.status = 'ACTIVE' AND l.dpd BETWEEN ${r[0]} AND ${r[1]}`, sql`l.dpd DESC, l.loan_no`);
      return { columns: [...loanColumns.slice(0, 11), text('bucket', 'Bucket', 8), ...loanColumns.slice(11)], rows: data.map((x) => ({ ...x, bucket: bucketOf(Number(x.dpd)) })) };
    },
  },
  {
    name: 'loans-closed',
    title: 'Closed loans',
    group: 'Loans',
    description: 'Loans fully repaid and closed in the period.',
    permission: 'report.loan',
    filters: ['from', 'to', 'branchId', 'category'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [text('loan_no', 'Loan', 18), text('customer', 'Customer', 24), text('branch', 'Branch', 8), text('category', 'Category', 13), date('disbursed_on', 'Disbursed'), date('closed_on', 'Closed'), int('tenure', 'Instalments'), money('principal', 'Principal'), money('total_collected', 'Total collected')],
        rows: await rows(c, sql`
          SELECT l.loan_no, c.full_name customer, b.code branch, l.category, l.disbursed_on::text, (l.closed_at AT TIME ZONE 'Asia/Kolkata')::date::text closed_on,
            l.num_installments tenure, l.principal::text, l.total_collected::text
          FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id
          WHERE l.status = 'CLOSED' AND (l.closed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date
            ${inBranch(c, 'l.branch_id')} ${eq('l.category', f.category)}
          ORDER BY l.closed_at`),
      };
    },
  },
  {
    name: 'loans-written-off',
    title: 'Written-off loans',
    group: 'Loans',
    description: 'Approved write-offs (E13) and anything recovered afterwards.',
    permission: 'report.loan',
    filters: ['from', 'to', 'branchId'],
    defaults: (t) => ({ from: `${t.slice(0, 4)}-01-01`, to: t }),
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [text('loan_no', 'Loan', 18), text('customer', 'Customer', 22), text('branch', 'Branch', 8), date('written_off_on', 'Written off'), money('principal', 'Principal'), money('interest', 'Interest'), money('charges', 'Fees & penal'), money('advance_used', 'Advance used'), money('amount', 'Charged to bad debts'), money('recovered', 'Recovered since'), text('approved_by', 'Approved by', 16)],
        rows: await rows(c, sql`
          SELECT l.loan_no, c.full_name customer, b.code branch, w.written_off_on::text, w.principal::text, w.interest::text, (w.fees + w.penalty)::text charges, w.advance_used::text, w.amount::text,
            (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.loan_id = l.id AND p.is_post_write_off AND p.status = 'POSTED')::text recovered, u.full_name approved_by
          FROM loan_write_offs w JOIN loans l ON l.id = w.loan_id JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id JOIN users u ON u.id = w.decided_by
          WHERE w.status = 'APPROVED' AND w.written_off_on BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'l.branch_id')}
          ORDER BY w.written_off_on`),
      };
    },
  },
  {
    name: 'dues',
    title: 'Dues',
    group: 'Loans',
    description: 'Installments falling due today, tomorrow or in the next 7 days, still unpaid.',
    permission: 'report.loan',
    filters: ['range', 'branchId', 'employeeId'],
    defaults: () => ({ range: 'today' }),
    async run(c, f) {
      const [a, b] = f.range === 'tomorrow' ? [addDays(c.today, 1), addDays(c.today, 1)] : f.range === 'week' ? [c.today, addDays(c.today, 6)] : [c.today, c.today];
      return {
        columns: [date('due_date', 'Due'), text('loan_no', 'Loan', 18), text('customer', 'Customer', 22), text('branch', 'Branch', 8), int('installment_no', 'Inst.'), money('total_due', 'Due'), money('total_paid', 'Paid'), money('balance', 'Balance'), int('dpd', 'Loan DPD'), text('collector', 'Collector', 18)],
        rows: await rows(c, sql`
          SELECT i.due_date::text, l.loan_no, c.full_name customer, b.code branch, i.installment_no, i.total_due::text, i.total_paid::text, (i.total_due - i.total_paid)::text balance, l.dpd, e.full_name collector
          FROM loan_installments i JOIN loans l ON l.id = i.loan_id JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id LEFT JOIN employees e ON e.id = l.assigned_collector_id
          WHERE l.status = 'ACTIVE' AND i.status NOT IN ('WAIVED', 'RESCHEDULED') AND i.total_paid < i.total_due AND i.due_date BETWEEN ${a}::date AND ${b}::date
            ${inBranch(c, 'l.branch_id')} ${eq('l.assigned_collector_id', f.employeeId)} ${ownLoans(c)}
          ORDER BY i.due_date, b.code, l.loan_no`),
      };
    },
  },
  {
    name: 'outstanding-by-loan',
    title: 'Outstanding by loan',
    group: 'Loans',
    description: 'Receivables per active loan, today. The totals equal the loan receivable accounts in the ledger (1310–1340).',
    permission: 'report.loan',
    filters: ['branchId', 'category'],
    async run(c, f) {
      return {
        columns: [text('loan_no', 'Loan', 18), text('customer', 'Customer', 22), text('branch', 'Branch', 8), text('category', 'Category', 13), money('principal_outstanding', 'Principal (1310)'), money('interest_outstanding', 'Interest (1320)'), money('fees_outstanding', 'Fees (1330)'), money('penalty_outstanding', 'Penal (1340)'), money('total', 'Total receivable'), money('advance_balance', 'Advance held (2200)'), int('dpd', 'DPD')],
        rows: await rows(c, sql`
          SELECT l.loan_no, c.full_name customer, b.code branch, l.category, l.principal_outstanding::text, l.interest_outstanding::text, l.fees_outstanding::text, l.penalty_outstanding::text,
            (l.principal_outstanding + l.interest_outstanding + l.fees_outstanding + l.penalty_outstanding)::text total, l.advance_balance::text, l.dpd
          FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id
          WHERE l.status = 'ACTIVE' ${inBranch(c, 'l.branch_id')} ${eq('l.category', f.category)}
          ORDER BY b.code, l.loan_no`),
      };
    },
  },
  {
    name: 'outstanding-by-customer',
    title: 'Outstanding by customer',
    group: 'Loans',
    description: 'Receivables per customer across their active loans.',
    permission: 'report.loan',
    filters: ['branchId'],
    async run(c) {
      return {
        columns: [text('customer_no', 'Customer no', 14), text('customer', 'Customer', 24), text('branch', 'Branch', 8), int('loans', 'Loans', true), money('principal_outstanding', 'Principal o/s'), money('interest_outstanding', 'Interest due'), money('charges', 'Fees & penal'), money('total', 'Total receivable'), money('overdue', 'Overdue'), int('max_dpd', 'Max DPD')],
        rows: await rows(c, sql`
          SELECT c.customer_no, c.full_name customer, b.code branch, count(*)::int loans, sum(l.principal_outstanding)::text principal_outstanding, sum(l.interest_outstanding)::text interest_outstanding,
            sum(l.fees_outstanding + l.penalty_outstanding)::text charges, sum(l.principal_outstanding + l.interest_outstanding + l.fees_outstanding + l.penalty_outstanding)::text total,
            sum(l.overdue_amount)::text overdue, max(l.dpd) max_dpd
          FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = c.branch_id
          WHERE l.status = 'ACTIVE' ${inBranch(c, 'l.branch_id')}
          GROUP BY c.id, c.customer_no, c.full_name, b.code ORDER BY sum(l.principal_outstanding) DESC`),
      };
    },
  },
  {
    name: 'loans-by-category',
    title: 'Portfolio by asset category',
    group: 'Loans',
    description: 'Active loans, outstanding and portfolio at risk (PAR 30) per asset category.',
    permission: 'report.loan',
    filters: ['branchId'],
    async run(c) {
      const data = await rows<Row>(c, sql`
        SELECT l.category, count(*)::int loans, sum(l.principal)::text disbursed, sum(l.principal_outstanding)::text principal_outstanding, sum(l.overdue_amount)::text overdue,
          count(*) FILTER (WHERE l.dpd > 0)::int overdue_loans, coalesce(sum(l.principal_outstanding) FILTER (WHERE l.dpd > 30), 0)::text par30
        FROM loans l WHERE l.status = 'ACTIVE' ${inBranch(c, 'l.branch_id')} GROUP BY l.category ORDER BY l.category`);
      const out = data.map((x) => ({ ...x, par30_pct: ratio(Money.of(String(x.par30)), Money.of(String(x.principal_outstanding))) }));
      const sum = (k: string) => Money.sum(data.map((x) => Money.of(String(x[k]))));
      return {
        columns: [text('category', 'Category', 16), int('loans', 'Loans', true), int('overdue_loans', 'Overdue loans', true), money('disbursed', 'Principal lent'), money('principal_outstanding', 'Principal o/s'), money('overdue', 'Overdue'), money('par30', 'PAR 30 (principal)'), pct('par30_pct', 'PAR 30 %')],
        rows: out,
        totals: { category: 'Total', loans: data.reduce((s, x) => s + Number(x.loans), 0), overdue_loans: data.reduce((s, x) => s + Number(x.overdue_loans), 0), disbursed: sum('disbursed').toString(), principal_outstanding: sum('principal_outstanding').toString(), overdue: sum('overdue').toString(), par30: sum('par30').toString(), par30_pct: ratio(sum('par30'), sum('principal_outstanding')) },
        notes: ['PAR 30: principal outstanding of loans more than 30 days past due, as a share of all principal outstanding.'],
      };
    },
  },
  {
    name: 'asset-register',
    title: 'Financed asset register',
    group: 'Loans',
    description: 'Every financed asset with its loan and status (including repossessed and sold).',
    permission: 'report.loan',
    filters: ['branchId', 'category', 'status'],
    async run(c, f) {
      return {
        columns: [text('asset_no', 'Asset', 16), text('category', 'Category', 13), text('description', 'Make / model', 22), text('registration_no', 'Registration', 13), text('chassis_no', 'Chassis', 18), text('status', 'Status', 12), text('loan_no', 'Loan', 18), text('customer', 'Customer', 20), money('asset_value', 'Asset value'), money('principal_outstanding', 'Principal o/s')],
        rows: await rows(c, sql`
          SELECT a.asset_no, a.category, concat_ws(' ', a.make, a.model, a.variant) description, a.registration_no, a.chassis_no, a.status, l.loan_no, c.full_name customer, a.asset_value::text,
            CASE WHEN l.status = 'ACTIVE' THEN l.principal_outstanding ELSE 0 END::text principal_outstanding
          FROM assets a JOIN loans l ON l.id = a.loan_id JOIN customers c ON c.id = a.customer_id
          WHERE a.status <> 'CANCELLED' ${inBranch(c, 'a.branch_id')} ${eq('a.category', f.category)} ${eq('a.status', f.status)}
          ORDER BY a.asset_no`),
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

const payWhere = (c: RunContext, f: Filters) =>
  sql`p.status <> 'REVERSED' AND p.business_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'p.branch_id')} ${eq('p.method', f.method)} ${eq('p.collected_by', f.employeeId)} ${ownPayments(c)}`;
const methodCols = sql`count(*)::int payments,
  coalesce(sum(p.amount) FILTER (WHERE p.method = 'CASH'), 0)::text cash, coalesce(sum(p.amount) FILTER (WHERE p.method = 'UPI'), 0)::text upi,
  coalesce(sum(p.amount) FILTER (WHERE p.method = 'BANK_TRANSFER'), 0)::text bank, coalesce(sum(p.amount) FILTER (WHERE p.method = 'CHEQUE'), 0)::text cheque, sum(p.amount)::text total`;
const methodColumns: Column[] = [int('payments', 'Payments', true), money('cash', 'Cash'), money('upi', 'UPI'), money('bank', 'Bank transfer'), money('cheque', 'Cheque'), money('total', 'Total')];
const collectionFilters: ReportDef['filters'] = ['from', 'to', 'branchId', 'employeeId', 'method'];
const POST_WRITE_OFF_NOTE = 'Includes money recovered after a write-off (booked as income, not as a repayment).';

const collections: ReportDef[] = [
  {
    name: 'collection-daily',
    title: 'Collections by day',
    group: 'Collections',
    description: 'Money collected each business day, by method. Reversed payments are excluded.',
    permission: 'report.collection',
    filters: collectionFilters,
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return { columns: [date('business_date', 'Date'), ...methodColumns], rows: await rows(c, sql`SELECT p.business_date::text, ${methodCols} FROM payments p WHERE ${payWhere(c, f)} GROUP BY p.business_date ORDER BY p.business_date`), notes: [POST_WRITE_OFF_NOTE] };
    },
  },
  {
    name: 'collection-employee',
    title: 'Collections by employee',
    group: 'Collections',
    description: 'Payments, visits and promises to pay per collector.',
    permission: 'report.collection',
    filters: collectionFilters,
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const own = c.ownEmployeeId ? sql`AND e.id = ${c.ownEmployeeId}` : sql``;
      return {
        columns: [text('employee', 'Employee', 22), text('branch', 'Branch', 8), ...methodColumns, int('visits', 'Visits', true), int('promises', 'Promises', true)],
        rows: await rows(c, sql`
          WITH p AS (SELECT p.collected_by, ${methodCols} FROM payments p WHERE ${payWhere(c, f)} GROUP BY p.collected_by),
               v AS (SELECT employee_id, count(*)::int visits FROM collection_visits WHERE (visited_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY employee_id),
               t AS (SELECT employee_id, count(*)::int promises FROM promises_to_pay WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date GROUP BY employee_id)
          SELECT coalesce(e.full_name, 'Branch counter') employee, b.code branch, coalesce(p.payments, 0) payments, coalesce(p.cash, '0') cash, coalesce(p.upi, '0') upi, coalesce(p.bank, '0') bank,
            coalesce(p.cheque, '0') cheque, coalesce(p.total, '0') total, coalesce(v.visits, 0) visits, coalesce(t.promises, 0) promises
          FROM p FULL JOIN v ON v.employee_id = p.collected_by LEFT JOIN t ON t.employee_id = coalesce(p.collected_by, v.employee_id)
            LEFT JOIN employees e ON e.id = coalesce(p.collected_by, v.employee_id) LEFT JOIN branches b ON b.id = e.branch_id
          WHERE (e.id IS NULL OR true) ${c.branches ? sql`AND (e.branch_id IS NULL OR e.branch_id = ANY(${c.branches}::uuid[]))` : sql``} ${eq('e.id', f.employeeId)} ${own}
          ORDER BY coalesce(p.total, '0')::numeric DESC`),
      };
    },
  },
  {
    name: 'collection-branch',
    title: 'Collections by branch',
    group: 'Collections',
    description: 'Money collected per branch, by method.',
    permission: 'report.collection',
    filters: ['from', 'to', 'branchId', 'method'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return { columns: [text('branch', 'Branch', 24), ...methodColumns], rows: await rows(c, sql`SELECT b.code || ' — ' || b.name branch, ${methodCols} FROM payments p JOIN branches b ON b.id = p.branch_id WHERE ${payWhere(c, f)} GROUP BY b.code, b.name ORDER BY b.code`) };
    },
  },
  {
    name: 'collection-method',
    title: 'Collections by method',
    group: 'Collections',
    description: 'Cash, UPI, bank transfer and cheque, with each one’s share.',
    permission: 'report.collection',
    filters: ['from', 'to', 'branchId', 'employeeId'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const data = await rows<Row>(c, sql`SELECT p.method, count(*)::int payments, sum(p.amount)::text total FROM payments p WHERE ${payWhere(c, f)} GROUP BY p.method ORDER BY sum(p.amount) DESC`);
      const all = Money.sum(data.map((x) => Money.of(String(x.total))));
      const label: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };
      return {
        columns: [text('method', 'Method', 16), int('payments', 'Payments', true), money('total', 'Amount'), pct('share', 'Share')],
        rows: data.map((x) => ({ ...x, method: label[String(x.method)] ?? x.method, share: ratio(Money.of(String(x.total)), all) })),
      };
    },
  },
  {
    name: 'payments-register',
    title: 'Payments register',
    group: 'Collections',
    description: 'Every payment in the period with its receipt, including reversed ones (not totalled).',
    permission: 'report.collection',
    filters: ['from', 'to', 'branchId', 'employeeId', 'method', 'status'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const data = await rows<Row>(c, sql`
        SELECT p.business_date::text, p.payment_no, r.receipt_no, l.loan_no, cu.full_name customer, p.method, p.reference_no, coalesce(e.full_name, 'Branch counter') collector, p.amount::text,
          CASE WHEN p.status = 'POSTED' THEN p.amount ELSE 0 END::text counted, p.status, p.reconciliation_status
        FROM payments p JOIN loans l ON l.id = p.loan_id JOIN customers cu ON cu.id = p.customer_id LEFT JOIN receipts r ON r.payment_id = p.id LEFT JOIN employees e ON e.id = p.collected_by
        WHERE p.business_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'p.branch_id')} ${eq('p.method', f.method)} ${eq('p.collected_by', f.employeeId)} ${eq('p.status', f.status)} ${ownPayments(c)}
        ORDER BY p.received_at`);
      return {
        columns: [date('business_date', 'Date'), text('payment_no', 'Payment', 18), text('receipt_no', 'Receipt', 18), text('loan_no', 'Loan', 18), text('customer', 'Customer', 20), text('method', 'Method', 10), text('reference_no', 'Reference', 14), text('collector', 'Collected by', 16), money('amount', 'Amount', false), money('counted', 'Counted'), text('status', 'Status', 12), text('reconciliation_status', 'Bank', 11)],
        rows: data,
        notes: ['"Counted" excludes reversed payments and reversals still waiting for approval.'],
      };
    },
  },
  {
    name: 'collection-pending',
    title: 'Pending collections',
    group: 'Collections',
    description: 'Active loans with overdue dues today: who owes, how long, last contact.',
    permission: 'report.collection',
    filters: ['branchId', 'employeeId', 'bucket'],
    async run(c, f) {
      const r = bucketRange(f.bucket) ?? [1, 1_000_000];
      return {
        columns: [text('loan_no', 'Loan', 18), text('customer', 'Customer', 22), text('branch', 'Branch', 8), text('collector', 'Collector', 18), money('overdue_amount', 'Overdue'), int('dpd', 'DPD'), date('last_payment', 'Last paid'), text('last_visit', 'Last visit', 22), text('promise', 'Open promise', 20)],
        rows: await rows(c, sql`
          SELECT l.loan_no, c.full_name customer, b.code branch, e.full_name collector, l.overdue_amount::text, l.dpd, (l.last_payment_at AT TIME ZONE 'Asia/Kolkata')::date::text last_payment,
            (SELECT v.outcome || ' · ' || to_char(v.visited_at AT TIME ZONE 'Asia/Kolkata', 'DD/MM/YYYY') FROM collection_visits v WHERE v.loan_id = l.id ORDER BY v.visited_at DESC LIMIT 1) last_visit,
            (SELECT to_char(t.promised_date, 'DD/MM/YYYY') || ' · ' || t.promised_amount::text FROM promises_to_pay t WHERE t.loan_id = l.id AND t.status = 'OPEN' ORDER BY t.promised_date LIMIT 1) promise
          FROM loans l JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = l.branch_id LEFT JOIN employees e ON e.id = l.assigned_collector_id
          WHERE l.status = 'ACTIVE' AND l.overdue_amount > 0 AND l.dpd BETWEEN ${r[0]} AND ${r[1]} ${inBranch(c, 'l.branch_id')} ${eq('l.assigned_collector_id', f.employeeId)} ${ownLoans(c)}
          ORDER BY l.dpd DESC`),
      };
    },
  },
  {
    name: 'collection-efficiency',
    title: 'Collection efficiency',
    group: 'Collections',
    description: 'Of the installments that fell due in the period, how much was collected by the end of it — per collector.',
    permission: 'report.collection',
    filters: ['from', 'to', 'branchId', 'employeeId'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const data = await rows<Row>(c, sql`
        WITH due AS (
          SELECT i.id, i.total_due, l.assigned_collector_id emp, l.branch_id FROM loan_installments i JOIN loans l ON l.id = i.loan_id
          WHERE i.due_date BETWEEN ${f.from}::date AND ${f.to}::date AND i.status NOT IN ('WAIVED', 'RESCHEDULED') AND l.status IN ('ACTIVE', 'CLOSED')
            ${inBranch(c, 'l.branch_id')} ${eq('l.assigned_collector_id', f.employeeId)} ${ownLoans(c)}),
        got AS (
          SELECT a.installment_id, sum(a.amount) amt FROM payment_allocations a
            LEFT JOIN payments p ON p.id = a.payment_id LEFT JOIN advance_applications x ON x.id = a.advance_application_id
          WHERE a.installment_id IN (SELECT id FROM due) AND a.component <> 'ADVANCE'
            AND ((p.id IS NOT NULL AND p.status <> 'REVERSED' AND p.value_date <= ${f.to}::date) OR (x.id IS NOT NULL AND x.status = 'APPLIED' AND x.applied_on <= ${f.to}::date))
          GROUP BY a.installment_id)
        SELECT coalesce(e.full_name, 'Not assigned') employee, b.code branch, count(*)::int installments, sum(d.total_due)::text demand, coalesce(sum(g.amt), 0)::text collected
        FROM due d LEFT JOIN got g ON g.installment_id = d.id LEFT JOIN employees e ON e.id = d.emp JOIN branches b ON b.id = d.branch_id
        GROUP BY e.full_name, b.code ORDER BY b.code, e.full_name`);
      const out = data.map((x) => ({ ...x, efficiency: ratio(Money.of(String(x.collected)), Money.of(String(x.demand))) }));
      const d = Money.sum(data.map((x) => Money.of(String(x.demand))));
      const g = Money.sum(data.map((x) => Money.of(String(x.collected))));
      return {
        columns: [text('employee', 'Collector', 22), text('branch', 'Branch', 8), int('installments', 'Installments', true), money('demand', 'Fell due'), money('collected', 'Collected by period end'), pct('efficiency', 'Efficiency')],
        rows: out,
        totals: { employee: 'Total', branch: '', installments: data.reduce((s, x) => s + Number(x.installments), 0), demand: d.toString(), collected: g.toString(), efficiency: ratio(g, d) },
        notes: ['Collector = who the loan is assigned to now. Only money allocated to those installments counts (advances held are counted once applied).'],
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Accounting (derived from the ledger)                                */
/* ------------------------------------------------------------------ */

const accounting: ReportDef[] = [
  {
    name: 'trial-balance',
    title: 'Trial balance',
    group: 'Accounting',
    description: 'Debit and credit balance of every account as of a date. Must balance.',
    permission: 'report.accounting',
    filters: ['asOf', 'branchId'],
    defaults: (t) => ({ asOf: t }),
    required: ['asOf'],
    async run(c, f) {
      const r = await c.books.trialBalance(c.auth, f.asOf!, f.branchId);
      return {
        columns: [text('code', 'Code', 10), text('name', 'Account', 36), text('type', 'Type', 10), money('debit', 'Debit'), money('credit', 'Credit')],
        rows: r.data,
        totals: { code: '', name: r.totals.balanced ? 'Total — balanced' : 'Total — NOT BALANCED', type: '', debit: r.totals.debit, credit: r.totals.credit },
      };
    },
  },
  {
    name: 'profit-loss',
    title: 'Profit & loss',
    group: 'Accounting',
    description: 'Income and expenses for the period (accrual basis ⚖).',
    permission: 'report.accounting',
    filters: ['from', 'to', 'branchId'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const r = await c.books.profitAndLoss(c.auth, f.from!, f.to!, f.branchId);
      return {
        columns: [text('code', 'Code', 10), text('name', 'Account', 40), money('amount', 'Amount', false)],
        rows: [{ _section: 'Income' }, ...r.income, { code: '', name: 'Total income', amount: r.totals.income, _bold: true }, { _section: 'Expenses' }, ...r.expenses, { code: '', name: 'Total expenses', amount: r.totals.expenses, _bold: true }],
        totals: { code: '', name: Money.of(r.totals.net).isNegative() ? 'Net loss' : 'Net profit', amount: r.totals.net },
      };
    },
  },
  {
    name: 'balance-sheet',
    title: 'Balance sheet',
    group: 'Accounting',
    description: 'Assets = liabilities + equity + profit not yet closed to reserves ⚖.',
    permission: 'report.accounting',
    filters: ['asOf', 'branchId'],
    defaults: (t) => ({ asOf: t }),
    required: ['asOf'],
    async run(c, f) {
      const r = await c.books.balanceSheet(c.auth, f.asOf!, f.branchId);
      return {
        columns: [text('code', 'Code', 10), text('name', 'Account', 40), money('amount', 'Amount', false)],
        rows: [
          { _section: 'Assets' }, ...r.assets, { code: '', name: 'Total assets', amount: r.totals.assets, _bold: true },
          { _section: 'Liabilities' }, ...r.liabilities, { code: '', name: 'Total liabilities', amount: r.totals.liabilities, _bold: true },
          { _section: 'Equity' }, ...r.equity, { code: '', name: 'Profit not yet closed to reserves', amount: r.profit },
        ],
        totals: { code: '', name: r.totals.balanced ? 'Liabilities + equity + profit — balanced' : 'Liabilities + equity + profit — NOT BALANCED', amount: r.totals.liabilitiesAndEquity },
      };
    },
  },
  {
    name: 'cash-bank-book',
    title: 'Cash & bank book',
    group: 'Accounting',
    description: 'Opening + receipts − payments = closing, per cash, collector, UPI, cheque and bank account.',
    permission: 'report.accounting',
    filters: ['from', 'to', 'branchId'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      const r = await c.books.accountSummaries(c.auth, f.from!, f.to!, f.branchId);
      return { columns: [text('code', 'Code', 12), text('name', 'Account', 36), money('opening', 'Opening'), money('receipts', 'Receipts'), money('payments', 'Payments'), money('closing', 'Closing')], rows: r.data };
    },
  },
  {
    name: 'day-book',
    title: 'Day book',
    group: 'Accounting',
    description: 'Every journal entry for one value date, line by line.',
    permission: 'report.accounting',
    filters: ['asOf', 'branchId'],
    defaults: (t) => ({ asOf: t }),
    required: ['asOf'],
    async run(c, f) {
      const r = await c.books.dayBook(c.auth, f.asOf!, f.branchId);
      return {
        columns: [text('entry', 'Entry', 16), text('type', 'Type', 12), text('narration', 'Narration', 44), text('account', 'Account', 30), money('debit', 'Debit'), money('credit', 'Credit')],
        rows: r.entries.flatMap((e) => e.lines.map((l, i) => ({ entry: i ? '' : e.entry_no, type: i ? '' : e.entry_type, narration: i ? '' : e.narration, account: `${l.code} ${l.name}`, debit: Number(l.debit) ? l.debit : null, credit: Number(l.credit) ? l.credit : null }))),
      };
    },
  },
  {
    name: 'general-ledger',
    title: 'General ledger',
    group: 'Accounting',
    description: 'One account’s entries with a running balance.',
    permission: 'report.accounting',
    filters: ['accountId', 'from', 'to', 'branchId'],
    defaults: period,
    required: ['accountId', 'from', 'to'],
    async run(c, f) {
      const acct = await c.db.selectFrom('accounts').select(['code', 'name', 'normal_balance']).where('id', '=', f.accountId!).executeTakeFirst();
      if (!acct) return { columns: [text('note', 'Note')], rows: [{ note: 'Account not found' }] };
      const sign = acct.normal_balance === 'CREDIT' ? -1 : 1;
      const open = await rows<Row>(c, sql`SELECT coalesce(sum(l.debit - l.credit), 0)::text b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ${f.accountId} AND e.value_date < ${f.from}::date ${inBranch(c, 'l.branch_id')}`);
      const lines = await rows<Row>(c, sql`
        SELECT e.value_date::text, e.entry_no, e.entry_type, e.narration, ln.loan_no, l.debit::text, l.credit::text
        FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN loans ln ON ln.id = l.loan_id
        WHERE l.account_id = ${f.accountId} AND e.value_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'l.branch_id')}
        ORDER BY e.value_date, e.posted_at, l.line_no`);
      let bal = Money.of(String(open[0]!.b));
      const out: Row[] = [{ value_date: f.from!, entry_no: '', entry_type: '', narration: 'Opening balance', loan_no: '', debit: null, credit: null, balance: Money.of(sign === 1 ? bal.toString() : Money.zero().minus(bal).toString()).toString() }];
      let dr = Money.zero();
      let cr = Money.zero();
      for (const l of lines) {
        dr = dr.plus(Money.of(String(l.debit)));
        cr = cr.plus(Money.of(String(l.credit)));
        bal = bal.plus(Money.of(String(l.debit))).minus(Money.of(String(l.credit)));
        out.push({ ...l, debit: Number(l.debit) ? l.debit : null, credit: Number(l.credit) ? l.credit : null, balance: (sign === 1 ? bal : Money.zero().minus(bal)).toString() });
      }
      return {
        columns: [date('value_date', 'Date'), text('entry_no', 'Entry', 16), text('entry_type', 'Type', 12), text('narration', 'Narration', 44), text('loan_no', 'Loan', 16), money('debit', 'Debit'), money('credit', 'Credit'), money('balance', 'Balance', false)],
        rows: out,
        totals: { value_date: '', entry_no: '', entry_type: '', narration: 'Movement / closing', loan_no: '', debit: dr.toString(), credit: cr.toString(), balance: (sign === 1 ? bal : Money.zero().minus(bal)).toString() },
        notes: [`${acct.code} ${acct.name} — balance shown on its normal (${acct.normal_balance.toLowerCase()}) side`],
      };
    },
  },
  {
    name: 'receivables-ageing',
    title: 'Receivables ageing',
    group: 'Accounting',
    description: 'Loan receivables by days-past-due bucket. Totals equal the ledger (1310–1340).',
    permission: 'report.accounting',
    filters: ['branchId', 'category'],
    async run(c, f) {
      const data = await rows<Row>(c, sql`
        SELECT CASE WHEN l.dpd = 0 THEN 0 WHEN l.dpd <= 30 THEN 1 WHEN l.dpd <= 60 THEN 2 WHEN l.dpd <= 90 THEN 3 ELSE 4 END ord, count(*)::int loans,
          sum(l.principal_outstanding)::text principal, sum(l.interest_outstanding)::text interest, sum(l.fees_outstanding + l.penalty_outstanding)::text charges,
          sum(l.principal_outstanding + l.interest_outstanding + l.fees_outstanding + l.penalty_outstanding)::text total
        FROM loans l WHERE l.status = 'ACTIVE' ${inBranch(c, 'l.branch_id')} ${eq('l.category', f.category)} GROUP BY 1 ORDER BY 1`);
      const all = Money.sum(data.map((x) => Money.of(String(x.total))));
      return {
        columns: [text('bucket', 'Days past due', 14), int('loans', 'Loans', true), money('principal', 'Principal'), money('interest', 'Interest due'), money('charges', 'Fees & penal'), money('total', 'Total'), pct('share', 'Share')],
        rows: DPD_BUCKETS.map((b, i) => {
          const x = data.find((d) => Number(d.ord) === i);
          return { bucket: b.label, loans: x?.loans ?? 0, principal: x?.principal ?? '0.00', interest: x?.interest ?? '0.00', charges: x?.charges ?? '0.00', total: x?.total ?? '0.00', share: ratio(Money.of(String(x?.total ?? '0')), all) };
        }),
      };
    },
  },
  {
    name: 'expense-register',
    title: 'Expense register',
    group: 'Accounting',
    description: 'Expenses in the period with who claimed, approved and posted them.',
    permission: 'report.accounting',
    filters: ['from', 'to', 'branchId', 'status'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [date('expense_date', 'Date'), text('expense_no', 'Expense', 16), text('branch', 'Branch', 8), text('category', 'Category', 16), text('vendor', 'Vendor', 18), text('description', 'For', 28), text('paid_from', 'Paid from', 12), money('amount', 'Amount'), text('status', 'Status', 10), text('submitted_by', 'Claimed by', 16)],
        rows: await rows(c, sql`
          SELECT x.expense_date::text, x.expense_no, b.code branch, k.name category, x.vendor, x.description, x.paid_from, x.amount::text, x.status, u.full_name submitted_by
          FROM expenses x JOIN branches b ON b.id = x.branch_id JOIN expense_categories k ON k.id = x.category_id JOIN users u ON u.id = x.submitted_by
          WHERE x.expense_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'x.branch_id')} ${eq('x.status', f.status)}
          ORDER BY x.expense_date, x.expense_no`),
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

const recon: ReportDef[] = [
  {
    name: 'recon-employee',
    title: 'Employee cash settlement',
    group: 'Reconciliation',
    description: 'Expected, declared and counted cash per employee per day, with differences.',
    permission: 'report.reconciliation',
    filters: ['from', 'to', 'branchId', 'employeeId', 'status'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [date('business_date', 'Date'), text('branch', 'Branch', 8), text('employee', 'Employee', 20), money('expected_cash', 'Expected'), money('declared_cash', 'Declared'), money('counted_cash', 'Counted'), money('difference', 'Short (+) / excess (−)'), text('status', 'Status', 12), text('counted_by', 'Counted by', 16)],
        rows: await rows(c, sql`
          SELECT s.business_date::text, b.code branch, e.full_name employee, s.expected_cash::text, s.declared_cash::text, s.counted_cash::text, s.difference::text, s.status, u.full_name counted_by
          FROM employee_settlements s JOIN employees e ON e.id = s.employee_id JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.counted_by
          WHERE s.business_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 's.branch_id')} ${eq('s.employee_id', f.employeeId)} ${eq('s.status', f.status)}
          ORDER BY s.business_date, b.code, e.full_name`),
      };
    },
  },
  {
    name: 'recon-branch',
    title: 'Branch day close',
    group: 'Reconciliation',
    description: 'Each branch day: closed or open, by whom, what was collected and still in transit.',
    permission: 'report.reconciliation',
    filters: ['from', 'to', 'branchId'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [date('business_date', 'Date'), text('branch', 'Branch', 20), text('status', 'Status', 10), text('closed_by', 'Closed by', 18), text('closed_at', 'Closed at', 16), money('collected', 'Collected'), int('in_transit', 'In transit', true), text('reopened', 'Reopened', 22)],
        rows: await rows(c, sql`
          SELECT d.business_date::text, b.code || ' — ' || b.name branch, d.status, u.full_name closed_by, to_char(d.closed_at AT TIME ZONE 'Asia/Kolkata', 'DD/MM/YYYY HH24:MI') closed_at,
            (d.summary->>'collected') collected, (d.summary->>'inTransit')::int in_transit,
            CASE WHEN d.reopened_at IS NOT NULL THEN to_char(d.reopened_at AT TIME ZONE 'Asia/Kolkata', 'DD/MM/YYYY') || ' — ' || coalesce(d.reopen_reason, '') END reopened
          FROM business_days d JOIN branches b ON b.id = d.branch_id LEFT JOIN users u ON u.id = d.closed_by
          WHERE d.business_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 'd.branch_id')}
          ORDER BY d.business_date, b.code`),
      };
    },
  },
  {
    name: 'recon-adjustments',
    title: 'Settlement differences',
    group: 'Reconciliation',
    description: 'Every cash shortage and excess, its reason, resolution and approval (E11).',
    permission: 'report.reconciliation',
    filters: ['from', 'to', 'branchId', 'status'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [date('business_date', 'Day'), text('employee', 'Employee', 18), text('direction', 'Short / excess', 10), money('amount', 'Amount'), text('reason_code', 'Reason', 16), text('resolution', 'Resolution', 20), text('notes', 'What happened', 30), text('status', 'Status', 10), text('recorded_by', 'Recorded by', 16), text('decided_by', 'Decided by', 16)],
        rows: await rows(c, sql`
          SELECT s.business_date::text, e.full_name employee, x.direction, x.amount::text, x.reason_code, x.resolution, x.notes, x.status, r.full_name recorded_by, d.full_name decided_by
          FROM settlement_differences x JOIN employee_settlements s ON s.id = x.settlement_id JOIN employees e ON e.id = s.employee_id
            JOIN users r ON r.id = x.recorded_by LEFT JOIN users d ON d.id = x.decided_by
          WHERE s.business_date BETWEEN ${f.from}::date AND ${f.to}::date ${inBranch(c, 's.branch_id')} ${eq('x.status', f.status)}
          ORDER BY s.business_date, e.full_name`),
      };
    },
  },
  {
    name: 'recon-upi',
    title: 'UPI & bank transfer confirmation',
    group: 'Reconciliation',
    description: 'UPI and bank-transfer receipts and whether a bank statement has confirmed them.',
    permission: 'report.reconciliation',
    filters: ['from', 'to', 'branchId', 'method', 'status'],
    defaults: period,
    required: ['from', 'to'],
    async run(c, f) {
      return {
        columns: [date('business_date', 'Date'), text('payment_no', 'Payment', 18), text('loan_no', 'Loan', 18), text('method', 'Method', 12), text('reference_no', 'UTR / reference', 18), money('amount', 'Amount'), text('reconciliation_status', 'Bank status', 12), text('reconciled_at', 'Confirmed', 16), int('age', 'Age (days)')],
        rows: await rows(c, sql`
          SELECT p.business_date::text, p.payment_no, l.loan_no, p.method, p.reference_no, p.amount::text, p.reconciliation_status, to_char(p.reconciled_at AT TIME ZONE 'Asia/Kolkata', 'DD/MM/YYYY HH24:MI') reconciled_at,
            CASE WHEN p.reconciliation_status = 'MATCHED' THEN NULL ELSE (${c.today}::date - p.business_date) END age
          FROM payments p JOIN loans l ON l.id = p.loan_id
          WHERE p.method IN ('UPI', 'BANK_TRANSFER') AND p.status <> 'REVERSED' AND p.business_date BETWEEN ${f.from}::date AND ${f.to}::date
            ${inBranch(c, 'p.branch_id')} ${eq('p.method', f.method)} ${eq('p.reconciliation_status', f.status)}
          ORDER BY p.business_date, p.payment_no`),
      };
    },
  },
  {
    name: 'recon-unmatched',
    title: 'Unmatched statement lines',
    group: 'Reconciliation',
    description: 'Bank statement lines not yet matched or explained.',
    permission: 'report.reconciliation',
    filters: ['accountId'],
    async run(c, f) {
      const banks = c.branches ? sql`AND (a.branch_id IS NULL OR a.branch_id = ANY(${c.branches}::uuid[]))` : sql``;
      return {
        columns: [date('txn_date', 'Date'), text('account', 'Bank account', 22), text('description', 'Narration', 36), text('reference', 'Reference', 16), money('debit', 'Debit'), money('credit', 'Credit'), text('match_status', 'Status', 10), int('age', 'Age (days)')],
        rows: await rows(c, sql`
          SELECT s.txn_date::text, a.name account, s.description, coalesce(s.utr, s.reference) reference, s.debit::text, s.credit::text, s.match_status, (${c.today}::date - s.txn_date) age
          FROM bank_statement_lines s JOIN accounts a ON a.id = s.account_id
          WHERE s.match_status IN ('UNMATCHED', 'SUGGESTED') ${eq('s.account_id', f.accountId)} ${banks}
          ORDER BY s.txn_date, s.seq`),
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

const recovery: ReportDef[] = [
  {
    name: 'recovery-cases',
    title: 'Recovery cases',
    group: 'Recovery',
    description: 'Open and closed recovery cases with stage, days past due and last contact.',
    permission: 'recovery.view',
    filters: ['branchId', 'status', 'bucket'],
    defaults: () => ({ status: 'OPEN' }),
    async run(c, f) {
      const r = bucketRange(f.bucket);
      return {
        columns: [text('case_no', 'Case', 18), text('loan_no', 'Loan', 18), text('customer', 'Customer', 20), text('branch', 'Branch', 8), text('stage', 'Stage', 18), date('opened_on', 'Opened'), int('dpd', 'DPD now'), money('overdue_amount', 'Overdue'), money('principal_outstanding', 'Principal o/s'), text('owner', 'Owner', 16), date('last_contact', 'Last contact'), text('status', 'Status', 8)],
        rows: await rows(c, sql`
          SELECT rc.case_no, l.loan_no, c.full_name customer, b.code branch, sd.name stage, (rc.opened_at AT TIME ZONE 'Asia/Kolkata')::date::text opened_on, l.dpd, l.overdue_amount::text,
            CASE WHEN l.status = 'ACTIVE' THEN l.principal_outstanding ELSE 0 END::text principal_outstanding, e.full_name owner,
            (SELECT (max(a.at) AT TIME ZONE 'Asia/Kolkata')::date::text FROM recovery_actions a WHERE a.case_id = rc.id AND a.action_type IN ('NOTE', 'CALL', 'VISIT')) last_contact, rc.status
          FROM recovery_cases rc JOIN loans l ON l.id = rc.loan_id JOIN customers c ON c.id = l.customer_id JOIN branches b ON b.id = rc.branch_id
            JOIN recovery_stage_definitions sd ON sd.code = rc.stage LEFT JOIN employees e ON e.id = rc.owner_employee_id
          WHERE true ${inBranch(c, 'rc.branch_id')} ${eq('rc.status', f.status)} ${r ? sql`AND l.dpd BETWEEN ${r[0]} AND ${r[1]}` : sql``} ${ownLoans(c)}
          ORDER BY rc.status DESC, l.dpd DESC`),
      };
    },
  },
  {
    name: 'repossessed-assets',
    title: 'Repossessed & sold assets',
    group: 'Recovery',
    description: 'Assets repossessed, where they are, and sale outcomes (E14).',
    permission: 'recovery.view',
    filters: ['branchId'],
    async run(c) {
      return {
        columns: [text('asset_no', 'Asset', 16), text('description', 'Asset', 22), text('loan_no', 'Loan', 18), date('repossessed_on', 'Repossessed'), text('location', 'Kept at', 18), money('valuation', 'Valuation'), text('outcome', 'Outcome', 14), money('sale_price', 'Sale price'), date('sold_on', 'Sold'), money('surplus_amount', 'Surplus owed')],
        rows: await rows(c, sql`
          SELECT a.asset_no, concat_ws(' ', a.make, a.model, a.registration_no) description, l.loan_no, r.repossessed_on::text, r.location, r.valuation::text,
            CASE WHEN s.id IS NOT NULL THEN 'Sold' WHEN r.released_on IS NOT NULL THEN 'Released' ELSE 'In custody' END outcome, s.sale_price::text, s.sold_on::text, s.surplus_amount::text
          FROM asset_repossessions r JOIN assets a ON a.id = r.asset_id JOIN loans l ON l.id = r.loan_id
            LEFT JOIN asset_sales s ON s.asset_id = a.id AND s.status = 'APPROVED' AND r.release_reason LIKE 'Sold%'
          WHERE true ${inBranch(c, 'a.branch_id')}
          ORDER BY r.repossessed_on DESC`),
      };
    },
  },
];

export const REPORTS: ReportDef[] = [...loans, ...collections, ...accounting, ...recon, ...recovery];
export const REPORT_BY_NAME = new Map(REPORTS.map((r) => [r.name, r]));
export type { ReportResult };
