'use client';

import { FileSpreadsheet, Lock, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { plusDays, todayIST } from '@/components/lending';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

type Tab = 'day' | 'cash' | 'tb' | 'pl' | 'bs' | 'periods';
interface Line { id: string; code: string; name: string; amount: string }

function fyStart(d: string) {
  const y = Number(d.slice(0, 4));
  return Number(d.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
}

function Excel({ path }: { path: string }) {
  return (
    <a href={`/api/v1${path}${path.includes('?') ? '&' : '?'}format=xlsx`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-canvas">
      <FileSpreadsheet className="size-3.5" /> Excel
    </a>
  );
}

export default function BooksPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('tb');
  const today = todayIST();
  const [from, setFrom] = useState(fyStart(today));
  const [to, setTo] = useState(today);
  if (!can('ledger.view')) return <EmptyState title="You don’t have access to the books" />;
  const range = tab === 'cash' || tab === 'pl';
  return (
    <>
      <PageHeader title="Books" subtitle="Built only from the journal — what the auditor sees" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'tb', label: 'Trial balance' },
          { id: 'pl', label: 'Profit & loss' },
          { id: 'bs', label: 'Balance sheet' },
          { id: 'cash', label: 'Cash & bank book' },
          { id: 'day', label: 'Day book' },
          { id: 'periods', label: 'Month locks' },
        ]}
      />
      {tab !== 'periods' && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {range && (
            <Field label="From">
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
          )}
          <Field label={tab === 'day' ? 'Date' : range ? 'To' : 'As of'}>
            <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {range && (
            <div className="flex gap-2 pb-0.5 text-[12px]">
              {[
                ['This FY', fyStart(today), today],
                ['This month', `${today.slice(0, 8)}01`, today],
                ['Last 7 days', plusDays(today, -6), today],
              ].map(([l, f, t]) => (
                <button
                  key={l}
                  onClick={() => {
                    setFrom(f!);
                    setTo(t!);
                  }}
                  className="rounded-full border border-line px-3 py-1 hover:bg-canvas"
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-5">
        {tab === 'tb' && <TrialBalance asOf={to} />}
        {tab === 'pl' && <ProfitLoss from={from} to={to} />}
        {tab === 'bs' && <BalanceSheet asOf={to} />}
        {tab === 'cash' && <CashBook from={from} to={to} />}
        {tab === 'day' && <DayBook day={to} />}
        {tab === 'periods' && <Periods />}
      </div>
    </>
  );
}

function TrialBalance({ asOf }: { asOf: string }) {
  const path = `/books/trial-balance${qs({ asOf })}`;
  const { data } = useApi<{ data: { id: string; code: string; name: string; type: string; debit: string; credit: string }[]; totals: { debit: string; credit: string; balanced: boolean } }>(path);
  if (!data) return <Spinner />;
  return (
    <Card>
      <CardHeader title={`Trial balance as of ${date(asOf)}`} description={data.totals.balanced ? 'Debits equal credits.' : undefined} actions={<Excel path={path} />} />
      {!data.totals.balanced && (
        <div className="p-4">
          <Alert>Debits and credits differ. This should never happen — the database checks every entry. Contact support.</Alert>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th className="text-right">Debit</Th>
            <Th className="text-right">Credit</Th>
          </tr>
        </thead>
        <tbody>
          {data.data.map((r) => (
            <tr key={r.id}>
              <Td>
                <span className="num font-mono text-[12px] text-muted">{r.code}</span> {r.name}
              </Td>
              <Td className="num text-right">{Number(r.debit) ? inr(r.debit) : ''}</Td>
              <Td className="num text-right">{Number(r.credit) ? inr(r.credit) : ''}</Td>
            </tr>
          ))}
          <tr className="font-semibold">
            <Td>Total</Td>
            <Td className="num text-right">{inr(data.totals.debit)}</Td>
            <Td className="num text-right">{inr(data.totals.credit)}</Td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

function Section({ title, lines, total, totalLabel }: { title: string; lines: Line[]; total: string; totalLabel: string }) {
  return (
    <>
      <tr>
        <Td className="bg-canvas text-[12px] font-semibold uppercase tracking-wide text-muted" colSpan={2}>
          {title}
        </Td>
      </tr>
      {lines.map((l) => (
        <tr key={l.id}>
          <Td>
            <span className="num font-mono text-[12px] text-muted">{l.code}</span> {l.name}
          </Td>
          <Td className="num text-right">{inr(l.amount)}</Td>
        </tr>
      ))}
      <tr className="font-semibold">
        <Td>{totalLabel}</Td>
        <Td className="num text-right">{inr(total)}</Td>
      </tr>
    </>
  );
}

function ProfitLoss({ from, to }: { from: string; to: string }) {
  const path = `/books/profit-loss${qs({ from, to })}`;
  const { data } = useApi<{ income: Line[]; expenses: Line[]; totals: { income: string; expenses: string; net: string } }>(path);
  if (!data) return <Spinner />;
  const profit = Number(data.totals.net) >= 0;
  return (
    <Card>
      <CardHeader title={`Profit & loss · ${date(from)} – ${date(to)}`} description="Accrual basis (interest recognised when it falls due) ⚖" actions={<Excel path={path} />} />
      <Table>
        <tbody>
          <Section title="Income" lines={data.income} total={data.totals.income} totalLabel="Total income" />
          <Section title="Expenses" lines={data.expenses} total={data.totals.expenses} totalLabel="Total expenses" />
          <tr className="text-base font-semibold">
            <Td>{profit ? 'Net profit' : 'Net loss'}</Td>
            <Td className={`num text-right ${profit ? 'text-ok' : 'text-bad'}`}>{inr(data.totals.net)}</Td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

function BalanceSheet({ asOf }: { asOf: string }) {
  const path = `/books/balance-sheet${qs({ asOf })}`;
  const { data } = useApi<{ assets: Line[]; liabilities: Line[]; equity: Line[]; profit: string; totals: { assets: string; liabilities: string; equity: string; liabilitiesAndEquity: string; balanced: boolean } }>(path);
  if (!data) return <Spinner />;
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader title={`Assets · ${date(asOf)}`} actions={<Excel path={path} />} />
        <Table>
          <tbody>
            <Section title="Assets" lines={data.assets} total={data.totals.assets} totalLabel="Total assets" />
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Liabilities & equity" description={data.totals.balanced ? 'Balances with total assets.' : undefined} />
        <Table>
          <tbody>
            <Section title="Liabilities" lines={data.liabilities} total={data.totals.liabilities} totalLabel="Total liabilities" />
            <Section title="Equity" lines={[...data.equity, { id: 'p', code: '', name: 'Profit not yet closed to reserves ⚖', amount: data.profit }]} total={data.totals.liabilitiesAndEquity} totalLabel="Total liabilities & equity" />
          </tbody>
        </Table>
        {!data.totals.balanced && (
          <div className="p-4">
            <Alert>The balance sheet does not balance. Contact support.</Alert>
          </div>
        )}
      </Card>
    </div>
  );
}

function CashBook({ from, to }: { from: string; to: string }) {
  const path = `/books/summary${qs({ from, to })}`;
  const { data } = useApi<{ data: { id: string; code: string; name: string; subtype: string; opening: string; receipts: string; payments: string; closing: string }[]; totals: Record<string, string> }>(path);
  if (!data) return <Spinner />;
  return (
    <Card>
      <CardHeader title="Cash & bank book" description="Opening + receipts − payments = closing, for every cash, collector, UPI, cheque and bank account." actions={<Excel path={path} />} />
      <Table>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th className="text-right">Opening</Th>
            <Th className="text-right">Receipts</Th>
            <Th className="text-right">Payments</Th>
            <Th className="text-right">Closing</Th>
          </tr>
        </thead>
        <tbody>
          {data.data.map((a) => (
            <tr key={a.id}>
              <Td>
                <span className="num font-mono text-[12px] text-muted">{a.code}</span> {a.name}
              </Td>
              <Td className="num text-right">{inr(a.opening)}</Td>
              <Td className="num text-right">{inr(a.receipts)}</Td>
              <Td className="num text-right">{inr(a.payments)}</Td>
              <Td className="num text-right font-medium">{inr(a.closing)}</Td>
            </tr>
          ))}
          <tr className="font-semibold">
            <Td>Total</Td>
            <Td className="num text-right">{inr(data.totals.opening)}</Td>
            <Td className="num text-right">{inr(data.totals.receipts)}</Td>
            <Td className="num text-right">{inr(data.totals.payments)}</Td>
            <Td className="num text-right">{inr(data.totals.closing)}</Td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

function DayBook({ day }: { day: string }) {
  const path = `/books/day${qs({ date: day })}`;
  const { data } = useApi<{ total: string; entries: { id: string; entry_no: string; entry_type: string; narration: string; branch_code: string | null; lines: { line_no: number; code: string; name: string; debit: string; credit: string; memo: string | null }[] }[] }>(path);
  if (!data) return <Spinner />;
  return (
    <Card>
      <CardHeader title={`Day book · ${date(day)}`} description={`${data.entries.length} entries · ${inr(data.total)}`} actions={<Excel path={path} />} />
      {data.entries.length === 0 ? (
        <EmptyState title="No entries on this day" />
      ) : (
        data.entries.map((e) => (
          <div key={e.id} className="border-b border-line last:border-0">
            <p className="px-5 pt-3 text-[13px] font-medium">
              <span className="num font-mono">{e.entry_no}</span> · <Badge>{titleCase(e.entry_type)}</Badge> {e.narration}
            </p>
            <table className="mb-3 mt-1 w-full text-[12px]">
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td className="px-5 py-0.5">
                      <span className="num font-mono text-muted">{l.code}</span> {l.name}
                    </td>
                    <td className="num w-36 text-right">{Number(l.debit) ? inr(l.debit) : ''}</td>
                    <td className="num w-36 pr-5 text-right">{Number(l.credit) ? inr(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </Card>
  );
}

interface Period { month: string; status: string; entries: number; current: boolean; soft_locked_by?: string | null; soft_locked_at?: string | null; locked_by?: string | null; locked_at?: string | null; unlocked_by?: string | null; unlocked_at?: string | null; unlock_reason?: string | null }

function Periods() {
  const { can } = useSession();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data, reload } = useApi<{ data: Period[] }>('/periods');
  const [reopen, setReopen] = useState<string | null>(null);
  const [act, busy] = useSubmit(async (month: string, kind: 'soft-lock' | 'lock') => {
    try {
      await api('POST', `/periods/${month}/${kind}`);
      toast('ok', `${month} ${kind === 'lock' ? 'locked' : 'closed for new entries'}`);
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  if (!data) return <Spinner />;
  const label = (m: string) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${m}-01T00:00:00Z`));
  return (
    <Card>
      <CardHeader title="Month locks" description="Soft-lock (accountant): only adjustments and reversals. Lock (management): nothing. Reopening needs a reason and is audited." />
      <Table>
        <thead>
          <tr>
            <Th>Month</Th>
            <Th className="text-right">Entries</Th>
            <Th>Status</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {data.data.map((p) => (
            <tr key={p.month}>
              <Td className="font-medium">{label(p.month)}</Td>
              <Td className="num text-right">{p.entries}</Td>
              <Td className="text-[12px]">
                <Badge tone={p.status === 'LOCKED' ? 'bad' : p.status === 'SOFT_LOCKED' ? 'warn' : 'ok'}>{p.status === 'SOFT_LOCKED' ? 'Soft-locked' : titleCase(p.status)}</Badge>
                <p className="mt-0.5 text-muted">
                  {p.status === 'LOCKED' && p.locked_by && `by ${p.locked_by} · ${dateTime(p.locked_at)}`}
                  {p.status === 'SOFT_LOCKED' && p.soft_locked_by && `by ${p.soft_locked_by} · ${dateTime(p.soft_locked_at)}`}
                  {p.status === 'OPEN' && p.unlocked_by && `reopened by ${p.unlocked_by}: ${p.unlock_reason}`}
                  {p.current && 'current month'}
                </p>
              </Td>
              <Td className="whitespace-nowrap text-right">
                {!p.current && p.status === 'OPEN' && can('period.soft_lock') && (
                  <Button size="sm" variant="secondary" onClick={() => act(p.month, 'soft-lock')} loading={busy}>
                    Soft-lock
                  </Button>
                )}
                {!p.current && p.status !== 'LOCKED' && can('period.lock') && (
                  <Button size="sm" variant="secondary" onClick={() => act(p.month, 'lock')} loading={busy}>
                    <Lock className="size-3.5" /> Lock
                  </Button>
                )}
                {p.status !== 'OPEN' && can('period.unlock') && (
                  <Button size="sm" variant="ghost" onClick={() => setReopen(p.month)}>
                    <LockOpen className="size-3.5" /> Reopen
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {reopen && (
        <ReopenDialog
          month={reopen}
          onClose={() => setReopen(null)}
          onSubmit={async (reason) => {
            await withStepUp(() => api('POST', `/periods/${reopen}/reopen`, { body: { reason } }));
            toast('ok', `${reopen} reopened`);
            setReopen(null);
            reload();
          }}
        />
      )}
    </Card>
  );
}

function ReopenDialog({ month, onClose, onSubmit }: { month: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await onSubmit(reason);
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reopen ${month}`}
      description="Entries can then be posted into this month again. The reason is kept in the audit log."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant="danger" onClick={() => go()} loading={busy}>
            Reopen month
          </Button>
        </>
      }
    >
      {error && <Alert>{error.fieldErrors().reason ?? error.message}</Alert>}
      <Field label="Reason" required hint="At least 10 characters">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}
