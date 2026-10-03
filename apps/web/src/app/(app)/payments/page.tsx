'use client';

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from '@fin/contracts';
import { Receipt } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PaymentRow, PaymentsTable } from '@/components/loan-collections';
import { todayIST } from '@/components/lending';
import { Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { get, qs } from '@/lib/api';
import { inr } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';

export default function PaymentsPage() {
  const { can } = useSession();
  const [from, setFrom] = useState(todayIST());
  const [to, setTo] = useState(todayIST());
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const filters = { from, to, method, status, q: term, limit: 100 };

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    get<{ data: PaymentRow[]; nextCursor: string | null }>(`/payments${qs(filters)}`, ctrl.signal)
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, method, status, term]);

  async function more() {
    const r = await get<{ data: PaymentRow[]; nextCursor: string | null }>(`/payments${qs({ ...filters, cursor })}`);
    setRows((p) => [...p, ...r.data]);
    setCursor(r.nextCursor);
  }

  if (!can('payment.view')) return <EmptyState title="You don’t have access to payments" />;
  const live = rows.filter((r) => r.status !== 'REVERSED');
  const byMethod = PAYMENT_METHODS.map((m) => [m, live.filter((r) => r.method === m).reduce((s, r) => s + Number(r.amount), 0)] as const).filter(([, v]) => v > 0);

  return (
    <>
      <PageHeader title="Payments & receipts" subtitle="Every payment received, with its receipt. Payments are never edited — corrections are reversals." />
      <Card>
        <div className="grid grid-cols-2 gap-3 border-b border-line p-4 md:grid-cols-[1fr_1fr_1fr_1fr_2fr]">
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">All</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="POSTED">Posted</option>
              <option value="REVERSAL_PENDING">Reversal pending</option>
              <option value="REVERSED">Reversed</option>
            </Select>
          </Field>
          <Field label="Search" className="col-span-2 md:col-span-1">
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Payment, receipt, UTR, loan, name" />
          </Field>
        </div>
        {!loading && rows.length > 0 && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-4 py-2.5 text-[13px]">
            <span>
              <span className="text-muted">Received </span>
              <span className="num font-semibold">{inr(live.reduce((s, r) => s + Number(r.amount), 0).toFixed(2))}</span>
              <span className="text-muted"> in {live.length} payments{cursor ? ' (first page)' : ''}</span>
            </span>
            {byMethod.map(([m, v]) => (
              <span key={m} className="text-muted">
                {PAYMENT_METHOD_LABELS[m]} <span className="num text-ink-900">{inr(v.toFixed(2))}</span>
              </span>
            ))}
          </div>
        )}
        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Receipt className="size-8" />} title="No payments in this period" />
        ) : (
          <>
            <PaymentsTable rows={rows} showLoan />
            {cursor && (
              <div className="border-t border-line p-3 text-center">
                <Button variant="secondary" size="sm" onClick={more}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
