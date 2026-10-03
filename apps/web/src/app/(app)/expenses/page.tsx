'use client';

import { EXPENSE_PAID_FROM, EXPENSE_PAID_FROM_LABELS } from '@fin/contracts';
import { FileText, Plus, Receipt } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { todayIST } from '@/components/lending';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, cx, Detail, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { date, dateTime, inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string; expense_no: string; amount: string; expense_date: string; status: string; paid_from: string; vendor: string | null; bill_no: string | null;
  description: string; submitted_by: string; submitted_at: string; file_id: string | null; category: string; requires_bill: boolean; branch_code: string;
  submitted_by_name: string; canApprove: boolean; canPost: boolean;
}
interface Detailed extends Row {
  branch_id: string; account_code: string; account_name: string; branch_name: string; reject_reason: string | null; reverse_reason: string | null;
  approved_at: string | null; posted_at: string | null; rejected_at: string | null; reversed_at: string | null; journal_entry_id: string | null;
  people: { submittedBy: string | null; approvedBy: string | null; postedBy: string | null; rejectedBy: string | null; reversedBy: string | null };
  canReverse: boolean;
}

const TONE: Record<string, 'warn' | 'info' | 'ok' | 'bad' | 'neutral'> = { SUBMITTED: 'warn', APPROVED: 'info', POSTED: 'ok', REJECTED: 'neutral', REVERSED: 'bad' };
const LABEL: Record<string, string> = { SUBMITTED: 'Waiting for branch approval', APPROVED: 'Waiting for accountant', POSTED: 'Posted', REJECTED: 'Rejected', REVERSED: 'Reversed' };
type Tab = 'action' | 'mine' | 'all';

