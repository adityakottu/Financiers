'use client';

import { ArrowUpRight, Clock3, FileWarning, HandCoins, Landmark, Scale, UserPlus, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, cx, PageHeader, Spinner, Table, Td, Th } from '@/components/ui';
import { count } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Summary {
  customers: { active: number; total: number; kycPending: number; newToday: number } | null;
  staff: { active: number; collectors: number } | null;
  branches: { id: string; code: string; name: string; activeCustomers: number }[];
  availableFrom: Record<string, string>;
}

function Kpi({ label, value, icon: Icon, hint, href }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; hint?: string; href?: string }) {
  const body = (
    <Card className={cx('p-5', href && 'transition-colors hover:border-line-strong')}>
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <Icon className="size-4 text-subtle" />
      </div>
      <p className="num mt-2 text-[26px] font-semibold tracking-tight text-ink-950">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-subtle">{hint}</p>}
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** A metric whose data doesn't exist yet — honest placeholder, never a fake zero. */
function Planned({ label, icon: Icon, phase, what }: { label: string; icon: React.ComponentType<{ className?: string }>; phase: string; what: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface/50 p-5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <Icon className="size-4 text-subtle" />
      </div>
      <p className="mt-2 text-[15px] font-medium text-subtle">Not yet available</p>
      <p className="mt-1 text-[12px] text-subtle">
        {what} · <span className="font-medium">{phase}</span>
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const { me, can } = useSession();
  const { data, loading } = useApi<Summary>('/dashboard/summary');
  const greeting = (() => {
    const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();
  const today = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());

  return (
    <>
      <PageHeader title={`${greeting}, ${me?.fullName.split(' ')[0] ?? ''}`} subtitle={today} />

      {loading || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Today</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Planned label="Total collections" icon={HandCoins} phase={data.availableFrom.collections!} what="Cash, UPI and bank split" />
              <Planned label="Overdue amount" icon={Clock3} phase={data.availableFrom.loans!} what="From installment schedules" />
              <Planned label="Reconciliation" icon={Scale} phase={data.availableFrom.reconciliation!} what="Reconciled / pending / difference" />
              {data.customers ? (
                <Kpi label="New customers today" value={count(data.customers.newToday)} icon={UserPlus} href="/customers" />
              ) : (
                <Planned label="New loans" icon={Landmark} phase={data.availableFrom.loans!} what="Disbursements today" />
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Portfolio</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {data.customers && (
                <>
                  <Kpi label="Active customers" value={count(data.customers.active)} icon={Users} hint={`${count(data.customers.total)} on record`} href="/customers?status=ACTIVE" />
                  <Kpi
                    label="KYC to complete"
                    value={count(data.customers.kycPending)}
                    icon={FileWarning}
                    hint="Pending or partially verified"
                    href="/customers?kycStatus=PARTIAL"
                  />
                </>
              )}
              <Planned label="Outstanding principal" icon={Wallet} phase={data.availableFrom.loans!} what="Active loan book" />
              <Planned label="Total disbursed" icon={Landmark} phase={data.availableFrom.loans!} what="Since inception" />
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            {data.branches.length > 0 && (
              <Card className="xl:col-span-2">
                <CardHeader title="Branches" description="Active customers by branch" />
                <Table>
                  <thead>
                    <tr>
                      <Th>Branch</Th>
                      <Th className="text-right">Active customers</Th>
                      <Th className="text-right">Outstanding</Th>
                      <Th className="text-right">Today’s collection</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.branches.map((b) => (
                      <tr key={b.id} className="hover:bg-canvas/60">
                        <Td>
                          <span className="font-medium text-ink-950">{b.name}</span>
                          <span className="ml-2 text-[12px] text-subtle">{b.code}</span>
                        </Td>
                        <Td className="num text-right">{count(b.activeCustomers)}</Td>
                        <Td className="text-right text-subtle">—</Td>
                        <Td className="text-right text-subtle">—</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            )}
            {data.staff && (
              <Card>
                <CardHeader title="Team" actions={can('employee.view') ? <Link href="/admin/employees" className="inline-flex items-center gap-1 text-[13px] text-ink-700 hover:underline">View <ArrowUpRight className="size-3.5" /></Link> : null} />
                <div className="grid grid-cols-2 divide-x divide-line">
                  <div className="p-5">
                    <p className="text-[13px] text-muted">Active employees</p>
                    <p className="num mt-1 text-2xl font-semibold text-ink-950">{count(data.staff.active)}</p>
                  </div>
                  <div className="p-5">
                    <p className="text-[13px] text-muted">Collectors</p>
                    <p className="num mt-1 text-2xl font-semibold text-ink-950">{count(data.staff.collectors)}</p>
                  </div>
                </div>
                <p className="border-t border-line px-5 py-3 text-[12px] text-subtle">
                  Per-collector targets, collections and settlement differences arrive with Collections ({data.availableFrom.collections}).
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
