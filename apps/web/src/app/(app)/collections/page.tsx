'use client';

import { REVERSAL_REASON_LABELS } from '@fin/contracts';
import { HandCoins, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { todayIST } from '@/components/lending';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { api, ApiError, get, qs } from '@/lib/api';
import { date, dateTime, inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Summary {
  date: string;
  total: string;
  collectors: {
    id: string; full_name: string; employee_code: string; branch_code: string; loans: string; overdue_loans: string; overdue_amount: string; due_today: string;
    cash: string; upi: string; bank: string; cheque: string; payments: string; visits: string; promises: string;
  }[];
  unassigned: { loans: number; overdue: string };
  other: { method: string; total: string }[];
}
interface Reversal {
  id: string; reason_code: string; reason_text: string; requested_at: string; requested_by_name: string | null;
  payment_id: string; payment_no: string; amount: string; method: string; loan_no: string; customer_name: string; branch_code: string; canDecide: boolean;
}

const sum = (...xs: string[]) => xs.reduce((s, x) => s + Number(x), 0).toFixed(2);

export default function CollectionsPage() {
  const { can } = useSession();
  const [day, setDay] = useState(todayIST());
  const { data, loading, reload } = useApi<Summary>(can('collection.view_team') ? `/collections/summary${qs({ date: day })}` : null);
  const reversals = useApi<{ data: Reversal[] }>(can('payment.view') ? '/reversals' : null);
  const [assign, setAssign] = useState(false);

  if (!can('collection.view_team')) return <EmptyState title="You don’t have access to team collections" />;
  return (
    <>
      <PageHeader
        title="Collections"
        subtitle="What each collector collected, and who still needs a visit"
        actions={
          <>
            <Input type="date" value={day} max={todayIST()} onChange={(e) => setDay(e.target.value)} aria-label="Date" className="w-auto" />
            {can('collection.assign') && (
              <Button onClick={() => setAssign(true)}>
                <UserPlus className="size-4" /> Assign loans
              </Button>
            )}
          </>
        }
      />

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Collected', inr(data.total), `${date(data.date)}`],
              ['Cash', inr(sum(...data.collectors.map((c) => c.cash), ...data.other.filter((o) => o.method === 'CASH').map((o) => o.total))), 'with collectors / at counter'],
              ['UPI · bank · cheque', inr(sum(...data.collectors.flatMap((c) => [c.upi, c.bank, c.cheque]), ...data.other.filter((o) => o.method !== 'CASH').map((o) => o.total))), 'awaiting bank match (Phase 6)'],
              ['Unassigned loans', String(data.unassigned.loans), `${inr(data.unassigned.overdue, { decimals: false })} overdue`],
            ].map(([k, v, h]) => (
              <Card key={k} className="px-4 py-3">
                <p className="text-[12px] font-medium uppercase tracking-wide text-subtle">{k}</p>
                <p className="num mt-1 text-lg font-semibold text-ink-950">{v}</p>
                <p className="text-[12px] text-muted">{h}</p>
              </Card>
            ))}
          </div>

          <Card className="mb-6">
            <CardHeader title="By collector" description="Collected amounts exclude reversed payments. Settlement and cash verification come with daily reconciliation (Phase 6)." />
            {data.collectors.length === 0 ? (
              <EmptyState icon={<HandCoins className="size-8" />} title="No collectors yet" body="Mark employees as collectors under Organisation → Employees." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Collector</Th>
                    <Th className="text-right">Loans</Th>
                    <Th className="text-right">Overdue</Th>
                    <Th className="text-right">Due that day</Th>
                    <Th className="text-right">Cash</Th>
                    <Th className="text-right">UPI</Th>
                    <Th className="text-right">Bank</Th>
                    <Th className="text-right">Cheque</Th>
                    <Th className="text-right">Total</Th>
                    <Th className="text-right">Visits</Th>
                    <Th className="text-right">Open promises</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.collectors.map((c) => (
                    <tr key={c.id}>
                      <Td>
                        <span className="font-medium">{c.full_name}</span>
                        <span className="block text-[12px] text-muted">
                          {c.employee_code} · {c.branch_code}
                        </span>
                      </Td>
                      <Td className="num text-right">
                        <Link href={`/loans?status=ACTIVE&collector=${c.id}`} className="hover:underline">
                          {c.loans}
                        </Link>
                      </Td>
                      <Td className="num text-right">
                        {Number(c.overdue_loans) > 0 ? (
                          <span className="text-bad">
                            {inr(c.overdue_amount, { decimals: false })} <span className="text-[11px]">({c.overdue_loans})</span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </Td>
                      <Td className="num text-right">{inr(c.due_today, { decimals: false })}</Td>
                      <Td className="num text-right">{inr(c.cash, { decimals: false })}</Td>
                      <Td className="num text-right">{inr(c.upi, { decimals: false })}</Td>
                      <Td className="num text-right">{inr(c.bank, { decimals: false })}</Td>
                      <Td className="num text-right">{inr(c.cheque, { decimals: false })}</Td>
                      <Td className="num text-right font-semibold">{inr(sum(c.cash, c.upi, c.bank, c.cheque), { decimals: false })}</Td>
                      <Td className="num text-right">{c.visits}</Td>
                      <Td className="num text-right">{c.promises}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}

      {can('payment.view') && (
        <Card>
          <CardHeader title="Reversals waiting for approval" description="The person who asked for a reversal can’t approve it." />
          {!reversals.data ? (
            <Spinner />
          ) : reversals.data.data.length === 0 ? (
            <EmptyState title="Nothing waiting" />
          ) : (
            <ul className="divide-y divide-line">
              {reversals.data.data.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 text-[13px]">
                    <p className="font-medium">
                      <span className="num font-mono">{r.payment_no}</span> · {inr(r.amount)} · {r.customer_name} ({r.loan_no})
                    </p>
                    <p className="text-muted">
                      {REVERSAL_REASON_LABELS[r.reason_code as keyof typeof REVERSAL_REASON_LABELS]}: {r.reason_text}
                    </p>
                    <p className="text-[12px] text-subtle">
                      Asked by {r.requested_by_name} · {dateTime(r.requested_at)}
                    </p>
                  </div>
                  <Link href={`/payments/${r.payment_id}`}>
                    <Button size="sm" variant={r.canDecide ? 'primary' : 'secondary'}>
                      {r.canDecide ? 'Review' : 'View'}
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {assign && (
        <AssignDialog
          onClose={() => setAssign(false)}
          onDone={() => {
            setAssign(false);
            reload();
          }}
        />
      )}
    </>
  );
}

interface LoanRow {
  id: string;
  loan_no: string;
  customer_name: string;
  branch_code: string;
  overdue_amount: string;
  dpd: number;
  asset_label: string | null;
  collector_name: string | null;
}

function AssignDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [show, setShow] = useState<'none' | 'all'>('none');
  const [loans, setLoans] = useState<LoanRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [collectors, setCollectors] = useState<{ id: string; full_name: string; branch_code: string; active_loans: string }[]>([]);
  const [to, setTo] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setLoans(null);
    get<{ data: LoanRow[] }>(`/loans${qs({ status: 'ACTIVE', collector: show === 'none' ? 'none' : undefined, limit: 200 })}`).then((r) => setLoans(r.data));
  }, [show]);
  useEffect(() => {
    get<{ data: typeof collectors }>('/collections/collectors').then((r) => {
      setCollectors(r.data);
      if (r.data[0]) setTo(r.data[0].id);
    });
  }, []);

  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ changed: number }>('POST', '/collections/assign', { body: { loanIds: [...picked], employeeId: to } });
      toast('ok', `${r.changed} loan${r.changed === 1 ? '' : 's'} assigned`);
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Assign loans to a collector"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy} disabled={!picked.size || !to}>
            Assign {picked.size || ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Collector">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {collectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name} · {c.branch_code} ({c.active_loans} loans)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show">
            <Select value={show} onChange={(e) => setShow(e.target.value as 'none' | 'all')}>
              <option value="none">Loans without a collector</option>
              <option value="all">All active loans (re-assign)</option>
            </Select>
          </Field>
        </div>
        {!loans ? (
          <Spinner />
        ) : loans.length === 0 ? (
          <EmptyState title="Every active loan has a collector" />
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-md border border-line">
            <div className="border-b border-line bg-canvas px-3 py-2">
              <Checkbox label={`Select all (${loans.length})`} checked={picked.size === loans.length} onChange={(e) => setPicked(e.target.checked ? new Set(loans.map((l) => l.id)) : new Set())} />
            </div>
            <ul className="divide-y divide-line">
              {loans.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <Checkbox
                    label={
                      <span>
                        <span className="font-medium">{l.customer_name}</span> <span className="num text-muted">{l.loan_no}</span>
                        {l.collector_name && <span className="text-subtle"> · now {l.collector_name}</span>}
                      </span>
                    }
                    checked={picked.has(l.id)}
                    onChange={(e) =>
                      setPicked((p) => {
                        const n = new Set(p);
                        if (e.target.checked) n.add(l.id);
                        else n.delete(l.id);
                        return n;
                      })
                    }
                  />
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge>{l.branch_code}</Badge>
                    {l.dpd > 0 && <Badge tone="warn">{l.dpd} DPD</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
