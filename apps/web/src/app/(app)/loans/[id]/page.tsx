'use client';

import { CATEGORY_LABELS, DISBURSEMENT_MODES, LoanCategory } from '@fin/contracts';
import { Ban, Banknote, CheckCircle2, Download, FileSpreadsheet, Send, XCircle } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import { DpdBadge, FREQUENCY_LABELS, InstallmentRow, LoanStatusBadge, METHOD_LABELS, ScheduleTable, todayIST } from '@/components/lending';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Detail, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Loan {
  id: string;
  loan_no: string;
  status: string;
  category: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  customer_mobile: string;
  customer_kyc: string;
  branch_code: string;
  branch_name: string;
  principal: string;
  annual_rate: string;
  interest_method: string;
  frequency: string;
  num_installments: number;
  installment_amount: string;
  total_interest: string;
  total_fees: string;
  total_gst: string;
  fees_deducted: string;
  total_payable: string;
  net_disbursement: string;
  apr: string;
  asset_value: string | null;
  down_payment: string;
  disbursement_date: string;
  first_due_date: string;
  maturity_date: string;
  disbursed_on: string | null;
  disbursement_mode: string | null;
  disbursement_reference: string | null;
  principal_outstanding: string;
  interest_outstanding: string;
  fees_outstanding: string;
  penalty_outstanding: string;
  balance_payable: string;
  overdue_amount: string;
  dpd: number;
  next_due_date: string | null;
  next_due_amount: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  decision_note: string | null;
  cancel_reason: string | null;
  penalty_rule: { type: string; value: string; graceDays: number };
  product: { id: string; code: string; name: string; version: number; approvalLimit: string | null };
  installments: InstallmentRow[];
  assets: Record<string, string | number | boolean | null>[];
  charges: { id: string; charge_type: string; code: string; description: string; amount: string; gst_amount: string; assessed_on: string; status: string; collection_mode: string | null }[];
  people: { createdBy: string | null; submittedBy: string | null; approvedBy: string | null; rejectedBy: string | null; cancelledBy: string | null };
  disbursementAccount: { code: string; name: string } | null;
  canDecide: boolean;
}

type Tab = 'schedule' | 'asset' | 'charges' | 'accounting' | 'statement';

export default function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data: loan, loading, error, reload } = useApi<Loan>(`/loans/${id}`);
  const [tab, setTab] = useState<Tab>('schedule');
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'cancel' | 'disburse' | null>(null);

  if (loading && !loan) return <Spinner />;
  if (error || !loan) return <EmptyState title="Loan not found" body="It may not exist, or it belongs to a branch you can’t access." />;

  const active = loan.status === 'ACTIVE';
  const asset = loan.assets[0];
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/loans" className="hover:underline">
            Loans
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="num font-mono">{loan.loan_no}</span>
            <LoanStatusBadge status={loan.status} />
            {active && loan.dpd > 0 && <DpdBadge dpd={loan.dpd} />}
          </span>
        }
        subtitle={
          <>
            <Link href={`/customers/${loan.customer_id}`} className="font-medium text-ink-800 hover:underline">
              {loan.customer_name}
            </Link>{' '}
            · {loan.customer_no} · {loan.product.name} · {loan.branch_name}
          </>
        }
        actions={<Actions loan={loan} open={setDialog} />}
      />

      <Workflow loan={loan} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(active
          ? [
              ['Outstanding', inr(loan.balance_payable), `principal ${inr(loan.principal_outstanding)}`],
              ['Overdue', inr(loan.overdue_amount), loan.dpd ? `${loan.dpd} days past due` : 'Nothing overdue'],
              ['Next installment', loan.next_due_date ? inr(loan.next_due_amount) : '—', loan.next_due_date ? `due ${date(loan.next_due_date)}` : 'Schedule complete'],
              ['Charges due', inr((Number(loan.interest_outstanding) + Number(loan.fees_outstanding) + Number(loan.penalty_outstanding)).toFixed(2)), `interest ${inr(loan.interest_outstanding)} · penal ${inr(loan.penalty_outstanding)}`],
            ]
          : [
              ['Loan amount', inr(loan.principal), `cash to customer ${inr(loan.net_disbursement)}`],
              ['Installment', inr(loan.installment_amount), `× ${loan.num_installments} ${FREQUENCY_LABELS[loan.frequency]?.toLowerCase()}`],
              ['Total repayable', inr(loan.total_payable), `interest ${inr(loan.total_interest)}`],
              ['APR', `${Number(loan.apr).toFixed(2)}%`, `${Number(loan.annual_rate)}% ${METHOD_LABELS[loan.interest_method]?.toLowerCase()}`],
            ]
        ).map(([k, v, hint]) => (
          <Card key={k} className="px-4 py-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-subtle">{k}</p>
            <p className="num mt-1 text-lg font-semibold text-ink-950">{v}</p>
            <p className="text-[12px] text-muted">{hint}</p>
          </Card>
        ))}
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'schedule', label: 'Schedule', count: loan.installments.length },
          { id: 'asset', label: 'Asset' },
          { id: 'charges', label: 'Fees & charges', count: loan.charges.length },
          ...(can('ledger.view') ? [{ id: 'accounting' as Tab, label: 'Accounting' }] : []),
          ...(can('statement.generate') && loan.disbursed_on ? [{ id: 'statement' as Tab, label: 'Statement' }] : []),
        ]}
      />
      <div className="mt-5">
        {tab === 'schedule' && (
          <Card>
            <CardHeader
              title="Repayment schedule"
              description={`${Number(loan.annual_rate)}% p.a. ${METHOD_LABELS[loan.interest_method]?.toLowerCase()} · ${loan.num_installments} ${FREQUENCY_LABELS[loan.frequency]?.toLowerCase()} installments · first due ${date(loan.first_due_date)}`}
            />
            <ScheduleTable installments={loan.installments} />
          </Card>
        )}
        {tab === 'asset' && asset && <AssetPanel a={asset} />}
        {tab === 'charges' && <ChargesPanel loan={loan} />}
        {tab === 'accounting' && <AccountingPanel id={loan.id} />}
        {tab === 'statement' && <StatementPanel loan={loan} />}
      </div>

      {dialog === 'approve' && <DecisionDialog loan={loan} kind="approve" onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'reject' && <DecisionDialog loan={loan} kind="reject" onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'cancel' && <DecisionDialog loan={loan} kind="cancel" onClose={() => setDialog(null)} onDone={reload} />}
      {dialog === 'disburse' && <DisburseDialog loan={loan} onClose={() => setDialog(null)} onDone={reload} />}
    </>
  );
}

