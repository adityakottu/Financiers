'use client';

import { Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Button, Card, EmptyState, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td, Th } from '@/components/ui';
import { get, qs } from '@/lib/api';
import { date } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  customer_no: string;
  full_name: string;
  mobile: string;
  village_town: string | null;
  district: string | null;
  kyc_status: string;
  status: string;
  created_at: string;
  branch_code: string;
}

const FILTER_KEY = 'fin.customers.filters';

function CustomersList() {
  const { can, me } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  // Filters: URL first, then the user's last choice (remembered per browser).
  const remembered = (() => {
    try {
      return JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? remembered.status ?? '');
  const [kycStatus, setKycStatus] = useState(params.get('kycStatus') ?? remembered.kycStatus ?? '');
  const [branchId, setBranchId] = useState(params.get('branchId') ?? remembered.branchId ?? '');
  const term = useDebounced(q.trim(), 300);

  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const filters = { q: term, status, kycStatus, branchId, limit: 50 };

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ status, kycStatus, branchId }));
    } catch {
      /* storage unavailable */
    }
    const ctrl = new AbortController();
    setLoading(true);
    get<{ data: Row[]; nextCursor: string | null }>(`/customers${qs(filters)}`, ctrl.signal)
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, status, kycStatus, branchId]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await get<{ data: Row[]; nextCursor: string | null }>(`/customers${qs({ ...filters, cursor })}`);
      setRows((prev) => [...prev, ...r.data]);
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Profiles, KYC and documents"
        actions={
          can('customer.create') && (
            <Link href="/customers/new">
              <Button>
                <Plus className="size-4" /> New customer
              </Button>
            </Link>
          )
        }
      />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
          <Input type="search" placeholder="Name, mobile or customer ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter customers" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="BLACKLISTED">Blacklisted</option>
          </Select>
          <Select value={kycStatus} onChange={(e) => setKycStatus(e.target.value)} aria-label="KYC status">
            <option value="">All KYC</option>
            <option value="PENDING">KYC pending</option>
            <option value="PARTIAL">KYC partial</option>
            <option value="VERIFIED">KYC verified</option>
          </Select>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Branch" disabled={(me?.branches.length ?? 0) < 2}>
            <option value="">All branches</option>
            {me?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </div>

        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users className="size-8" />}
            title={term || status || kycStatus ? 'No customers match these filters' : 'No customers yet'}
            body={me?.scope === 'ASSIGNED' ? 'Customers appear here once loans are assigned to you.' : undefined}
            action={
              can('customer.create') && !term ? (
                <Link href="/customers/new">
                  <Button>Add the first customer</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>Customer</Th>
                    <Th>Customer ID</Th>
                    <Th>Mobile</Th>
                    <Th>Location</Th>
                    <Th>Branch</Th>
                    <Th>KYC</Th>
                    <Th>Status</Th>
                    <Th>Since</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => router.push(`/customers/${r.id}`)}>
                      <Td>
                        <Link href={`/customers/${r.id}`} className="font-medium text-ink-950 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {r.full_name}
                        </Link>
                      </Td>
                      <Td className="num font-mono text-[12px] text-muted">{r.customer_no}</Td>
                      <Td className="num">{r.mobile}</Td>
                      <Td className="text-muted">{[r.village_town, r.district].filter(Boolean).join(', ') || '—'}</Td>
                      <Td className="text-muted">{r.branch_code}</Td>
                      <Td>
                        <StatusBadge status={r.kyc_status} />
                      </Td>
                      <Td>
                        <StatusBadge status={r.status} />
                      </Td>
                      <Td className="num text-muted">{date(r.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {/* Mobile cards */}
            <ul className="divide-y divide-line md:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={`/customers/${r.id}`} className="flex items-center justify-between gap-3 px-4 py-3 active:bg-canvas">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink-950">{r.full_name}</p>
                      <p className="num truncate text-[12px] text-muted">
                        {r.customer_no} · {r.mobile}
                      </p>
                      <p className="truncate text-[12px] text-subtle">{r.village_town ?? r.branch_code}</p>
                    </div>
                    <StatusBadge status={r.kyc_status} />
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-[13px] text-muted">
              <span>Showing {rows.length}</span>
              {cursor && (
                <Button variant="secondary" size="sm" onClick={loadMore} loading={loadingMore}>
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

export default function CustomersPage() {
  return (
    <Suspense>
      <CustomersList />
    </Suspense>
  );
}
