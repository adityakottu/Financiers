'use client';

import { ArrowUpRight, CheckCircle2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BarChart, Stat, StatGrid } from './charts';
import { Badge, Card, CardHeader, cx, EmptyState, Field, Select, Spinner, Table, Td, Th } from './ui';
import { get } from '@/lib/api';
import { compactInr, count, date, inr, pct } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Portfolio {
  activeLoans: number;
  principalOutstanding: string;
  receivable: string;
  overdueAmount: string;
  overdueLoans: number;
  par30Pct: number | null;
  par90Pct: number | null;
  buckets: { label: string; loans: number; principal: string }[];
}
interface Collections { today: string; todayCount: number; mtd: string; mtdCount: number; mtdCash: string; mtdDigital: string; daily: { date: string; total: string }[] }
interface Efficiency { demand: string; collected: string; pct: number | null }
interface Recovery { openCases: number; pendingApprovals: number; assetsInCustody: number; writtenOffYtd: number; writtenOffYtdAmount: string }

const rupees = (v: number) => inr(v.toFixed(2), { decimals: false });
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const monthLabel = (m: string) => new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const More = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="inline-flex items-center gap-1 text-[13px] text-ink-700 hover:underline">
    {children} <ArrowUpRight className="size-3.5" />
  </Link>
);

function CollectionsChart({ c, days }: { c: Collections; days: number }) {
  return (
    <Card>
      <CardHeader title={`Collections — last ${days} days`} description={`Today ${inr(c.today, { decimals: false })} (${count(c.todayCount)} payments) · this month ${inr(c.mtd, { decimals: false })}`} />
      <div className="px-5 pb-4">
        <BarChart
          label={`Money collected per day, last ${days} days`}
          data={c.daily.map((d) => ({ key: d.date, label: dayLabel(d.date), title: date(d.date), value: Number(d.total) }))}
          format={rupees}
          axisFormat={compactInr}
        />
      </div>
    </Card>
  );
}

function BucketsChart({ p }: { p: Portfolio }) {
  return (
    <Card>
      <CardHeader title="Principal outstanding by days past due" description={`PAR 30 ${pct(p.par30Pct)} · PAR 90 ${pct(p.par90Pct)} of ${inr(p.principalOutstanding, { decimals: false })}`} />
      <div className="px-5 pb-4">
        <BarChart
          label="Principal outstanding by days-past-due bucket"
          data={p.buckets.map((b) => ({ key: b.label, label: b.label === 'Current' ? 'Current' : `${b.label} d`, title: b.label === 'Current' ? 'Not overdue' : `${b.label} days past due`, value: Number(b.principal), detail: `${count(b.loans)} loans` }))}
          format={rupees}
          axisFormat={compactInr}
        />
      </div>
    </Card>
  );
}

function PortfolioStats({ p, c, e }: { p: Portfolio; c: Collections; e: Efficiency }) {
  return (
    <StatGrid cols={6}>
      <Stat label="Principal outstanding" value={inr(p.principalOutstanding, { decimals: false })} hint={`${count(p.activeLoans)} active loans`} />
      <Stat label="Overdue" value={inr(p.overdueAmount, { decimals: false })} hint={`${count(p.overdueLoans)} loans past due`} tone={p.overdueLoans ? 'warn' : undefined} />
      <Stat label="PAR 30" value={pct(p.par30Pct)} hint={`PAR 90 ${pct(p.par90Pct)}`} tone={(p.par30Pct ?? 0) > 10 ? 'bad' : undefined} />
      <Stat label="Collected today" value={inr(c.today, { decimals: false })} hint={`${count(c.todayCount)} payments`} />
      <Stat label="Collected this month" value={inr(c.mtd, { decimals: false })} hint={`cash ${inr(c.mtdCash, { decimals: false })} · digital ${inr(c.mtdDigital, { decimals: false })}`} />
      <Stat label="Collection efficiency" value={pct(e.pct)} hint={`${inr(e.collected, { decimals: false })} of ${inr(e.demand, { decimals: false })} due this month`} />
    </StatGrid>
  );
}

function RecoveryStats({ r }: { r: Recovery }) {
  return (
    <StatGrid>
      <Stat label="Open recovery cases" value={count(r.openCases)} />
      <Stat label="Waiting for approval" value={count(r.pendingApprovals)} hint="stage moves, sales, write-offs" tone={r.pendingApprovals ? 'warn' : undefined} />
      <Stat label="Repossessed, in custody" value={count(r.assetsInCustody)} />
      <Stat label="Written off this year" value={inr(r.writtenOffYtdAmount, { decimals: false })} hint={`${count(r.writtenOffYtd)} loans`} />
    </StatGrid>
  );
}

/* ------------------------------------------------------------------ */

