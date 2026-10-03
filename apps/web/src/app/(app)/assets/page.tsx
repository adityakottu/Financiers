'use client';

import { CATEGORY_LABELS, LOAN_CATEGORIES } from '@fin/contracts';
import { Boxes } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td, Th } from '@/components/ui';
import { get, qs } from '@/lib/api';
import { date, inr } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { todayIST } from '@/components/lending';

interface Row {
  id: string;
  asset_no: string;
  category: string;
  status: string;
  description: string | null;
  make: string | null;
  model: string | null;
  registration_no: string | null;
  chassis_no: string | null;
  serial_no: string | null;
  asset_value: string | null;
  insurance_expiry: string | null;
  loan_id: string;
  loan_no: string;
  customer_name: string;
  branch_code: string;
}

export default function AssetsPage() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [category, setCategory] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const today = todayIST();
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  useEffect(() => {
    const ctrl = new AbortController();
    setRows(null);
    get<{ data: Row[]; nextCursor: string | null }>(`/assets${qs({ q: term, status, category, limit: 50 })}`, ctrl.signal)
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [term, status, category]);

  async function more() {
    const r = await get<{ data: Row[]; nextCursor: string | null }>(`/assets${qs({ q: term, status, category, limit: 50, cursor })}`);
    setRows((p) => [...(p ?? []), ...r.data]);
    setCursor(r.nextCursor);
  }

  return (
    <>
      <PageHeader title="Assets" subtitle="Every financed vehicle and product, with its loan and insurance status" />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Input type="search" placeholder="Registration, chassis, engine or serial number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search assets" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option>
            {['PENDING', 'ACTIVE', 'REPOSSESSED', 'RELEASED', 'SOLD', 'CLOSED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {LOAN_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        {!rows ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Boxes className="size-8" />} title="No assets match" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Asset</Th>
                  <Th>Identifier</Th>
                  <Th>Customer / loan</Th>
                  <Th className="text-right">Value</Th>
                  <Th>Insurance</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const expired = a.insurance_expiry && a.insurance_expiry < today;
                  const expiring = a.insurance_expiry && !expired && a.insurance_expiry <= soon;
                  return (
                    <tr key={a.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => router.push(`/assets/${a.id}`)}>
                      <Td>
                        <p className="font-medium text-ink-950">{[a.make, a.model].filter(Boolean).join(' ') || a.description}</p>
                        <p className="text-[12px] text-muted">
                          {a.asset_no} · {CATEGORY_LABELS[a.category as keyof typeof CATEGORY_LABELS]}
                        </p>
                      </Td>
                      <Td className="num font-mono text-[12px]">{a.registration_no ?? a.serial_no ?? a.chassis_no ?? '—'}</Td>
                      <Td>
                        <p>{a.customer_name}</p>
                        <Link href={`/loans/${a.loan_id}`} onClick={(e) => e.stopPropagation()} className="num font-mono text-[11px] text-ink-700 hover:underline">
                          {a.loan_no}
                        </Link>
                      </Td>
                      <Td className="num text-right">{a.asset_value ? inr(a.asset_value, { decimals: false }) : '—'}</Td>
                      <Td>{a.insurance_expiry ? <Badge tone={expired ? 'bad' : expiring ? 'warn' : 'neutral'}>{expired ? 'Expired' : 'Till'} {date(a.insurance_expiry)}</Badge> : <span className="text-subtle">—</span>}</Td>
                      <Td>
                        <StatusBadge status={a.status} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            {cursor && (
              <div className="border-t border-line p-3 text-center">
                <Button size="sm" variant="secondary" onClick={more}>
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
