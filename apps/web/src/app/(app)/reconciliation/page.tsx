'use client';

import { CheckCircle2, Lock, LockOpen, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { todayIST } from '@/components/lending';
import { SETTLEMENT_LABEL, SETTLEMENT_TONE, SettlementDialog } from '@/components/reconciliation';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, cx, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, get, qs } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

type Tab = 'day' | 'board' | 'statements' | 'bank' | 'unconfirmed';

export default function ReconciliationPage() {
  const { can, me } = useSession();
  const [tab, setTab] = useState<Tab>('day');
  const [branchId, setBranchId] = useState('');
  const [day, setDay] = useState(todayIST());
  const branches = useApi<{ data: { id: string; code: string; name: string }[] }>(me?.scope === 'ALL' ? '/branches' : null);
  const options = me?.scope === 'ALL' ? (branches.data?.data ?? []) : (me?.branches ?? []);
  useEffect(() => {
    if (!branchId && options[0]) setBranchId(options[0].id);
  }, [branchId, options]);
  if (!can('recon.view')) return <EmptyState title="You don’t have access to reconciliation" />;
  return (
    <>
      <PageHeader title="Reconciliation" subtitle="Every day, prove that what was collected is where the books say it is" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'day', label: 'Day close' },
          { id: 'board', label: 'Board' },
          { id: 'statements', label: 'Bank & UPI statements' },
          { id: 'bank', label: 'Bank reconciliation' },
          { id: 'unconfirmed', label: 'Not yet in bank' },
        ]}
      />
      {(tab === 'day' || tab === 'board') && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Branch">
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {options.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tab === 'board' ? 'Week ending' : 'Business date'}>
            <Input type="date" value={day} max={todayIST()} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="mt-5">
        {tab === 'day' && branchId && <DayClose branchId={branchId} day={day} />}
        {tab === 'board' && branchId && (
          <Board
            branchId={branchId}
            to={day}
            onOpen={(d) => {
              setDay(d);
              setTab('day');
            }}
          />
        )}
        {tab === 'statements' && <Statements />}
        {tab === 'bank' && <BankRecon />}
        {tab === 'unconfirmed' && <Unconfirmed />}
      </div>
    </>
  );
}

interface DayView {
  branch: { id: string; code: string; name: string };
  date: string;
  status: string;
  day: { closed_by_name: string | null; closed_at: string | null; reopen_requested_by_name: string | null; reopen_reason: string | null; reopen_requested_by: string | null } | null;
  employees: { employee: { id: string; name: string; code: string }; figures: { opening: string; collected: string; deposited: string; expenses: string; expected: string }; collections: { total: string; upi: { count: number; matched: number }; bank: { count: number; matched: number }; cheque: { count: number } }; settlement: { counted_cash: string | null; difference: string | null } | null; status: string; stale: boolean }[];
  blockers: string[];
  pending: { id: string; payment_no: string; amount: string; method: string; reference_no: string | null; business_date: string; loan_no: string; ageDays: number }[];
  canClose: boolean;
}