interface CompanyData {
  asOf: string;
  portfolio: Portfolio;
  collections: Collections;
  disbursements: { month: string; loans: number; amount: string }[];
  efficiency: Efficiency;
  recovery: Recovery;
  branches: { id: string; code: string; name: string; activeLoans: number; principalOutstanding: string; overdue: string; par30Pct: number | null; collectedMtd: string; efficiencyPct: number | null; yesterdayClosed: boolean }[];
}

export function CompanyDashboard({ onBranch }: { onBranch: (id: string) => void }) {
  const { can } = useSession();
  const { data } = useApi<CompanyData>('/dashboard/company');
  if (!data) return <Spinner />;
  return (
    <div className="space-y-8">
      <Section title="Portfolio & collections">
        <PortfolioStats p={data.portfolio} c={data.collections} e={data.efficiency} />
      </Section>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CollectionsChart c={data.collections} days={30} />
        <BucketsChart p={data.portfolio} />
      </div>
      <Section title="Branches" action={can('report.loan') ? <More href="/reports?r=loans-by-category">Portfolio report</More> : undefined}>
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Branch</Th>
                <Th className="text-right">Active loans</Th>
                <Th className="text-right">Principal o/s</Th>
                <Th className="text-right">Overdue</Th>
                <Th className="text-right">PAR 30</Th>
                <Th className="text-right">Collected this month</Th>
                <Th className="text-right">Efficiency</Th>
                <Th>Yesterday</Th>
              </tr>
            </thead>
            <tbody>
              {data.branches.map((b) => (
                <tr key={b.id} className="cursor-pointer hover:bg-canvas" onClick={() => onBranch(b.id)}>
                  <Td>
                    <span className="font-medium text-ink-950">{b.name}</span> <span className="text-[12px] text-subtle">{b.code}</span>
                  </Td>
                  <Td className="num text-right">{count(b.activeLoans)}</Td>
                  <Td className="num text-right">{inr(b.principalOutstanding, { decimals: false })}</Td>
                  <Td className="num text-right">{inr(b.overdue, { decimals: false })}</Td>
                  <Td className={cx('num text-right', (b.par30Pct ?? 0) > 10 && 'text-bad')}>{pct(b.par30Pct)}</Td>
                  <Td className="num text-right">{inr(b.collectedMtd, { decimals: false })}</Td>
                  <Td className="num text-right">{pct(b.efficiencyPct)}</Td>
                  <Td>{b.yesterdayClosed ? <Badge tone="ok"><Lock className="size-3" /> Closed</Badge> : <Badge tone="warn">Not closed</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </Section>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Disbursements — last 6 months" description="Principal lent per month" />
          <div className="px-5 pb-4">
            <BarChart label="Principal disbursed per month, last six months" data={data.disbursements.map((m) => ({ key: m.month, label: monthLabel(m.month), value: Number(m.amount), detail: `${count(m.loans)} loans` }))} format={rupees} axisFormat={compactInr} />
          </div>
        </Card>
        <Section title="Recovery" action={can('recovery.view') ? <More href="/recovery">Recovery</More> : undefined}>
          <RecoveryStats r={data.recovery} />
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface BranchData {
  asOf: string;
  branch: { id: string; code: string; name: string };
  portfolio: Portfolio;
  collections: Collections;
  efficiency: Efficiency;
  recovery: Recovery;
  dueToday: { n: number; amount: string };
  today: { dayStatus: string; cashCountsPending: number };
  collectors: { id: string; name: string; code: string; loans: number; overdue: string; overdue_loans: number; collected: string; payments: number; visits: number; kept: number; broken: number; open_cases: number; demand: string; efficiencyPct: number | null; promiseKeptPct: number | null }[];
}

export function BranchDashboard({ branchId, onBranch }: { branchId: string | null; onBranch: (id: string) => void }) {
  const { can } = useSession();
  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  useEffect(() => {
    get<{ data: { id: string; code: string; name: string }[] }>('/branches').then((r) => setBranches(r.data)).catch(() => undefined);
  }, []);
  const id = branchId ?? branches[0]?.id ?? null;
  const { data } = useApi<BranchData>(id ? `/dashboard/branch/${id}` : null);
  return (
    <div className="space-y-8">
      {branches.length > 1 && (
        <Field label="Branch" className="max-w-xs">
          <Select value={id ?? ''} onChange={(e) => onBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Section title={`${data.branch.name} today`} action={can('recon.view') ? <More href="/reconciliation">Day close</More> : undefined}>
            <StatGrid cols={3}>
              <Stat label="Due today" value={inr(data.dueToday.amount, { decimals: false })} hint={`${count(data.dueToday.n)} installments`} />
              <Stat label="Business day" value={data.today.dayStatus === 'CLOSED' ? 'Closed' : 'Open'} hint={data.today.dayStatus === 'CLOSED' ? 'Money can no longer be posted today' : 'Close it once cash is counted'} tone={data.today.dayStatus === 'CLOSED' ? 'ok' : undefined} />
              <Stat label="Cash counts pending" value={count(data.today.cashCountsPending)} hint="collectors with cash not yet counted" tone={data.today.cashCountsPending ? 'warn' : 'ok'} />
            </StatGrid>
          </Section>
          <Section title="Portfolio & collections">
            <PortfolioStats p={data.portfolio} c={data.collections} e={data.efficiency} />
          </Section>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <CollectionsChart c={data.collections} days={30} />
            <BucketsChart p={data.portfolio} />
          </div>
          <Section title="Collector performance this month">
            <Card>
              {data.collectors.length === 0 ? (
                <EmptyState title="No collectors in this branch" />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Collector</Th>
                      <Th className="text-right">Loans</Th>
                      <Th className="text-right">Overdue in book</Th>
                      <Th className="text-right">Collected</Th>
                      <Th className="text-right">Efficiency</Th>
                      <Th className="text-right">Visits</Th>
                      <Th className="text-right">Promises kept</Th>
                      <Th className="text-right">Recovery cases</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.collectors.map((c) => (
                      <tr key={c.id} className="hover:bg-canvas">
                        <Td>
                          <Link href={`/?collector=${c.id}`} className="font-medium text-ink-950 hover:underline">
                            {c.name}
                          </Link>
                          <span className="block text-[12px] text-subtle">{c.code}</span>
                        </Td>
                        <Td className="num text-right">{count(c.loans)}</Td>
                        <Td className="num text-right">
                          {inr(c.overdue, { decimals: false })} <span className="text-[12px] text-subtle">({c.overdue_loans})</span>
                        </Td>
                        <Td className="num text-right">
                          {inr(c.collected, { decimals: false })} <span className="text-[12px] text-subtle">({c.payments})</span>
                        </Td>
                        <Td className="num text-right">{pct(c.efficiencyPct)}</Td>
                        <Td className="num text-right">{count(c.visits)}</Td>
                        <Td className="num text-right">{c.promiseKeptPct === null ? '—' : `${c.promiseKeptPct}% (${c.kept}/${c.kept + c.broken})`}</Td>
                        <Td className="num text-right">{count(c.open_cases)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="border-t border-line px-5 py-2 text-[12px] text-subtle">Efficiency: of the installments in each collector’s book that fell due this month, the share collected. Same figures as the Collection efficiency report.</p>
            </Card>
          </Section>
          {can('recovery.view') && (
            <Section title="Recovery" action={<More href="/recovery">Recovery</More>}>
              <RecoveryStats r={data.recovery} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface CollectorData {
  asOf: string;
  employee: { id: string; name: string; code: string };
  book: Portfolio;
  collections: Collections;
  efficiency: Efficiency;
  toCollect: { installments: number; amount: string };
  visitsMtd: number;
  promises: { open: number; dueNow: number };
  recoveryCases: number;
}

export function CollectorDashboard({ employeeId, self }: { employeeId: string; self: boolean }) {
  const { data } = useApi<CollectorData>(`/dashboard/collector/${employeeId}`);
  if (!data) return <Spinner />;
  return (
    <div className="space-y-8">
      {!self && <p className="text-[13px] text-muted">Dashboard of {data.employee.name} ({data.employee.code})</p>}
      <Section title="Today" action={self ? <More href="/collect">Start collecting</More> : undefined}>
        <StatGrid>
          <Stat label="To collect" value={inr(data.toCollect.amount, { decimals: false })} hint={`${count(data.toCollect.installments)} installments due or overdue`} tone={data.toCollect.installments ? 'warn' : 'ok'} />
          <Stat label="Collected today" value={inr(data.collections.today, { decimals: false })} hint={`${count(data.collections.todayCount)} payments`} />
          <Stat label="Promises due" value={count(data.promises.dueNow)} hint={`${count(data.promises.open)} open promises`} tone={data.promises.dueNow ? 'warn' : undefined} />
          <Stat label="Recovery cases" value={count(data.recoveryCases)} hint="you own" />
        </StatGrid>
      </Section>
      <Section title="This month">
        <StatGrid>
          <Stat label="Collected" value={inr(data.collections.mtd, { decimals: false })} hint={`${count(data.collections.mtdCount)} payments`} />
          <Stat label="Efficiency" value={pct(data.efficiency.pct)} hint={`${inr(data.efficiency.collected, { decimals: false })} of ${inr(data.efficiency.demand, { decimals: false })} due`} />
          <Stat label="Visits" value={count(data.visitsMtd)} />
          <Stat label="My book" value={inr(data.book.principalOutstanding, { decimals: false })} hint={`${count(data.book.activeLoans)} loans · ${count(data.book.overdueLoans)} overdue`} />
        </StatGrid>
      </Section>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <CollectionsChart c={data.collections} days={14} />
        <BucketsChart p={data.book} />
      </div>
      {self && (
        <p className="flex items-center gap-2 text-[12px] text-subtle">
          <CheckCircle2 className="size-3.5" /> Figures update as you record payments and visits.
        </p>
      )}
    </div>
  );
}