export default function ExpensesPage() {
  const { can } = useSession();
  const canSee = can('expense.view');
  const [tab, setTab] = useState<Tab>(canSee ? 'action' : 'mine');
  const { data, loading, reload } = useApi<{ data: Row[] }>(`/expenses${tab === 'mine' ? '?mine=true' : ''}`);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => (data?.data ?? []).filter((r) => (tab === 'action' ? r.canApprove || r.canPost : true)), [data, tab]);
  if (!can('expense.submit') && !canSee) return <EmptyState title="You don’t have access to expenses" />;
  const total = rows.filter((r) => r.status !== 'REJECTED' && r.status !== 'REVERSED').reduce((s, r) => s + Number(r.amount), 0);

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Claimed → approved at the branch → posted by an accountant. Nobody approves or posts their own."
        actions={
          can('expense.submit') && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New expense
            </Button>
          )
        }
      />
      <Card>
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3" role="tablist">
          {(
            [
              ...(canSee ? [['action', 'Needs my action'] as const] : []),
              ['mine', 'My claims'] as const,
              ...(canSee ? [['all', 'All'] as const] : []),
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', tab === id ? 'border-accent text-ink-950' : 'border-transparent text-muted')}>
              {label}
            </button>
          ))}
          {rows.length > 0 && <span className="num ml-auto self-center pr-2 text-[13px] text-muted">{inr(total.toFixed(2))}</span>}
        </div>
        {loading && !data ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Receipt className="size-8" />} title={tab === 'action' ? 'Nothing waiting for you' : 'No expenses'} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Expense</Th>
                <Th>Category</Th>
                <Th>Paid from</Th>
                <Th className="text-right">Amount</Th>
                <Th>Status</Th>
                <Th>Claimed by</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(r.id)}>
                  <Td className="num whitespace-nowrap">{date(r.expense_date)}</Td>
                  <Td className="min-w-48">
                    <span className="num font-mono text-[12px] text-muted">{r.expense_no}</span>
                    <p className="text-[13px]">{r.description}</p>
                    {r.requires_bill && !r.file_id && r.status !== 'REJECTED' && <p className="text-[11px] text-warn">Bill not attached</p>}
                  </Td>
                  <Td>{r.category}</Td>
                  <Td className="text-[12px] text-muted">{EXPENSE_PAID_FROM_LABELS[r.paid_from as keyof typeof EXPENSE_PAID_FROM_LABELS] ?? r.paid_from}</Td>
                  <Td className="num text-right font-medium">{inr(r.amount)}</Td>
                  <Td>
                    <Badge tone={TONE[r.status]}>{LABEL[r.status] ?? r.status}</Badge>
                  </Td>
                  <Td className="text-[12px] text-muted">
                    {r.submitted_by_name} · {r.branch_code}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && (
        <NewExpense
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            reload();
            setOpen(id);
          }}
        />
      )}
      {open && <ExpenseDialog id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function NewExpense({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { me } = useSession();
  const toast = useToast();
  const cats = useApi<{ data: { id: string; name: string; requires_bill: boolean }[] }>('/expenses/categories');
  const collector = me?.scope === 'ASSIGNED';
  const branches = me?.branches ?? [];
  const [v, setV] = useState({ branchId: me?.employee?.branchId ?? branches[0]?.id ?? '', categoryId: '', amount: '', expenseDate: todayIST(), paidFrom: collector ? 'EMPLOYEE_CASH' : 'BRANCH_CASH', accountId: '', vendor: '', billNo: '', description: '' });
  const [banks, setBanks] = useState<{ id: string; name: string; subtype: string }[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (v.paidFrom === 'BANK' && !banks.length) get<{ data: { id: string; name: string; subtype: string }[] }>('/banking/accounts').then((r) => setBanks(r.data.filter((a) => a.subtype === 'BANK'))).catch(() => undefined);
  }, [v.paidFrom, banks.length]);
  useEffect(() => {
    if (!v.categoryId && cats.data?.data[0]) setV((x) => ({ ...x, categoryId: cats.data!.data[0]!.id }));
  }, [cats.data, v.categoryId]);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ id: string; expense_no: string }>('POST', '/expenses', { body: { ...v, accountId: v.paidFrom === 'BANK' ? v.accountId : undefined } });
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api('POST', `/expenses/${r.id}/bill`, { body: fd }).catch((e) => toast('bad', `Saved, but the bill did not upload: ${(e as ApiError).message}`));
      }
      toast('ok', `Expense ${r.expense_no} submitted for approval`);
      onDone(r.id);
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const needsBill = cats.data?.data.find((c) => c.id === v.categoryId)?.requires_bill;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New expense"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy}>
            Submit for approval
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {error && !Object.keys(fe).length && (
          <div className="sm:col-span-2">
            <Alert>{error.message}</Alert>
          </div>
        )}
        {!collector && branches.length > 1 && (
          <Field label="Branch" required error={fe.branchId}>
            <Select value={v.branchId} onChange={set('branchId')}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Category" required error={fe.categoryId}>
          <Select value={v.categoryId} onChange={set('categoryId')}>
            {(cats.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount (₹)" required error={fe.amount}>
          <Input inputMode="decimal" value={v.amount} onChange={set('amount')} className="num" />
        </Field>
        <Field label="Date" required error={fe.expenseDate}>
          <Input type="date" max={todayIST()} value={v.expenseDate} onChange={set('expenseDate')} />
        </Field>
        <Field label="Paid from" required error={fe.paidFrom}>
          <Select value={v.paidFrom} onChange={set('paidFrom')} disabled={collector}>
            {EXPENSE_PAID_FROM.filter((p) => (p === 'EMPLOYEE_CASH' ? !!me?.employee : !collector)).map((p) => (
              <option key={p} value={p}>
                {EXPENSE_PAID_FROM_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {v.paidFrom === 'BANK' && (
          <Field label="Bank account" required error={fe.accountId}>
            <Select value={v.accountId} onChange={set('accountId')}>
              <option value="">Choose…</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Paid to" hint="Shop, vendor or person" error={fe.vendor}>
          <Input value={v.vendor} onChange={set('vendor')} />
        </Field>
        <Field label="Bill number" error={fe.billNo}>
          <Input value={v.billNo} onChange={set('billNo')} />
        </Field>
        <Field label="What it was for" required error={fe.description} className="sm:col-span-2">
          <Textarea rows={2} value={v.description} onChange={set('description')} maxLength={500} />
        </Field>
        <Field label="Bill / receipt (PDF or photo)" hint={needsBill ? 'Required for this category before it can be posted' : 'Optional'} className="sm:col-span-2">
          <Input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      </div>
    </Dialog>
  );
}

function ExpenseDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data: e, reload } = useApi<Detailed>(`/expenses/${id}`);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'reject' | 'reverse' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const act = async (path: string, body?: unknown, stepUp = false) => {
    setError(null);
    try {
      const call = () => api('POST', `/expenses/${id}/${path}`, { body });
      await (stepUp ? withStepUp(call) : call());
      toast('ok', { approve: 'Approved — waiting for the accountant', post: 'Posted to the books', reject: 'Rejected', reverse: 'Reversed' }[path] ?? 'Done');
      setMode(null);
      reload();
      onChanged();
    } catch (err) {
      if ((err as ApiError).code !== 'REAUTH_CANCELLED') setError(err as ApiError);
    }
  };
  const [run, busy] = useSubmit(act);
  if (!e) return null;
  return (
    <Dialog open wide onClose={onClose} title={`${e.expense_no} · ${inr(e.amount)}`} description={`${e.category} · ${e.branch_name}`}>
      <div className="space-y-4">
        {error && <Alert>{error.message}</Alert>}
        <Badge tone={TONE[e.status]}>{LABEL[e.status]}</Badge>
        <dl className="grid grid-cols-2 gap-4">
          <Detail label="Date" value={date(e.expense_date)} />
          <Detail label="Paid from" value={`${e.account_code} ${e.account_name}`} />
          <Detail label="Paid to" value={e.vendor} />
          <Detail label="Bill no." value={e.bill_no} />
          <div className="col-span-2">
            <Detail label="For" value={e.description} />
          </div>
        </dl>
        {e.file_id ? (
          <a href={`/api/v1/expenses/${e.id}/bill`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent-strong hover:underline">
            <FileText className="size-4" /> View bill
          </a>
        ) : (
          e.requires_bill && <Alert tone="warn">No bill attached. This category needs one.</Alert>
        )}
        <ol className="space-y-1 border-t border-line pt-3 text-[12px] text-muted">
          <li>Claimed by {e.people.submittedBy} · {dateTime(e.submitted_at)}</li>
          {e.approved_at && <li>Approved by {e.people.approvedBy} · {dateTime(e.approved_at)}</li>}
          {e.posted_at && <li>Posted by {e.people.postedBy} · {dateTime(e.posted_at)}</li>}
          {e.rejected_at && (
            <li className="text-bad">
              Rejected by {e.people.rejectedBy} · {dateTime(e.rejected_at)} — {e.reject_reason}
            </li>
          )}
          {e.reversed_at && (
            <li className="text-bad">
              Reversed by {e.people.reversedBy} · {dateTime(e.reversed_at)} — {e.reverse_reason}
            </li>
          )}
        </ol>
        {mode ? (
          <div className="space-y-2 rounded-md border border-line p-3">
            <Field label={mode === 'reject' ? 'Why is it rejected?' : 'Why reverse it?'} required>
              <Textarea rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setMode(null)}>
                Back
              </Button>
              <Button size="sm" variant="danger" loading={busy} onClick={() => run(mode, { reason }, mode === 'reverse')}>
                {mode === 'reject' ? 'Reject expense' : 'Reverse expense'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            {(e.canApprove || e.canPost) && (
              <Button variant="secondary" onClick={() => setMode('reject')}>
                Reject
              </Button>
            )}
            {e.canApprove && (
              <Button onClick={() => run('approve')} loading={busy}>
                Approve
              </Button>
            )}
            {e.canPost && (
              <Button onClick={() => run('post')} loading={busy}>
                Post to books
              </Button>
            )}
            {e.canReverse && (
              <Button variant="ghost" onClick={() => setMode('reverse')}>
                Reverse
              </Button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
