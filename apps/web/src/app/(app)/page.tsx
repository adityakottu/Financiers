'use client';

import { ArrowLeft, Landmark } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Stat, StatGrid } from '@/components/charts';
import { BranchDashboard, CollectorDashboard, CompanyDashboard } from '@/components/dashboards';
import { EmptyState, PageHeader, Spinner } from '@/components/ui';
import { count, inr } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Summary {
  loans: { awaitingApproval: number; awaitingDisbursal: number; dueTodayCount: number; dueTodayAmount: string; disbursedToday: string; disbursedTodayCount: number } | null;
  customers: { kycPending: number; newToday: number } | null;
}

/** What needs someone today — the pipeline counts from the summary endpoint. */
function Attention() {
  const { data } = useApi<Summary>('/dashboard/summary');
  if (!data?.loans) return null;
  const l = data.loans;
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-muted">Needs attention</h2>
      <StatGrid>
        <Link href="/loans?status=PENDING_APPROVAL" className="contents">
          <Stat label="Loans awaiting approval" value={count(l.awaitingApproval)} hint={`${count(l.awaitingDisbursal)} approved, to disburse`} tone={l.awaitingApproval ? 'warn' : undefined} />
        </Link>
        <Stat label="Due today" value={inr(l.dueTodayAmount, { decimals: false })} hint={`${count(l.dueTodayCount)} installments`} />
        <Stat label="Disbursed today" value={inr(l.disbursedToday, { decimals: false })} hint={`${count(l.disbursedTodayCount)} loans`} />
        {data.customers ? <Stat label="KYC to complete" value={count(data.customers.kycPending)} hint={`${count(data.customers.newToday)} new customers today`} /> : <Stat label="—" value="" />}
      </StatGrid>
    </section>
  );
}

function Dashboard() {
  const { me, can } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const collectorId = params.get('collector');
  const branchId = params.get('branch');
  const greeting = (() => {
    const h = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();
  const today = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date());
  const goBranch = (id: string) => router.push(`/?branch=${id}`);
  const back = (collectorId || (branchId && can('dashboard.company'))) && (
    <button type="button" onClick={() => router.back()} className="mb-4 inline-flex items-center gap-1 text-[13px] text-ink-700 hover:underline">
      <ArrowLeft className="size-3.5" /> Back
    </button>
  );

  let body: React.ReactNode;
  if (!me) body = <Spinner />;
  else if (collectorId && (can('dashboard.branch') || can('dashboard.company') || me.employee?.id === collectorId)) body = <CollectorDashboard employeeId={collectorId} self={me.employee?.id === collectorId} />;
  else if (can('dashboard.company') && !branchId)
    body = (
      <div className="space-y-8">
        <Attention />
        <CompanyDashboard onBranch={goBranch} />
      </div>
    );
  else if (can('dashboard.branch'))
    body = (
      <div className="space-y-8">
        {!branchId && <Attention />}
        <BranchDashboard branchId={branchId} onBranch={goBranch} />
      </div>
    );
  else if (can('dashboard.collector') && me.employee) body = <CollectorDashboard employeeId={me.employee.id} self />;
  else body = <EmptyState icon={<Landmark className="size-8" />} title="Welcome" body="Use the menu to get started. Your role has no dashboard." />;

  return (
    <>
      <PageHeader title={`${greeting}, ${me?.fullName.split(' ')[0] ?? ''}`} subtitle={today} />
      {back}
      {body}
    </>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Dashboard />
    </Suspense>
  );
}