function DayClose({ branchId, day }: { branchId: string; day: string }) {
  const { can, me } = useSession();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data, loading, reload } = useApi<DayView>(`/reconciliation/days/${branchId}/${day}`);
  const [open, setOpen] = useState<string | null>(null);
  const [reopen, setReopen] = useState(false);
  const [close, closing] = useSubmit(async () => {
    try {
      await api('POST', `/reconciliation/days/${branchId}/${day}/close`);
      toast('ok', `${date(day)} closed`);
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  const [approveReopen, approving] = useSubmit(async () => {
    try {
      await withStepUp(() => api('POST', `/reconciliation/days/${branchId}/${day}/reopen`));
      toast('ok', 'Day reopened');
      reload();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  });
  if (loading && !data) return <Spinner />;
  if (!data) return null;
  const closed = data.status === 'CLOSED';
  const total = data.employees.reduce((s, e) => s + Number(e.collections.total), 0);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              {data.branch.name} · {date(data.date)} <Badge tone={closed ? 'ok' : 'warn'}>{closed ? 'Closed' : 'Open'}</Badge>
            </span>
          }
          description={closed ? `Closed by ${data.day?.closed_by_name} · ${dateTime(data.day?.closed_at)}. Money can no longer be posted to this day.` : `Collected ${inr(total.toFixed(2))}. Close the day once every employee's cash is counted and reconciled.`}
          actions={
            closed ? (
              data.day?.reopen_requested_by ? (
                can('day.reopen') && data.day.reopen_requested_by !== me?.id ? (
                  <Button variant="secondary" onClick={() => approveReopen()} loading={approving}>
                    <LockOpen className="size-4" /> Approve reopen
                  </Button>
                ) : (
                  <Badge tone="warn">Reopen requested</Badge>
                )
              ) : (
                can('day.close') && (
                  <Button variant="ghost" onClick={() => setReopen(true)}>
                    Ask to reopen
                  </Button>
                )
              )
            ) : (
              can('day.close') && (
                <Button onClick={() => close()} loading={closing} disabled={!data.canClose}>
                  <Lock className="size-4" /> Close day
                </Button>
              )
            )
          }
        />
        {data.day?.reopen_requested_by && closed && (
          <p className="border-b border-line px-5 py-2 text-[13px] text-warn">
            {data.day.reopen_requested_by_name} asked to reopen: “{data.day.reopen_reason}”. Someone else with approval rights must approve.
          </p>
        )}
        {!closed && data.blockers.length > 0 && (
          <div className="border-b border-line px-5 py-3">
            <Alert tone="warn">
              <p className="font-medium">Before the day can close:</p>
              <ul className="mt-1 list-disc pl-5">
                {data.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Alert>
          </div>
        )}
        {data.employees.length === 0 ? (
          <EmptyState title="No collectors in this branch" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Opening</Th>
                <Th className="text-right">Collected (cash)</Th>
                <Th className="text-right">Deposited</Th>
                <Th className="text-right">Expenses</Th>
                <Th className="text-right">Expected</Th>
                <Th className="text-right">Counted</Th>
                <Th>Status</Th>
                <Th>UPI · bank</Th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => (
                <tr key={e.employee.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(e.employee.id)}>
                  <Td>
                    <span className="font-medium">{e.employee.name}</span>
                    <span className="block text-[12px] text-muted">{e.employee.code}</span>
                  </Td>
                  <Td className="num text-right">{inr(e.figures.opening)}</Td>
                  <Td className="num text-right">{inr(e.figures.collected)}</Td>
                  <Td className="num text-right">{inr(e.figures.deposited)}</Td>
                  <Td className="num text-right">{inr(e.figures.expenses)}</Td>
                  <Td className="num text-right font-semibold">{inr(e.figures.expected)}</Td>
                  <Td className="num text-right">{e.settlement?.counted_cash ? inr(e.settlement.counted_cash) : '—'}</Td>
                  <Td>
                    <Badge tone={e.stale ? 'warn' : SETTLEMENT_TONE[e.status]}>{e.stale ? 'Count again' : (SETTLEMENT_LABEL[e.status] ?? e.status)}</Badge>
                    {e.settlement?.difference && Number(e.settlement.difference) !== 0 && <span className="num ml-1 text-[12px] text-bad">{inr(e.settlement.difference.replace('-', ''))}</span>}
                  </Td>
                  <Td className="text-[12px] text-muted">
                    {e.collections.upi.count + e.collections.bank.count ? `${e.collections.upi.matched + e.collections.bank.matched}/${e.collections.upi.count + e.collections.bank.count} in bank` : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="In transit" description="UPI, bank transfers and cheques not yet confirmed by a bank statement. They don’t block the close; they carry to the next day." />
        {data.pending.length === 0 ? (
          <p className="flex items-center gap-2 px-5 py-4 text-[13px] text-ok">
            <CheckCircle2 className="size-4" /> Everything is confirmed by the bank.
          </p>
        ) : (
          <Table>
            <tbody>
              {data.pending.map((p) => (
                <tr key={p.id}>
                  <Td className="num whitespace-nowrap">{date(p.business_date)}</Td>
                  <Td>
                    <Link href={`/payments/${p.id}`} className="num font-mono text-[12px] hover:underline">
                      {p.payment_no}
                    </Link>{' '}
                    · {p.loan_no}
                  </Td>
                  <Td className="text-[12px]">
                    {titleCase(p.method)} {p.reference_no}
                  </Td>
                  <Td className="num text-right">{inr(p.amount)}</Td>
                  <Td className={cx('text-[12px]', p.ageDays > 3 ? 'text-bad' : 'text-muted')}>{p.ageDays ? `${p.ageDays} days` : 'today'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open && <SettlementDialog employeeId={open} day={day} onClose={() => setOpen(null)} onChanged={reload} />}
      {reopen && (
        <ReasonDialog
          title={`Ask to reopen ${date(day)}`}
          description="Someone else with approval rights must approve. The reason goes in the audit log."
          action="Send request"
          onClose={() => setReopen(false)}
          onSubmit={async (reason) => {
            await api('POST', `/reconciliation/days/${branchId}/${day}/reopen-request`, { body: { reason } });
            toast('ok', 'Reopen requested');
            setReopen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ReasonDialog({ title, description, action, onClose, onSubmit }: { title: string; description: string; action: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await onSubmit(reason);
    } catch (e) {
      setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button onClick={() => go()} loading={busy}>
            {action}
          </Button>
        </>
      }
    >
      {error && <Alert>{error.fieldErrors().reason ?? error.message}</Alert>}
      <Field label="Reason" required>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

interface BoardData {
  days: string[];
  branches: { branch: { code: string; name: string }; days: { date: string; status: string; reopenRequested: boolean }[]; employees: { id: string; name: string; cells: { date: string; state: string; difference: string | null }[] }[] }[];
}
const CELL: Record<string, string> = { RECONCILED: 'bg-ok-soft text-ok', PENDING: 'bg-warn-soft text-warn', DIFFERENCE: 'bg-bad-soft text-bad', NONE: 'bg-canvas text-subtle' };

function Board({ branchId, to, onOpen }: { branchId: string; to: string; onOpen: (d: string) => void }) {
  const { data } = useApi<BoardData>(`/reconciliation/board${qs({ branchId, to })}`);
  if (!data) return <Spinner />;
  const short = (d: string) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  return (
    <div className="space-y-6">
      {data.branches.map((b) => (
        <Card key={b.branch.code}>
          <CardHeader title={b.branch.name} description="🟢 reconciled · 🟠 pending · 🔴 difference not yet approved. Click a day to open it." />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-surface px-4 py-2 text-left font-semibold text-muted">Employee</th>
                  {b.days.map((d) => (
                    <th key={d.date} className="px-2 py-2 text-center font-medium text-muted">
                      <button onClick={() => onOpen(d.date)} className="hover:underline">
                        {short(d.date)}
                      </button>
                      <span className="block">{d.status === 'CLOSED' ? <Lock className="mx-auto size-3 text-ok" aria-label="Closed" /> : <span className="text-subtle">open</span>}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.employees.map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="sticky left-0 bg-surface px-4 py-2 font-medium">{e.name}</td>
                    {e.cells.map((c) => (
                      <td key={c.date} className="px-1 py-1">
                        <button onClick={() => onOpen(c.date)} className={cx('num block w-full rounded px-1 py-1.5 text-center', CELL[c.state])} title={c.state.toLowerCase()}>
                          {c.state === 'DIFFERENCE' && c.difference ? inr(c.difference.replace('-', ''), { decimals: false }) : c.state === 'RECONCILED' ? '✓' : c.state === 'PENDING' ? '•' : ''}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

interface BankAcct { id: string; name: string; subtype: string; account_no_last4: string | null }
interface StmtLine { id: string; txn_date: string; description: string; reference: string | null; utr: string | null; debit: string; credit: string; balance: string | null; match_status: string; ignore_reason: string | null; account_name: string; matches: { id: string; target_type: string; status: string; confidence: string; method: string }[] }

function useBanks() {
  const [banks, setBanks] = useState<BankAcct[]>([]);
  useEffect(() => {
    get<{ data: BankAcct[] }>('/banking/accounts').then((r) => setBanks(r.data.filter((a) => a.subtype === 'BANK'))).catch(() => undefined);
  }, []);
  return banks;
}

function Statements() {
  const { can } = useSession();
  const banks = useBanks();
  const [status, setStatus] = useState('UNMATCHED');
  const [importing, setImporting] = useState(false);
  const { data, reload } = useApi<{ data: StmtLine[] }>(`/reconciliation/statements/lines${qs({ status })}`);
  const [pick, setPick] = useState<StmtLine | null>(null);
  const toast = useToast();
  const [run, running] = useSubmit(async () => {
    const r = await api<{ suggested: number; autoConfirmed: number }>('POST', '/reconciliation/statements/match', { body: {} });
    toast('ok', `${r.autoConfirmed} matched automatically, ${r.suggested - r.autoConfirmed} suggestions to review`);
    reload();
  });
  return (
    <Card>
      <CardHeader
        title="Statement lines"
        description="Only an exact UTR / reference + amount match is confirmed automatically. Everything else is a suggestion for a person to confirm."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-auto text-[13px]" aria-label="Status">
              <option value="UNMATCHED">Unmatched</option>
              <option value="SUGGESTED">Suggested</option>
              <option value="MATCHED">Matched</option>
              <option value="IGNORED">Explained</option>
              <option value="">All</option>
            </Select>
            {can('recon.match') && (
              <Button size="sm" variant="secondary" onClick={() => run()} loading={running}>
                Run matching
              </Button>
            )}
            {can('statement.import') && (
              <Button size="sm" onClick={() => setImporting(true)}>
                <Upload className="size-3.5" /> Import statement
              </Button>
            )}
          </>
        }
      />
      {!data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <EmptyState title={status === 'UNMATCHED' ? 'Nothing unmatched' : 'No lines'} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Narration</Th>
              <Th className="text-right">Debit</Th>
              <Th className="text-right">Credit</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((l) => (
              <tr key={l.id}>
                <Td className="num whitespace-nowrap">{date(l.txn_date)}</Td>
                <Td className="max-w-md text-[12px]">
                  {l.description}
                  {l.utr && <span className="num block font-mono text-muted">UTR {l.utr}</span>}
                  {l.ignore_reason && <span className="block text-muted">Explained: {l.ignore_reason}</span>}
                </Td>
                <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
                <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
                <Td>
                  <Badge tone={l.match_status === 'MATCHED' ? 'ok' : l.match_status === 'SUGGESTED' ? 'info' : l.match_status === 'IGNORED' ? 'neutral' : 'warn'}>{l.match_status === 'IGNORED' ? 'Explained' : titleCase(l.match_status)}</Badge>
                  {l.matches.find((m) => m.status === 'CONFIRMED') && <span className="block text-[11px] text-muted">{titleCase(l.matches.find((m) => m.status === 'CONFIRMED')!.target_type)}</span>}
                </Td>
                <Td className="text-right">
                  {can('recon.match') && (
                    <Button size="sm" variant="ghost" onClick={() => setPick(l)}>
                      {l.match_status === 'MATCHED' ? 'Details' : 'Resolve'}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {importing && (
        <ImportDialog
          banks={banks}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            reload();
          }}
        />
      )}
      {pick && <LineDialog line={pick} onClose={() => setPick(null)} onDone={reload} />}
    </Card>
  );
}

const PRESETS: Record<string, { label: string; mapping: Record<string, string> }> = {
  generic: { label: 'Date, Narration, Ref, Debit, Credit, Balance', mapping: { date: '0', description: '1', reference: '2', debit: '3', credit: '4', balance: '5', skipRows: '0', dateFormat: 'DD/MM/YYYY' } },
  sbi: { label: 'SBI: Txn Date, Value Date, Description, Ref No, Debit, Credit, Balance', mapping: { date: '0', description: '2', reference: '3', debit: '4', credit: '5', balance: '6', skipRows: '0', dateFormat: 'DD MMM YYYY' } },
  hdfc: { label: 'HDFC: Date, Narration, Chq/Ref, Value Dt, Withdrawal, Deposit, Closing', mapping: { date: '0', description: '1', reference: '2', debit: '4', credit: '5', balance: '6', skipRows: '0', dateFormat: 'DD/MM/YYYY' } },
};

function ImportDialog({ banks, onClose, onDone }: { banks: BankAcct[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [accountId, setAccountId] = useState(banks[0]?.id ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState(PRESETS.generic!.mapping);
  const [preview, setPreview] = useState<{ header: string[]; total: number; new: number; duplicate: number; invalid: { row: number; error: string }[]; rows: { row: number; txnDate: string; description: string; debit: string; credit: string; status: string }[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const form = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append('accountId', accountId);
    for (const [k, v] of Object.entries({ ...mapping, ...extra })) if (v !== '') fd.append(k, v);
    fd.append('file', file!);
    return fd;
  };
  const [doPreview, previewing] = useSubmit(async () => {
    setError(null);
    try {
      setPreview(await api('POST', '/reconciliation/statements/preview', { body: form() }));
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const [doImport, importing] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ new: number; duplicate: number; invalid: number; matching: { autoConfirmed: number; suggested: number } }>('POST', '/reconciliation/statements', { body: form(preview?.invalid.length ? { acceptInvalid: 'true' } : {}) });
      toast('ok', `${r.new} new lines (${r.duplicate} already imported). ${r.matching.autoConfirmed} matched, ${r.matching.suggested - r.matching.autoConfirmed} to review.`);
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
      title="Import bank / UPI statement"
      description="CSV or Excel. Importing the same file again adds nothing."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => doPreview()} loading={previewing} disabled={!file || !accountId}>
            Preview
          </Button>
          <Button onClick={() => doImport()} loading={importing} disabled={!preview || preview.new === 0}>
            Import {preview?.new ?? ''} lines
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Bank account">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="File">
            <Input
              type="file"
              accept=".csv,.xlsx,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </Field>
          <Field label="Layout" className="sm:col-span-2">
            <Select
              onChange={(e) => {
                setMapping(PRESETS[e.target.value]!.mapping);
                setPreview(null);
              }}
            >
              {Object.entries(PRESETS).map(([k, p]) => (
                <option key={k} value={k}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <details className="rounded-md border border-line p-3 text-[13px]">
          <summary className="cursor-pointer font-medium">Column mapping (0 = first column)</summary>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {(['date', 'description', 'reference', 'debit', 'credit', 'balance', 'skipRows'] as const).map((k) => (
              <Field key={k} label={k === 'skipRows' ? 'Rows before header' : titleCase(k)}>
                <Input value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })} className="num" />
              </Field>
            ))}
            <Field label="Date format">
              <Select value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value })}>
                {['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'DD MMM YYYY'].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
          </div>
        </details>
        {preview && (
          <>
            <p className="text-[13px]">
              {preview.total} rows: <strong>{preview.new} new</strong>, {preview.duplicate} already imported, <span className={preview.invalid.length ? 'text-bad' : ''}>{preview.invalid.length} unreadable</span>
            </p>
            {preview.invalid.length > 0 && (
              <Alert tone="warn">
                These rows will NOT be imported — fix the file if they matter:
                <ul className="mt-1 list-disc pl-5">
                  {preview.invalid.slice(0, 8).map((r) => (
                    <li key={r.row}>
                      Row {r.row}: {r.error}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <div className="max-h-64 overflow-y-auto rounded-md border border-line">
              <Table>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className={r.status === 'DUPLICATE' ? 'text-subtle' : ''}>
                      <Td className="num">{date(r.txnDate)}</Td>
                      <Td className="text-[12px]">{r.description}</Td>
                      <Td className="num text-right">{Number(r.debit) ? `−${inr(r.debit)}` : inr(r.credit)}</Td>
                      <Td className="text-[11px]">{r.status === 'DUPLICATE' ? 'already imported' : 'new'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function LineDialog({ line, onClose, onDone }: { line: StmtLine; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data } = useApi<{ candidates: { type: string; id: string; label: string; date: string; amount: string; confidence: number }[] }>(line.match_status === 'MATCHED' || line.match_status === 'IGNORED' ? null : `/reconciliation/statements/lines/${line.id}/candidates`);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const suggestion = line.matches.find((m) => m.status === 'SUGGESTED');
  const confirmed = line.matches.find((m) => m.status === 'CONFIRMED');
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      toast('ok', msg);
      onClose();
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  const [run, busy] = useSubmit(act);
  const amount = Number(line.credit) ? `${inr(line.credit)} received` : `${inr(line.debit)} paid out`;
  return (
    <Dialog open wide onClose={onClose} title={`${date(line.txn_date)} · ${amount}`} description={line.description}>
      <div className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        {confirmed ? (
          <>
            <p className="text-[13px]">
              Matched to a {titleCase(confirmed.target_type).toLowerCase()} ({confirmed.method === 'MANUAL' ? 'by hand' : 'automatically'}).
            </p>
            <Field label="Reason to undo">
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex justify-end">
              <Button variant="danger" loading={busy} onClick={() => run(() => api('POST', `/reconciliation/matches/${confirmed.id}/undo`, { body: { reason } }), 'Match undone')}>
                Undo match
              </Button>
            </div>
          </>
        ) : (
          <>
            {suggestion && (
              <div className="flex items-center justify-between rounded-md border border-info/30 bg-info-soft p-3 text-[13px]">
                <span>Suggested match (amount and date) — confirm only if it is the same money.</span>
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => run(() => api('POST', `/reconciliation/matches/${suggestion.id}/reject`), 'Suggestion rejected')}>
                    Not this
                  </Button>
                  <Button size="sm" onClick={() => run(() => api('POST', `/reconciliation/matches/${suggestion.id}/confirm`), 'Matched')}>
                    Confirm
                  </Button>
                </span>
              </div>
            )}
            <div>
              <p className="mb-2 text-[13px] font-medium">Items in the books with this amount and date</p>
              {!data ? (
                <Spinner />
              ) : data.candidates.length === 0 ? (
                <p className="text-[13px] text-muted">Nothing in the books matches. {Number(line.credit) ? 'If it’s a customer payment, record it on the loan with the UTR, then run matching — or hold it in suspense.' : 'Explain it below.'}</p>
              ) : (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {data.candidates.map((c) => (
                    <li key={c.type + c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                      <span>
                        {c.label} <span className="text-muted">· {date(c.date)}</span>
                      </span>
                      <Button size="sm" variant="secondary" onClick={() => run(() => api('POST', `/reconciliation/statements/lines/${line.id}/match`, { body: { type: c.type, targetId: c.id } }), 'Matched')}>
                        Match
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Field label="Or explain / hold" hint="Required for either action below">
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bank SMS charges for September" />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              {Number(line.credit) > 0 && (
                <Button variant="secondary" loading={busy} onClick={() => run(() => api('POST', `/reconciliation/statements/lines/${line.id}/suspense`, { body: { reason } }), 'Held in suspense (2250)')}>
                  Hold in suspense
                </Button>
              )}
              <Button variant="secondary" loading={busy} onClick={() => run(() => api('POST', `/reconciliation/statements/lines/${line.id}/ignore`, { body: { reason } }), 'Marked as explained')}>
                Mark explained
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function BankRecon() {
  const banks = useBanks();
  const [accountId, setAccountId] = useState('');
  const [asOf, setAsOf] = useState(todayIST());
  useEffect(() => {
    if (!accountId && banks[0]) setAccountId(banks[0].id);
  }, [banks, accountId]);
  const { data } = useApi<{
    ledgerBalance: string; statementBalance: string | null; statementBalanceDate: string | null; adjustedStatementBalance: string | null; unexplained: string | null;
    bookOnly: { kind: string; id: string; ref: string; date: string; amount: string; direction: string }[];
    statementOnly: { id: string; txn_date: string; description: string; debit: string; credit: string; match_status: string; ignore_reason: string | null }[];
    totals: Record<string, string>;
  }>(accountId ? `/reconciliation/bank/${accountId}${qs({ asOf })}` : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Bank account">
          <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="As of">
          <Input type="date" value={asOf} max={todayIST()} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <dl className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
              {[
                ['Balance in the books', inr(data.ledgerBalance)],
                ['Bank statement balance', data.statementBalance ? `${inr(data.statementBalance)}` : 'No statement yet'],
                ['Statement + items in transit', data.adjustedStatementBalance ? inr(data.adjustedStatementBalance) : '—'],
                ['Unexplained difference', data.unexplained ? inr(data.unexplained) : '—'],
              ].map(([k, v], i) => (
                <div key={k} className="bg-surface px-4 py-3">
                  <dt className="text-[12px] uppercase tracking-wide text-subtle">{k}</dt>
                  <dd className={cx('num mt-1 text-lg font-semibold', i === 3 && data.unexplained && Number(data.unexplained) !== 0 ? 'text-bad' : i === 3 ? 'text-ok' : '')}>{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="In the books, not yet on the statement" description={`In ${inr(data.totals.bookIn)} · out ${inr(data.totals.bookOut)}`} />
              <Table>
                <tbody>
                  {data.bookOnly.slice(0, 100).map((r) => (
                    <tr key={r.kind + r.id}>
                      <Td className="num whitespace-nowrap">{date(r.date)}</Td>
                      <Td className="text-[12px]">
                        {r.kind} · {r.ref}
                      </Td>
                      <Td className={cx('num text-right', r.direction === 'OUT' && 'text-bad')}>{r.direction === 'OUT' ? '−' : '+'}{inr(r.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title="On the statement, not in the books" description={`Credits ${inr(data.totals.statementIn)} · debits ${inr(data.totals.statementOut)}`} />
              <Table>
                <tbody>
                  {data.statementOnly.map((r) => (
                    <tr key={r.id}>
                      <Td className="num whitespace-nowrap">{date(r.txn_date)}</Td>
                      <Td className="text-[12px]">
                        {r.description}
                        {r.ignore_reason && <span className="block text-muted">{r.ignore_reason}</span>}
                      </Td>
                      <Td className="num text-right">{Number(r.credit) ? `+${inr(r.credit)}` : `−${inr(r.debit)}`}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Unconfirmed() {
  const [days, setDays] = useState('3');
  const { data } = useApi<{ data: { id: string; payment_no: string; amount: string; method: string; reference_no: string; value_date: string; loan_no: string; customer_name: string; collector: string | null }[] }>(`/reconciliation/unconfirmed-receipts?days=${days}`);
  const total = useMemo(() => (data?.data ?? []).reduce((s, r) => s + Number(r.amount), 0), [data]);
  return (
    <Card>
      <CardHeader
        title="UPI & bank transfers not seen in the bank"
        description="Recorded as received but not on any imported statement. Check with the collector — the transfer may have failed or a screenshot may be fake."
        actions={
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-auto text-[13px]" aria-label="Older than">
            <option value="0">All</option>
            <option value="3">Older than 3 days</option>
            <option value="7">Older than 7 days</option>
          </Select>
        }
      />
      {!data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <EmptyState title="Nothing outstanding" />
      ) : (
        <>
          <p className="px-5 py-2 text-[13px] text-muted">
            {data.data.length} payments · <span className="num font-medium text-ink-900">{inr(total.toFixed(2))}</span>
          </p>
          <Table>
            <tbody>
              {data.data.map((r) => (
                <tr key={r.id}>
                  <Td className="num whitespace-nowrap">{date(r.value_date)}</Td>
                  <Td>
                    <Link href={`/payments/${r.id}`} className="font-medium hover:underline">
                      {r.customer_name}
                    </Link>
                    <span className="block text-[12px] text-muted">
                      {r.loan_no} · {r.collector ?? 'office'}
                    </span>
                  </Td>
                  <Td className="text-[12px]">
                    {titleCase(r.method)} <span className="num font-mono">{r.reference_no}</span>
                  </Td>
                  <Td className="num text-right">{inr(r.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </Card>
  );
}
