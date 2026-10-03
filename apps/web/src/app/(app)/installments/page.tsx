'use client';

import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { InstallmentBadge, plusDays, todayIST } from '@/components/lending';
import { Card, cx, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Th } from '@/components/ui';
import { qs } from '@/lib/api';
import { date, inr } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  installment_no: number;
  due_date: string;
  status: string;
  days_overdue: number;
  outstanding: string;
  loan_id: string;
  loan_no: string;
  customer_id: string;
  customer_name: string;
  mobile: string | null;
  village_town: string | null;
  branch_code: string;
  collector_name: string | null;
}

/** Installments falling due in a period, or all overdue — the list collectors and managers plan from. */
export default function InstallmentsPage() {
  const { can } = useSession();
  const today = todayIST();
  const [view, setView] = useState<'DUE' | 'OVERDUE'>('DUE');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const { data, loading } = useApi<{ data: Row[]; total: string; truncated: boolean }>(can('loan.view') ? `/collections/installments${qs({ view, from, to })}` : null);

  return (
    <>
      <PageHeader title="Installments due" subtitle="Unpaid installments by due date" />
      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-end">
          <div className="flex gap-1 rounded-lg bg-canvas p-1" role="tablist">
            {(
              [
                ['DUE', 'Due in period'],
                ['OVERDUE', 'All overdue'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cx('rounded-md px-3 py-1.5 text-[13px] font-medium', view === v ? 'bg-surface shadow-sm' : 'text-muted')}>
                {l}
              </button>
            ))}
          </div>
          {view === 'DUE' && (
            <>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <div className="flex gap-2 pb-0.5 text-[12px]">
                {[
                  ['Today', today, today],
                  ['Tomorrow', plusDays(today, 1), plusDays(today, 1)],
                  ['Next 7 days', today, plusDays(today, 7)],
                ].map(([l, f, t]) => (
                  <button
                    key={l}
                    onClick={() => {
                      setFrom(f!);
                      setTo(t!);
                    }}
                    className="rounded-full border border-line px-3 py-1 hover:bg-canvas"
                  >
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
          {data && (
            <p className="text-[13px] sm:ml-auto">
              <span className="text-muted">{data.data.length} installments · </span>
              <span className="num font-semibold">{inr(data.total)}</span>
            </p>
          )}
        </div>
        {loading || !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<CalendarClock className="size-8" />} title={view === 'OVERDUE' ? 'Nothing overdue' : 'Nothing due in this period'} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Due</Th>
                <Th>Customer</Th>
                <Th>Loan</Th>
                <Th className="text-right">Unpaid</Th>
                <Th>Status</Th>
                <Th>Collector</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((r) => (
                <tr key={r.id}>
                  <Td className="num whitespace-nowrap">{date(r.due_date)}</Td>
                  <Td className="min-w-40">
                    <Link href={`/customers/${r.customer_id}`} className="font-medium hover:underline">
                      {r.customer_name}
                    </Link>
                    <p className="num text-[12px] text-muted">{[r.mobile, r.village_town].filter(Boolean).join(' · ')}</p>
                  </Td>
                  <Td>
                    <Link href={`/loans/${r.loan_id}`} className="num font-mono text-[12px] hover:underline">
                      {r.loan_no}
                    </Link>
                    <p className="text-[12px] text-muted">
                      #{r.installment_no} · {r.branch_code}
                    </p>
                  </Td>
                  <Td className="num text-right font-medium">{inr(r.outstanding)}</Td>
                  <Td>
                    <InstallmentBadge status={r.status} days={r.days_overdue} />
                  </Td>
                  <Td className="text-[12px] text-muted">{r.collector_name ?? <span className="text-warn">Unassigned</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {data?.truncated && <p className="border-t border-line px-4 py-2 text-[12px] text-muted">Showing the first {data.data.length}. Narrow the dates to see the rest.</p>}
      </Card>
    </>
  );
}
