'use client';

import type { Schedule } from '@fin/loan-engine';
import { Badge, Table, Td, Th } from './ui';
import { date, inr } from '@/lib/format';

export const FREQUENCY_LABELS: Record<string, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  FORTNIGHTLY: 'Fortnightly',
  MONTHLY: 'Monthly',
  CUSTOM: 'Custom',
};
export const METHOD_LABELS: Record<string, string> = {
  FLAT: 'Flat',
  REDUCING_EMI: 'Reducing balance (EMI)',
  SIMPLE: 'Simple interest',
};
export const PERIOD_WORD: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', FORTNIGHTLY: 'fortnight', MONTHLY: 'month', CUSTOM: 'period' };

const LOAN_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent'> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warn',
  APPROVED: 'info',
  REJECTED: 'bad',
  ACTIVE: 'ok',
  CLOSED: 'accent',
  CANCELLED: 'neutral',
};
const LOAN_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved — to disburse',
  REJECTED: 'Rejected',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};
export function LoanStatusBadge({ status }: { status: string }) {
  return <Badge tone={LOAN_TONE[status] ?? 'neutral'}>{LOAN_LABEL[status] ?? status}</Badge>;
}

const INST_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info'> = {
  UPCOMING: 'neutral',
  DUE_TODAY: 'info',
  PARTIALLY_PAID: 'warn',
  PAID: 'ok',
  OVERDUE: 'bad',
  WAIVED: 'neutral',
};
export function InstallmentBadge({ status, days }: { status: string; days?: number }) {
  const label = status === 'OVERDUE' && days ? `Overdue ${days}d` : status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  return <Badge tone={INST_TONE[status] ?? 'neutral'}>{label}</Badge>;
}

export function DpdBadge({ dpd }: { dpd: number }) {
  if (!dpd) return <span className="text-subtle">—</span>;
  return <Badge tone={dpd > 30 ? 'bad' : 'warn'}>{dpd} DPD</Badge>;
}

/** Totals block shown under a preview and on the loan page. */
export function ScheduleTotals({ s }: { s: Schedule }) {
  const T = s.totals;
  const items: [string, string, string?][] = [
    ['Loan amount', inr(T.principal)],
    ['Interest', inr(T.interest)],
    ['Fees + GST', inr((Number(T.feesDeducted) + Number(T.feesInInstallments)).toFixed(2)), Number(T.feesDeducted) > 0 ? `${inr(T.feesDeducted)} deducted at disbursal` : undefined],
    ['Total repayable', inr(T.totalPayable)],
    ['Cash to customer', inr(T.netDisbursed)],
    [
      'Installment',
      inr(T.installmentAmount),
      T.lastInstallmentAmount !== T.installmentAmount ? `last one ${inr(T.lastInstallmentAmount)}` : `× ${s.rows.length}`,
    ],
    ['APR (true annual cost)', `${Number(s.apr).toFixed(2)}%`, 'includes fees; compare this across offers'],
    ['Last installment', date(s.maturityDate)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
      {items.map(([k, v, hint]) => (
        <div key={k} className="bg-surface px-4 py-3">
          <dt className="text-[12px] text-muted">{k}</dt>
          <dd className="num mt-0.5 text-[15px] font-semibold text-ink-950">{v}</dd>
          {hint && <dd className="text-[11px] text-subtle">{hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export interface InstallmentRow {
  installment_no: number;
  due_date: string;
  principal_due: string;
  interest_due: string;
  fees_due: string;
  penalty_due: string;
  total_due: string | null;
  total_paid: string | null;
  status: string;
  days_overdue: number;
  closing_principal: string;
}

/** Schedule from a preview (engine rows) or from a saved loan (installments with status). */
export function ScheduleTable({ rows, installments }: { rows?: Schedule['rows']; installments?: InstallmentRow[] }) {
  const saved = !!installments;
  const data = saved
    ? installments!.map((i) => ({
        no: i.installment_no,
        dueDate: i.due_date,
        principal: i.principal_due,
        interest: i.interest_due,
        fees: (Number(i.fees_due) + Number(i.penalty_due)).toFixed(2),
        total: i.total_due ?? '0',
        paid: i.total_paid ?? '0',
        balance: i.closing_principal,
        status: i.status,
        days: i.days_overdue,
      }))
    : rows!.map((r) => ({ no: r.no, dueDate: r.dueDate, principal: r.principal, interest: r.interest, fees: r.fees, total: r.total, paid: null, balance: r.closingPrincipal, status: null, days: 0 }));
  return (
    <div className="max-h-[480px] overflow-y-auto">
      <Table>
        <thead>
          <tr>
            <Th className="w-12 text-right">#</Th>
            <Th>Due date</Th>
            <Th className="text-right">Principal</Th>
            <Th className="text-right">Interest</Th>
            <Th className="text-right">{saved ? 'Fees + penal' : 'Fees'}</Th>
            <Th className="text-right">Installment</Th>
            {saved && <Th className="text-right">Paid</Th>}
            <Th className="text-right">Principal left</Th>
            {saved && <Th>Status</Th>}
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.no} className="hover:bg-canvas/60">
              <Td className="num text-right text-muted">{r.no}</Td>
              <Td className="num whitespace-nowrap">{date(r.dueDate)}</Td>
              <Td className="num text-right">{inr(r.principal)}</Td>
              <Td className="num text-right">{inr(r.interest)}</Td>
              <Td className="num text-right">{Number(r.fees) ? inr(r.fees) : <span className="text-subtle">—</span>}</Td>
              <Td className="num text-right font-medium text-ink-950">{inr(r.total)}</Td>
              {saved && <Td className="num text-right">{Number(r.paid) ? inr(r.paid) : <span className="text-subtle">—</span>}</Td>}
              <Td className="num text-right text-muted">{inr(r.balance)}</Td>
              {saved && (
                <Td>
                  <InstallmentBadge status={r.status!} days={r.days} />
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Add n months to a YYYY-MM-DD date, clamped to month end (for default first-due dates). */
export function plusMonths(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
export function plusDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function defaultFirstDue(disbursement: string, frequency: string, customDays?: number): string {
  switch (frequency) {
    case 'DAILY':
      return plusDays(disbursement, 1);
    case 'WEEKLY':
      return plusDays(disbursement, 7);
    case 'FORTNIGHTLY':
      return plusDays(disbursement, 14);
    case 'CUSTOM':
      return plusDays(disbursement, customDays || 10);
    default:
      return plusMonths(disbursement, 1);
  }
}
