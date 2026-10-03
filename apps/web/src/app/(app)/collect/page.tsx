'use client';

import { VISIT_OUTCOME_LABELS } from '@fin/contracts';
import { CalendarClock, Check, ChevronRight, MapPin, Phone, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { RemindButton, VisitDialog } from '@/components/collections';
import { CollectDialog, CollectTarget } from '@/components/payments';
import { MyCashCard } from '@/components/reconciliation';
import { Alert, Badge, Button, Card, cx, EmptyState, Input, PageHeader, Spinner } from '@/components/ui';
import { date, dateTime, inr } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface CardRow extends CollectTarget {
  category: string;
  dpd: number;
  customer_id: string;
  customer_no: string;
  mobile: string;
  village_town: string | null;
  address_line1: string | null;
  asset_label: string | null;
  frequency: string;
  to_collect: string;
  paid_today: string;
  group: 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING' | 'LATER';
  collected: boolean;
  last_visit_outcome: string | null;
  last_visit_at: string | null;
  ptp_amount: string | null;
  ptp_date: string | null;
}
interface Day {
  date: string;
  totals: { expected: string; collected: string; byMethod: Record<string, string>; payments: number; visits: number; cashInHand: string; customers: number; pending: number };
  cards: CardRow[];
}

type Filter = 'todo' | 'done' | 'upcoming' | 'all';

/** The collector's day (doc 01 §10): who to see, what to collect, and a < 30 s collect flow. */
export default function CollectPage() {
  const { me, can } = useSession();
  const { data, loading, error, reload } = useApi<Day>(me?.employee ? '/collections/my-day' : null);
  const [filter, setFilter] = useState<Filter>('todo');
  const [q, setQ] = useState('');
  const [collecting, setCollecting] = useState<CardRow | null>(null);
  const [visiting, setVisiting] = useState<CardRow | null>(null);

  const cards = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.cards ?? [])
      .filter((c) =>
        filter === 'all'
          ? true
          : filter === 'done'
            ? c.collected
            : filter === 'upcoming'
              ? c.group === 'UPCOMING'
              : (c.group === 'OVERDUE' || c.group === 'DUE_TODAY') && !c.collected,
      )
      .filter((c) => !t || c.customer_name.toLowerCase().includes(t) || c.loan_no.toLowerCase().includes(t) || (c.village_town ?? '').toLowerCase().includes(t) || (c.asset_label ?? '').toLowerCase().includes(t));
  }, [data, filter, q]);

  if (!can('payment.collect')) return <EmptyState title="You don’t collect payments" />;
  if (!me?.employee) return <EmptyState title="Your sign-in is not linked to an employee" body="Ask your branch manager to link your user to your employee record." />;
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert>{error?.message ?? 'Could not load your day'}</Alert>;

  const t = data.totals;
  const owing = data.cards.filter((c) => (c.group === 'OVERDUE' || c.group === 'DUE_TODAY') && Number(c.to_collect) > 0).length;
  const counts: Record<Filter, number> = {
    todo: data.cards.filter((c) => (c.group === 'OVERDUE' || c.group === 'DUE_TODAY') && !c.collected).length,
    done: data.cards.filter((c) => c.collected).length,
    upcoming: data.cards.filter((c) => c.group === 'UPCOMING').length,
    all: data.cards.length,
  };

  return (
    <>
      <PageHeader
        title="My collections"
        subtitle={`${date(data.date)} · ${t.customers} customers assigned`}
        actions={
          <Button variant="secondary" size="sm" onClick={reload}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        }
      />

      <Card className="mb-4 overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {[
            ['Collected today', inr(t.collected), `${t.payments} payment${t.payments === 1 ? '' : 's'} · ${t.visits} visit${t.visits === 1 ? '' : 's'}`],
            ['Still due today', inr(t.expected), `${owing} customer${owing === 1 ? '' : 's'} still owe · ${t.pending} not yet paid today`],
            ['Cash in hand', inr(t.cashInHand), 'to deposit / hand over'],
            ['UPI · Bank · Cheque', inr((Number(t.byMethod.UPI) + Number(t.byMethod.BANK_TRANSFER) + Number(t.byMethod.CHEQUE)).toFixed(2)), `cash ${inr(t.byMethod.CASH, { decimals: false })}`],
          ].map(([k, v, h]) => (
            <div key={k} className="bg-surface px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">{k}</p>
              <p className="num mt-0.5 text-lg font-semibold text-ink-950">{v}</p>
              <p className="text-[12px] text-muted">{h}</p>
            </div>
          ))}
        </div>
      </Card>

      {can('settlement.submit') && (
        <Card className="mb-4">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-950">End-of-day cash</h2>
            <p className="text-[12px] text-muted">Declare the cash you are handing over. Someone else counts it — you never approve your own cash.</p>
          </div>
          <MyCashCard employeeId={me.employee.id} day={data.date} />
        </Card>
      )}

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-canvas p-1" role="tablist">
          {(
            [
              ['todo', 'To collect'],
              ['done', 'Collected'],
              ['upcoming', 'Next 7 days'],
              ['all', 'All'],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={cx('whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium', filter === f ? 'bg-surface text-ink-950 shadow-sm' : 'text-muted')}>
              {label} <span className="num text-subtle">{counts[f]}</span>
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, village, loan, vehicle" aria-label="Filter customers" className="sm:ml-auto sm:max-w-xs" />
      </div>

      {cards.length === 0 ? (
        <Card>
          <EmptyState icon={<Check className="size-8" />} title={filter === 'todo' ? 'Nothing left to collect today' : 'No customers here'} body={filter === 'todo' ? 'Well done. Check “Next 7 days” to plan tomorrow.' : undefined} />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {cards.map((c) => (
            <li key={c.id}>
              <Card className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/loans/${c.id}`} className="block truncate font-semibold text-ink-950 hover:underline">
                      {c.customer_name}
                    </Link>
                    <p className="num truncate text-[12px] text-muted">
                      {c.loan_no}
                      {c.asset_label ? ` · ${c.asset_label}` : ''}
                    </p>
                    {(c.village_town || c.address_line1) && (
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[12px] text-muted">
                        <MapPin className="size-3 shrink-0" /> {[c.address_line1, c.village_town].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="num text-lg font-semibold text-ink-950">{inr(c.collected ? c.paid_today : c.to_collect, { decimals: false })}</p>
                    {c.collected ? (
                      <Badge tone="ok">
                        <Check className="size-3" /> Collected
                      </Badge>
                    ) : c.dpd > 0 ? (
                      <Badge tone={c.dpd > 30 ? 'bad' : 'warn'}>{c.dpd} days late</Badge>
                    ) : c.group === 'DUE_TODAY' ? (
                      <Badge tone="info">Due today</Badge>
                    ) : c.next_due_date ? (
                      <span className="text-[12px] text-muted">due {date(c.next_due_date)}</span>
                    ) : null}
                  </div>
                </div>
                {(c.ptp_date || c.last_visit_outcome) && (
                  <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
                    <CalendarClock className="size-3.5" />
                    {c.ptp_date ? `Promised ${inr(c.ptp_amount, { decimals: false })} by ${date(c.ptp_date)}` : `Last visit: ${VISIT_OUTCOME_LABELS[c.last_visit_outcome as keyof typeof VISIT_OUTCOME_LABELS] ?? c.last_visit_outcome} · ${dateTime(c.last_visit_at)}`}
                  </p>
                )}
                <div className="mt-3 grid grid-cols-[1fr_auto_auto_auto] gap-2">
                  <Button onClick={() => setCollecting(c)} className="h-11">
                    Collect
                  </Button>
                  <a href={`tel:${c.mobile}`} className="grid size-11 place-items-center rounded-md border border-line-strong text-ink-700 hover:bg-canvas" aria-label={`Call ${c.customer_name}`}>
                    <Phone className="size-4" />
                  </a>
                  <RemindButton loanId={c.id} name={c.customer_name} overdue={Number(c.overdue_amount) > 0} />
                  <Button variant="secondary" onClick={() => setVisiting(c)} className="h-11 px-3" aria-label={`Record visit for ${c.customer_name}`}>
                    Visit <ChevronRight className="size-4" />
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {collecting && <CollectDialog loan={collecting} onClose={() => setCollecting(null)} onDone={() => reload()} />}
      {visiting && <VisitDialog card={visiting} onClose={() => setVisiting(null)} onDone={reload} />}
    </>
  );
}

