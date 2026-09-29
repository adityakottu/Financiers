'use client';

import { CATEGORY_LABELS } from '@fin/contracts';
import { ArrowUpRight, CalendarClock, Clock3, FileWarning, HandCoins, Landmark, Scale, UserPlus, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, cx, PageHeader, Spinner, Table, Td, Th } from '@/components/ui';
import { count, inr } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface LoanKpis {
  active: number;
  closed: number;
  pipeline: number;
  awaitingApproval: number;
  awaitingDisbursal: number;
  principalOutstanding: string;
  interestOutstanding: string;
  receivable: string;
  overdueAmount: string;
  overdueLoans: number;
  totalDisbursed: string;
  disbursedToday: string;
  disbursedTodayCount: number;
  dueTodayCount: number;
  dueTodayAmount: string;
  byCategory: { category: string; count: number; outstanding: string }[];
}

interface Summary {
  loans: LoanKpis | null;
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
              {data.loans ? (
                <Kpi label="Due today" value={inr(data.loans.dueTodayAmount, { decimals: false })} icon={CalendarClock} hint={`${count(data.loans.dueTodayCount)} installments`} />
              ) : (
                <Planned label="Due today" icon={CalendarClock} phase="Phase 3" what="Installments falling due" />
              )}
              <Planned label="Total collections" icon={HandCoins} phase={data.availableFrom.collections!} what="Cash, UPI and bank split" />
              <Planned label="Reconciliation" icon={Scale} phase={data.availableFrom.reconciliation!} what="Reconciled / pending / difference" />
              {data.loans ? (
                <Kpi label="Disbursed today" value={inr(data.loans.disbursedToday, { decimals: false })} icon={Landmark} hint={`${count(data.loans.disbursedTodayCount)} loans`} href="/loans?status=ACTIVE" />
              ) : data.customers ? (
                <Kpi label="New customers today" value={count(data.customers.newToday)} icon={UserPlus} href="/customers" />
              ) : null}
            </div>
          </section>

          {data.loans && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Loan book</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Kpi label="Outstanding principal" value={inr(data.loans.principalOutstanding, { decimals: false })} icon={Wallet} hint={`${count(data.loans.active)} active loans`} href="/loans?status=ACTIVE" />
                <Kpi label="Total receivable" value={inr(data.loans.receivable, { decimals: false })} icon={Landmark} hint={`incl. accrued interest ${inr(data.loans.interestOutstanding, { decimals: false })}`} />
                <Kpi label="Overdue" value={inr(data.loans.overdueAmount, { decimals: false })} icon={Clock3} hint={`${count(data.loans.overdueLoans)} loans past due`} href="/loans?status=ACTIVE&overdueOnly=true" />
                <Kpi label="In the pipeline" value={count(data.loans.pipeline)} icon={FileWarning} hint={`${count(data.loans.awaitingApproval)} awaiting approval · ${count(data.loans.awaitingDisbursal)} to disburse`} href="/loans?status=PENDING_APPROVAL" />
              </div>
            </section>
          )}

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
              {data.loans && (
                <>
                  <Kpi label="Total disbursed" value={inr(data.loans.totalDisbursed, { decimals: false })} icon={Landmark} hint="Since inception" />
                  <Kpi label="Closed loans" value={count(data.loans.closed)} icon={Wallet} hint="Fully repaid" />
                </>
              )}
            </div>
          </section>

          {data.loans && data.loans.byCategory.length > 0 && (
            <Card>
              <CardHeader title="Active loans by category" />
              <div className="space-y-3 p-5">
                {(() => {
                  const max = Math.max(...data.loans.byCategory.map((c) => Number(c.outstanding)), 1);
                  return data.loans.byCategory.map((c) => (
                    <div key={c.category} className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-[13px]">
                      <span className="text-ink-800">{CATEGORY_LABELS[c.category as keyof typeof CATEGORY_LABELS] ?? c.category}</span>
                      <span className="h-2.5 overflow-hidden rounded-full bg-canvas">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${(Number(c.outstanding) / max) * 100}%` }} />
                      </span>
                      <span className="num w-44 text-right text-muted">
                        {inr(c.outstanding, { decimals: false })} · {c.count} loans
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </Card>
          )}

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
