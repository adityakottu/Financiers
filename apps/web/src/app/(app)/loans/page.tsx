'use client';

import { CATEGORY_LABELS, LOAN_CATEGORIES } from '@fin/contracts';
import { Landmark, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { DpdBadge, FREQUENCY_LABELS, LoanStatusBadge } from '@/components/lending';
import { Button, Card, Checkbox, cx, EmptyState, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { get, qs } from '@/lib/api';
import { date, inr } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  loan_no: string;
  status: string;
  category: string;
  principal: string;
  annual_rate: string;
  frequency: string;
  num_installments: number;
  installment_amount: string;
  balance_payable: string;
  overdue_amount: string;
  dpd: number;
  next_due_date: string | null;
  next_due_amount: string | null;
  created_at: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  branch_code: string;
  asset_label: string | null;
}

const TABS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'ACTIVE', label: 'Active' },
  { id: 'PENDING_APPROVAL', label: 'Awaiting approval' },
  { id: 'APPROVED', label: 'To disburse' },
  { id: 'DRAFT', label: 'Drafts' },
  { id: 'CLOSED', label: 'Closed' },
];

function LoansList() {
  const { can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [category, setCategory] = useState(params.get('category') ?? '');
  const [overdue, setOverdue] = useState(params.get('overdueOnly') === 'true');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const filters = { status, category, q: term, overdueOnly: overdue || undefined, limit: 50 };

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    get<{ data: Row[]; nextCursor: string | null }>(`/loans${qs(filters)}`, ctrl.signal)
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, category, overdue, term]);

  async function more() {
    const r = await get<{ data: Row[]; nextCursor: string | null }>(`/loans${qs({ ...filters, cursor })}`);
    setRows((p) => [...p, ...r.data]);
    setCursor(r.nextCursor);
  }

  return (
    <>
      <PageHeader
        title="Loans"
        subtitle="Applications, approvals and the active loan book"
        actions={
          can('loan.create') && (
            <Link href="/loans/new">
              <Button>
                <Plus className="size-4" /> New loan
              </Button>
            </Link>
          )
        }
      />
      <Card>
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={status === t.id}
              onClick={() => setStatus(t.id)}
              className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', status === t.id ? 'border-accent text-ink-950' : 'border-transparent text-muted hover:text-ink-800')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[2fr_1fr_auto] sm:items-center">
          <Input type="search" placeholder="Loan number, customer name or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter loans" />
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {LOAN_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Checkbox label="Overdue only" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
        </div>
        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Landmark className="size-8" />} title="No loans match" />
        ) : (
          <>
            <div className="hidden lg:block">
              <Table>
                <thead>
                  <tr>
                    <Th>Loan</Th>
                    <Th>Customer</Th>
                    <Th>Asset</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Terms</Th>
                    <Th className="text-right">Outstanding</Th>
                    <Th>Next due</Th>
                    <Th>Overdue</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => router.push(`/loans/${r.id}`)}>
                      <Td>
                        <Link href={`/loans/${r.id}`} onClick={(e) => e.stopPropagation()} className="num font-mono text-[12px] font-medium text-ink-950 hover:underline">
                          {r.loan_no}
                        </Link>
                        <p className="text-[11px] text-subtle">{CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS]}</p>
                      </Td>
                      <Td>
                        <p className="font-medium text-ink-950">{r.customer_name}</p>
                        <p className="num text-[11px] text-subtle">{r.customer_no}</p>
                      </Td>
                      <Td className="max-w-[12rem] truncate text-muted">{r.asset_label ?? '—'}</Td>
                      <Td className="num text-right">{inr(r.principal, { decimals: false })}</Td>
                      <Td className="whitespace-nowrap text-[12px] text-muted">
                        {Number(r.annual_rate)}% · {r.num_installments} {FREQUENCY_LABELS[r.frequency]?.toLowerCase()}
                      </Td>
                      <Td className="num text-right">{r.status === 'ACTIVE' ? inr(r.balance_payable) : <span className="text-subtle">—</span>}</Td>
                      <Td className="num whitespace-nowrap text-[12px]">
                        {r.next_due_date ? (
                          <>
                            {date(r.next_due_date)}
                            <span className="block text-subtle">{inr(r.next_due_amount)}</span>
                          </>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </Td>
                      <Td>
                        <DpdBadge dpd={r.dpd} />
                      </Td>
                      <Td>
                        <LoanStatusBadge status={r.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <ul className="divide-y divide-line lg:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={`/loans/${r.id}`} className="block px-4 py-3 active:bg-canvas">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-ink-950">{r.customer_name}</span>
                      <LoanStatusBadge status={r.status} />
                    </div>
                    <p className="num mt-0.5 text-[12px] text-muted">
                      {r.loan_no} · {inr(r.principal, { decimals: false })}
                    </p>
                    {r.status === 'ACTIVE' && (
                      <p className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                        Next {date(r.next_due_date)} · {inr(r.next_due_amount)} <DpdBadge dpd={r.dpd} />
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
              <span>Showing {rows.length}</span>
              {cursor && (
                <Button variant="secondary" size="sm" onClick={more}>
                  Load more
                </Button>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

export default function LoansPage() {
  return (
    <Suspense>
      <LoansList />
    </Suspense>
  );
}