function Actions({ loan, open }: { loan: Loan; open: (d: 'approve' | 'reject' | 'cancel' | 'disburse') => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [submit, submitting] = useSubmit(async () => {
    try {
      await api('POST', `/loans/${loan.id}/submit`);
      toast('ok', 'Sent for approval');
      location.reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  return (
    <>
      {loan.status === 'DRAFT' && can('loan.create') && (
        <Button onClick={() => submit()} loading={submitting}>
          <Send className="size-4" /> Send for approval
        </Button>
      )}
      {loan.status === 'PENDING_APPROVAL' && can('loan.approve') && loan.canDecide && (
        <>
          <Button variant="secondary" onClick={() => open('reject')}>
            <XCircle className="size-4" /> Reject
          </Button>
          <Button onClick={() => open('approve')}>
            <CheckCircle2 className="size-4" /> Approve
          </Button>
        </>
      )}
      {loan.status === 'APPROVED' && can('loan.disburse') && (
        <Button onClick={() => open('disburse')}>
          <Banknote className="size-4" /> Disburse
        </Button>
      )}
      {['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(loan.status) && can('loan.cancel') && (
        <Button variant="ghost" onClick={() => open('cancel')}>
          <Ban className="size-4" /> Cancel loan
        </Button>
      )}
    </>
  );
}

function Workflow({ loan }: { loan: Loan }) {
  const steps: { label: string; who: string | null; when: string | null; done: boolean; bad?: boolean; note?: string | null }[] = [
    { label: 'Created', who: loan.people.createdBy, when: loan.created_at, done: true },
    { label: 'Sent for approval', who: loan.people.submittedBy, when: loan.submitted_at, done: !!loan.submitted_at },
    loan.rejected_at
      ? { label: 'Rejected', who: loan.people.rejectedBy, when: loan.rejected_at, done: true, bad: true, note: loan.decision_note }
      : { label: 'Approved', who: loan.people.approvedBy, when: loan.approved_at, done: !!loan.approved_at, note: loan.decision_note },
    loan.cancelled_at
      ? { label: 'Cancelled', who: loan.people.cancelledBy, when: loan.cancelled_at, done: true, bad: true, note: loan.cancel_reason }
      : { label: 'Disbursed', who: loan.disbursement_mode ? titleCase(loan.disbursement_mode) : null, when: loan.disbursed_on, done: !!loan.disbursed_on },
  ];
  const waiting = loan.status === 'PENDING_APPROVAL' && !loan.canDecide;
  return (
    <Card className="mb-6">
      <ol className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        {steps.map((s) => (
          <li key={s.label} className="bg-surface px-4 py-3">
            <p className={`flex items-center gap-1.5 text-[13px] font-medium ${s.bad ? 'text-bad' : s.done ? 'text-ink-950' : 'text-subtle'}`}>
              <span className={`size-2 rounded-full ${s.bad ? 'bg-bad' : s.done ? 'bg-accent' : 'bg-line-strong'}`} />
              {s.label}
            </p>
            <p className="mt-0.5 text-[12px] text-muted">{s.done ? [s.who, s.when && (s.when.length === 10 ? date(s.when) : dateTime(s.when))].filter(Boolean).join(' · ') : '—'}</p>
            {s.note && <p className="mt-0.5 text-[12px] italic text-muted">“{s.note}”</p>}
          </li>
        ))}
      </ol>
      {waiting && <p className="border-t border-line px-4 py-2 text-[12px] text-muted">You created this loan, so another approver must decide on it (maker-checker).</p>}
      {loan.status === 'PENDING_APPROVAL' && loan.customer_kyc !== 'VERIFIED' && (
        <p className="border-t border-line px-4 py-2 text-[12px] text-warn">
          The customer’s KYC is {loan.customer_kyc.toLowerCase()} — it must be verified before approval.{' '}
          <Link href={`/customers/${loan.customer_id}`} className="underline">
            Open customer
          </Link>
        </p>
      )}
    </Card>
  );
}

function DecisionDialog({ loan, kind, onClose, onDone }: { loan: Loan; kind: 'approve' | 'reject' | 'cancel'; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const cfg = {
    approve: { title: `Approve ${loan.loan_no}`, label: 'Note (optional)', button: 'Approve loan', path: 'approve', body: { note: note || undefined } },
    reject: { title: `Reject ${loan.loan_no}`, label: 'Reason (shared in the history)', button: 'Reject loan', path: 'reject', body: { note } },
    cancel: { title: `Cancel ${loan.loan_no}`, label: 'Reason', button: 'Cancel loan', path: 'cancel', body: { reason: note } },
  }[kind];
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', `/loans/${loan.id}/${cfg.path}`, { body: cfg.body });
      toast('ok', kind === 'approve' ? 'Loan approved' : kind === 'reject' ? 'Loan rejected' : 'Loan cancelled');
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
      title={cfg.title}
      description={kind === 'approve' ? `${inr(loan.principal)} to ${loan.customer_name}, ${loan.num_installments} × ${inr(loan.installment_amount)}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant={kind === 'approve' ? 'primary' : 'danger'} onClick={() => go()} loading={busy}>
            {cfg.button}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.fieldErrors().note ?? error.fieldErrors().reason ?? error.message}</Alert>}
        <Field label={cfg.label} required={kind !== 'approve'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} autoFocus />
        </Field>
      </div>
    </Dialog>
  );
}

interface PayoutAccount {
  id: string;
  code: string;
  name: string;
  subtype: string;
  bank_name: string | null;
  account_no_last4: string | null;
}

function DisburseDialog({ loan, onClose, onDone }: { loan: Loan; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const key = useMemo(() => newIdempotencyKey(), []);
  const [accounts, setAccounts] = useState<PayoutAccount[] | null>(null);
  const [v, setV] = useState({ mode: 'BANK_TRANSFER', accountId: '', reference: '', disbursedOn: todayIST() });
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    get<{ data: PayoutAccount[] }>(`/loans/${loan.id}/payout-accounts`).then((r) => setAccounts(r.data)).catch(() => setAccounts([]));
  }, [loan.id]);
  const options = (accounts ?? []).filter((a) => (v.mode === 'CASH' ? a.subtype === 'CASH' : a.subtype !== 'CASH'));
  useEffect(() => {
    if (!options.find((o) => o.id === v.accountId)) setV((p) => ({ ...p, accountId: options[0]?.id ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.mode, accounts]);
  const fe = error?.fieldErrors() ?? {};
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ journalEntryNo: string }>('POST', `/loans/${loan.id}/disburse`, { body: { ...v, reference: v.reference || undefined }, idempotencyKey: key });
      toast('ok', `Disbursed. Journal ${r.journalEntryNo} posted.`);
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
      title={`Disburse ${loan.loan_no}`}
      description="Record the payment to the customer. This posts to the accounts and cannot be undone except by reversal."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button onClick={() => go()} loading={busy} disabled={!v.accountId}>
            Confirm disbursement
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-canvas p-4">
          <p className="text-[12px] text-muted">Pay to {loan.customer_name}</p>
          <p className="num text-2xl font-semibold text-ink-950">{inr(loan.net_disbursement)}</p>
          {Number(loan.fees_deducted) > 0 && (
            <p className="text-[12px] text-muted">
              {inr(loan.principal)} loan − {inr(loan.fees_deducted)} fees & GST deducted
            </p>
          )}
        </div>
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid by">
            <Select value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
              {DISBURSEMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" error={fe.disbursedOn}>
            <Input type="date" value={v.disbursedOn} max={todayIST()} onChange={(e) => setV({ ...v, disbursedOn: e.target.value })} />
          </Field>
        </div>
        <Field label="From account" error={fe.accountId}>
          {accounts === null ? (
            <Spinner />
          ) : options.length === 0 ? (
            <Alert tone="warn">No {v.mode === 'CASH' ? 'cash' : 'bank'} account available. An accountant can add bank accounts under Accounts.</Alert>
          ) : (
            <Select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })}>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                  {a.account_no_last4 ? ` (…${a.account_no_last4})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {v.mode !== 'CASH' && (
          <Field label={v.mode === 'CHEQUE' ? 'Cheque number' : 'UTR / transaction reference'} required error={fe.reference}>
            <Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} className="num font-mono" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function AssetPanel({ a }: { a: Record<string, string | number | boolean | null> }) {
  const s = (k: string) => (a[k] === null || a[k] === undefined || a[k] === '' ? null : String(a[k]));
  const rows: [string, string | null, boolean?][] = [
    ['Asset no.', s('asset_no'), true],
    ['Category', CATEGORY_LABELS[a.category as LoanCategory] ?? s('category')],
    ['Description', s('description')],
    ['Make / brand', s('make')],
    ['Model', [s('model'), s('variant')].filter(Boolean).join(' ') || null],
    ['Year', s('manufacture_year')],
    ['Colour', s('colour')],
    ['Registration', s('registration_no'), true],
    ['Chassis no.', s('chassis_no'), true],
    ['Engine no.', s('engine_no'), true],
    ['Serial no.', s('serial_no'), true],
    ['Vehicle type', s('vehicle_type')],
    ['Asset value', a.asset_value ? inr(String(a.asset_value)) : null],
    ['Purchase price', a.purchase_price ? inr(String(a.purchase_price)) : null],
    ['Dealer', s('dealer_name')],
    ['Invoice', s('invoice_no')],
    ['Hypothecation', a.hypothecation_marked ? 'Marked on RC' : 'Not marked'],
    ['Insurance', [s('insurer'), s('insurance_policy_no')].filter(Boolean).join(' · ') || null],
    ['Insurance expiry', a.insurance_expiry ? date(String(a.insurance_expiry)) : null],
    ['Permit', [s('permit_no'), a.permit_expiry ? `till ${date(String(a.permit_expiry))}` : null].filter(Boolean).join(' ') || null],
    ['Fitness expiry', a.fitness_expiry ? date(String(a.fitness_expiry)) : null],
  ];
  return (
    <Card>
      <CardHeader title="Financed asset" actions={<StatusBadge status={String(a.status)} />} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5 md:grid-cols-3">
        {rows.filter(([, v]) => v !== null).map(([k, v, mono]) => (
          <Detail key={k} label={k} value={v} mono={mono} />
        ))}
      </dl>
      <p className="border-t border-line px-5 py-3 text-[12px] text-muted">
        <Link href={`/assets/${a.id}`} className="text-ink-700 hover:underline">
          Open asset record
        </Link>{' '}
        for documents (RC, insurance, invoice) and history.
      </p>
    </Card>
  );
}

function ChargesPanel({ loan }: { loan: Loan }) {
  const rule = loan.penalty_rule;
  return (
    <Card>
      <CardHeader
        title="Fees & penal charges"
        description={
          rule.type === 'NONE'
            ? 'No penal charges on this loan.'
            : `Penal charge: ${rule.type === 'FLAT_PER_INSTALLMENT' ? `₹${rule.value} once per late installment` : `${rule.value}% ${rule.type === 'PCT_PA_ON_OVERDUE' ? 'per annum' : 'per day'} on the overdue amount`}, after ${rule.graceDays} days’ grace. Never added to principal.`
        }
      />
      {loan.charges.length === 0 ? (
        <EmptyState title={loan.disbursed_on ? 'No fees or charges' : 'Fees are recorded at disbursement'} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Type</Th>
              <Th>Description</Th>
              <Th className="text-right">Amount</Th>
              <Th className="text-right">GST</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {loan.charges.map((c) => (
              <tr key={c.id}>
                <Td className="num">{date(c.assessed_on)}</Td>
                <Td>
                  <Badge tone={c.charge_type === 'PENALTY' ? 'warn' : 'neutral'}>{c.charge_type === 'PENALTY' ? 'Penal' : 'Fee'}</Badge>
                </Td>
                <Td>{c.description}</Td>
                <Td className="num text-right">{inr(c.amount)}</Td>
                <Td className="num text-right">{Number(c.gst_amount) ? inr(c.gst_amount) : '—'}</Td>
                <Td className="text-[12px] text-muted">{c.status === 'DEDUCTED' ? 'Deducted at disbursal' : c.status === 'OPEN' ? 'Due' : titleCase(c.status)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

interface Entry {
  id: string;
  entry_no: string;
  entry_type: string;
  value_date: string;
  narration: string;
  lines: { line_no: number; code: string; name: string; debit: string; credit: string; memo: string | null }[];
}

/** What the collector sees as "₹1,250 collected", the accountant sees as debits and credits (doc 01 §63). */
function AccountingPanel({ id }: { id: string }) {
  const { data, loading } = useApi<{ data: Entry[] }>(`/loans/${id}/journal`);
  if (loading || !data) return <Spinner />;
  if (!data.data.length) return <Card><EmptyState title="No accounting entries yet" body="Entries are posted when the loan is disbursed." /></Card>;
  return (
    <div className="space-y-4">
      {data.data.map((e) => (
        <Card key={e.id}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
            <div>
              <p className="text-sm font-medium text-ink-950">{e.narration}</p>
              <p className="num text-[12px] text-muted">
                {e.entry_no} · {date(e.value_date)}
              </p>
            </div>
            <Badge>{titleCase(e.entry_type)}</Badge>
          </div>
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
                    <span className="num font-mono text-[12px] text-muted">{l.code}</span> <span className="text-ink-950">{l.name}</span>
                  </Td>
                  <Td className="text-muted">{l.memo}</Td>
                  <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
                  <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}

interface Statement {
  lines: { date: string; entryNo: string; type: string; description: string; debit: string; credit: string; balance: string }[];
  summary: Record<string, string | number>;
}

function StatementPanel({ loan }: { loan: Loan }) {
  const { data, loading } = useApi<Statement>(`/loans/${loan.id}/statement`);
  if (loading || !data) return <Spinner />;
  const s = data.summary;
  return (
    <Card>
      <CardHeader
        title="Loan statement"
        description="Straight from the accounting records. Payments appear here once collections start (Phase 4)."
        actions={
          <>
            <a href={`/api/v1/loans/${loan.id}/statement?format=pdf`}>
              <Button size="sm" variant="secondary">
                <Download className="size-3.5" /> PDF
              </Button>
            </a>
            <a href={`/api/v1/loans/${loan.id}/statement?format=xlsx`}>
              <Button size="sm" variant="secondary">
                <FileSpreadsheet className="size-3.5" /> Excel
              </Button>
            </a>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Disbursed', s.principalDisbursed],
          ['Interest charged', s.interestCharged],
          ['Fees charged', s.feesCharged],
          ['Penal charges', s.penaltiesCharged],
          ['Received', s.paymentsReceived],
          ['Outstanding', s.outstanding],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3">
            <p className="text-[12px] text-muted">{k}</p>
            <p className="num font-semibold text-ink-950">{inr(String(v))}</p>
          </div>
        ))}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Description</Th>
            <Th className="text-right">Charged</Th>
            <Th className="text-right">Paid</Th>
            <Th className="text-right">Balance</Th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <Td className="num whitespace-nowrap">{date(l.date)}</Td>
              <Td>
                {l.description}
                <span className="num ml-2 font-mono text-[11px] text-subtle">{l.entryNo}</span>
              </Td>
              <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
              <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
              <Td className="num text-right font-medium">{inr(l.balance)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
