'use client';

import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { todayIST } from '@/components/lending';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, get, qs } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useDebounced, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Entry { id: string; entry_no: string; entry_type: string; value_date: string; posted_at: string; narration: string; source_type: string | null; source_id: string | null; branch_code: string | null; created_by_name: string | null; total: string; reverses_entry_id: string | null }
interface EntryDetail extends Entry {
  approved_by_name: string | null;
  reverses_entry_no: string | null;
  reversed_by_id: string | null;
  reversed_by_entry_no: string | null;
  lines: { line_no: number; code: string; name: string; debit: string; credit: string; memo: string | null; loan_id: string | null; loan_no: string | null; employee: string | null }[];
}
interface Manual { id: string; value_date: string; narration: string; total: string; status: string; created_at: string; decided_at: string | null; decision_note: string | null; created_by_name: string; decided_by_name: string | null; entry_no: string | null; entry_id: string | null; branch_code: string | null; canDecide: boolean; lines: { accountId: string; code?: string; name?: string; debit: string; credit: string; memo?: string }[] }

const TYPES = ['DISBURSEMENT', 'PAYMENT', 'ACCRUAL', 'PENALTY', 'FEE', 'EXPENSE', 'DEPOSIT', 'REVERSAL', 'MANUAL', 'ADJUSTMENT', 'OPENING'];
const SOURCE_LINK: Record<string, (id: string) => string> = { loan: (id) => `/loans/${id}`, payment: (id) => `/payments/${id}`, cheque_deposit: (id) => `/payments/${id}` };
type Tab = 'entries' | 'manual';

export default function JournalsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('entries');
  if (!can('ledger.view')) return <EmptyState title="You don’t have access to the journal" />;
  return (
    <>
      <PageHeader title="Journal" subtitle="Every accounting entry, permanent and balanced. Corrections are reversals or approved manual journals." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'entries', label: 'Entries' },
          { id: 'manual', label: 'Manual journals' },
        ]}
      />
      <div className="mt-5">{tab === 'entries' ? <Entries /> : <ManualJournals />}</div>
    </>
  );
}

function Entries() {
  const [from, setFrom] = useState(todayIST().slice(0, 8) + '01');
  const [to, setTo] = useState(todayIST());
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 300);
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const filters = { from, to, type, q: term, limit: 100 };
  useEffect(() => {
    setRows(null);
    get<{ data: Entry[]; nextCursor: string | null }>(`/journals${qs(filters)}`).then((r) => {
      setRows(r.data);
      setCursor(r.nextCursor);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, type, term]);
  async function more() {
    const r = await get<{ data: Entry[]; nextCursor: string | null }>(`/journals${qs({ ...filters, cursor })}`);
    setRows((p) => [...(p ?? []), ...r.data]);
    setCursor(r.nextCursor);
  }
  return (
    <Card>
      <div className="grid grid-cols-2 gap-3 border-b border-line p-4 md:grid-cols-[1fr_1fr_1fr_2fr]">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Search">
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Entry number or narration" />
        </Field>
      </div>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No entries in this period" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Entry</Th>
                <Th>Narration</Th>
                <Th className="text-right">Amount</Th>
                <Th>By</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(e.id)}>
                  <Td className="num whitespace-nowrap">{date(e.value_date)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="num font-mono text-[12px]">{e.entry_no}</span>
                    <p>
                      <Badge tone={e.entry_type === 'REVERSAL' ? 'bad' : e.entry_type === 'MANUAL' ? 'warn' : 'neutral'}>{titleCase(e.entry_type)}</Badge>
                    </p>
                  </Td>
                  <Td className="max-w-lg text-[13px]">{e.narration}</Td>
                  <Td className="num text-right">{inr(e.total)}</Td>
                  <Td className="text-[12px] text-muted">
                    {e.created_by_name ?? 'System'} {e.branch_code ? `· ${e.branch_code}` : ''}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {cursor && (
            <div className="border-t border-line p-3 text-center">
              <Button variant="secondary" size="sm" onClick={more}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      {open && <EntryDialog id={open} onClose={() => setOpen(null)} onOpen={setOpen} />}
    </Card>
  );
}

function EntryDialog({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { data: e } = useApi<EntryDetail>(`/journals/${id}`);
  if (!e) return null;
  const link = e.source_type && e.source_id && SOURCE_LINK[e.source_type]?.(e.source_id);
  return (
    <Dialog open wide onClose={onClose} title={`${e.entry_no} · ${titleCase(e.entry_type)}`} description={e.narration}>
      <div className="space-y-3">
        <p className="text-[12px] text-muted">
          Value date {date(e.value_date)} · posted {dateTime(e.posted_at)} by {e.created_by_name ?? 'the system'}
          {e.approved_by_name ? ` · approved by ${e.approved_by_name}` : ''}
          {e.branch_code ? ` · ${e.branch_code}` : ''}
        </p>
        {e.reverses_entry_id && (
          <Alert tone="info">
            Reverses{' '}
            <button className="underline" onClick={() => onOpen(e.reverses_entry_id!)}>
              {e.reverses_entry_no}
            </button>
          </Alert>
        )}
        {e.reversed_by_id && (
          <Alert tone="warn">
            Reversed by{' '}
            <button className="underline" onClick={() => onOpen(e.reversed_by_id!)}>
              {e.reversed_by_entry_no}
            </button>
          </Alert>
        )}
        <Table>
          <thead>
            <tr>
              <Th>Account</Th>
              <Th>Detail</Th>
              <Th className="text-right">Debit</Th>
              <Th className="text-right">Credit</Th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l) => (
              <tr key={l.line_no}>
                <Td>
                  <span className="num font-mono text-[12px] text-muted">{l.code}</span> {l.name}
                </Td>
                <Td className="text-[12px] text-muted">
                  {[l.memo, l.employee].filter(Boolean).join(' · ')}
                  {l.loan_id && (
                    <>
                      {' · '}
                      <Link href={`/loans/${l.loan_id}`} className="hover:underline">
                        {l.loan_no}
                      </Link>
                    </>
                  )}
                </Td>
                <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
                <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {link && (
          <Link href={link} className="text-[13px] text-accent-strong hover:underline">
            Open the {e.source_type?.replace('_', ' ')} →
          </Link>
        )}
      </div>
    </Dialog>
  );
}

function ManualJournals() {
  const { can } = useSession();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data, reload } = useApi<{ data: Manual[] }>('/manual-journals');
  const [creating, setCreating] = useState<Manual['lines'] | null>(null);
  const [rejecting, setRejecting] = useState<Manual | null>(null);
  const [approve, approving] = useSubmit(async (m: Manual) => {
    try {
      await withStepUp(() => api('POST', `/manual-journals/${m.id}/approve`, { body: {} }));
      toast('ok', 'Journal approved and posted');
      reload();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  });
  return (
    <Card>
      <CardHeader
        title="Manual journals"
        description="Prepared by one person, approved by another. Loan receivables and customer advances can’t be touched here — use the loan’s own actions."
        actions={
          can('journal.create') && (
            <Button size="sm" onClick={() => setCreating([])}>
              <Plus className="size-3.5" /> New journal
            </Button>
          )
        }
      />
      {!data ? (
        <Spinner />
      ) : data.data.length === 0 ? (
        <EmptyState title="No manual journals" />
      ) : (
        <ul className="divide-y divide-line">
          {data.data.map((m) => (
            <li key={m.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{m.narration}</p>
                  <p className="text-[12px] text-muted">
                    {date(m.value_date)} · {inr(m.total)} · prepared by {m.created_by_name} {dateTime(m.created_at)}
                    {m.decided_by_name && ` · ${m.status === 'APPROVED' ? 'approved' : 'rejected'} by ${m.decided_by_name}`}
                    {m.decision_note && ` — “${m.decision_note}”`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={m.status === 'APPROVED' ? 'ok' : m.status === 'REJECTED' ? 'neutral' : 'warn'}>{m.status === 'PENDING' ? 'Waiting for approval' : titleCase(m.status)}</Badge>
                  {m.entry_no && <span className="num font-mono text-[12px] text-muted">{m.entry_no}</span>}
                  {m.canDecide && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setRejecting(m)}>
                        Reject
                      </Button>
                      <Button size="sm" onClick={() => approve(m)} loading={approving}>
                        Approve & post
                      </Button>
                    </>
                  )}
                  {m.status === 'APPROVED' && can('journal.create') && (
                    <Button size="sm" variant="ghost" onClick={() => setCreating(m.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })))}>
                      Prepare reversal
                    </Button>
                  )}
                </div>
              </div>
              <table className="mt-2 w-full text-[12px]">
                <tbody>
                  {m.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="py-0.5">
                        <span className="num font-mono text-muted">{l.code}</span> {l.name}
                        {l.memo ? <span className="text-muted"> · {l.memo}</span> : null}
                      </td>
                      <td className="num w-32 text-right">{Number(l.debit) ? inr(l.debit) : ''}</td>
                      <td className="num w-32 text-right">{Number(l.credit) ? inr(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewJournal
          initial={creating}
          onClose={() => setCreating(null)}
          onDone={() => {
            setCreating(null);
            reload();
          }}
        />
      )}
      {rejecting && <RejectJournal m={rejecting} onClose={() => setRejecting(null)} onDone={reload} />}
    </Card>
  );
}

const CONTROLLED = ['1310', '1320', '1330', '1340', '2200'];

function NewJournal({ initial, onClose, onDone }: { initial: Manual['lines']; onClose: () => void; onDone: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const accounts = useApi<{ data: { id: string; code: string; name: string; isPostable: boolean }[] }>('/accounts');
  const options = useMemo(() => (accounts.data?.data ?? []).filter((a) => a.isPostable && !CONTROLLED.includes(a.code)), [accounts.data]);
  const [valueDate, setValueDate] = useState(todayIST());
  const [branchId, setBranchId] = useState(me?.branches[0]?.id ?? '');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<{ accountId: string; debit: string; credit: string; memo: string }[]>(
    initial.length ? initial.map((l) => ({ accountId: l.accountId, debit: l.debit === '0' || l.debit === '0.00' ? '' : l.debit, credit: l.credit === '0' || l.credit === '0.00' ? '' : l.credit, memo: l.memo ?? '' })) : [{ accountId: '', debit: '', credit: '', memo: '' }, { accountId: '', debit: '', credit: '', memo: '' }],
  );
  const [error, setError] = useState<ApiError | null>(null);
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', '/manual-journals', { body: { valueDate, branchId: branchId || undefined, narration, lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit || '0', credit: l.credit || '0', memo: l.memo || undefined })) } });
      toast('ok', 'Journal prepared — waiting for approval');
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const upd = (i: number, k: 'accountId' | 'debit' | 'credit' | 'memo', v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v, ...(k === 'debit' && v ? { credit: '' } : {}), ...(k === 'credit' && v ? { debit: '' } : {}) } : l)));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New manual journal"
      description="Goes to a second person for approval before anything is posted."
      footer={
        <>
          <span className={`num mr-auto self-center text-[13px] ${dr.toFixed(2) === cr.toFixed(2) && dr > 0 ? 'text-ok' : 'text-warn'}`}>
            Dr {inr(dr.toFixed(2))} · Cr {inr(cr.toFixed(2))}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy}>
            Send for approval
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Value date" required>
            <Input type="date" max={todayIST()} value={valueDate} onChange={(e) => setValueDate(e.target.value)} />
          </Field>
          {me && me.branches.length > 0 && (
            <Field label="Branch" required={me.scope !== 'ALL'}>
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {me.scope === 'ALL' && <option value="">Company-wide</option>}
                {me.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Narration" required>
          <Textarea rows={2} value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What happened and why this entry is needed" />
        </Field>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_6rem_auto] items-center gap-2 sm:grid-cols-[2fr_7rem_7rem_1fr_auto]">
              <Select value={l.accountId} onChange={(e) => upd(i, 'accountId', e.target.value)} aria-label={`Line ${i + 1} account`}>
                <option value="">Account…</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
              <Input inputMode="decimal" placeholder="Debit" value={l.debit} onChange={(e) => upd(i, 'debit', e.target.value)} className="num" aria-label={`Line ${i + 1} debit`} />
              <Input inputMode="decimal" placeholder="Credit" value={l.credit} onChange={(e) => upd(i, 'credit', e.target.value)} className="num" aria-label={`Line ${i + 1} credit`} />
              <Input placeholder="Memo" value={l.memo} onChange={(e) => upd(i, 'memo', e.target.value)} className="hidden sm:block" aria-label={`Line ${i + 1} memo`} />
              <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length <= 2} className="rounded p-2 text-muted hover:bg-canvas disabled:opacity-30" aria-label="Remove line">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { accountId: '', debit: '', credit: '', memo: '' }])}>
            <Plus className="size-3.5" /> Add line
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RejectJournal({ m, onClose, onDone }: { m: Manual; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    try {
      await api('POST', `/manual-journals/${m.id}/reject`, { body: { reason } });
      toast('ok', 'Journal rejected');
      onClose();
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Reject journal"
      description={m.narration}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant="danger" onClick={() => go()} loading={busy}>
            Reject
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
