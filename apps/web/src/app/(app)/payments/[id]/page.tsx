'use client';

import { REVERSAL_REASON_LABELS } from '@fin/contracts';
import { ExternalLink, FileText, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { use, useState } from 'react';
import { MethodLabel, PaymentStatusBadge, ReversalRequestDialog } from '@/components/payments';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Detail, Dialog, EmptyState, Field, PageHeader, Spinner, Table, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';

interface Payment {
  id: string;
  payment_no: string;
  amount: string;
  method: string;
  reference_no: string | null;
  cheque_bank: string | null;
  cheque_date: string | null;
  cheque_status: string | null;
  status: string;
  reconciliation_status: string;
  received_at: string;
  value_date: string;
  location_text: string | null;
  notes: string | null;
  loan_id: string;
  loan_no: string;
  loan_status: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  branch_name: string;
  advance_amount: string;
  allocations: { installment_no: number | null; component: string; amount: string; seq: number }[];
  receipt: { id: string; receipt_no: string; issued_at: string; status: string; cancelled_at: string | null; verifyUrl: string } | null;
  reversals: { id: string; reason_code: string; reason_text: string; status: string; requested_at: string; decided_at: string | null; decision_note: string | null; requested_by_name: string | null; decided_by_name: string | null }[];
  account: { code: string; name: string } | null;
  recordedByName: string | null;
  collectedByName: string | null;
  journal: { id: string; entry_no: string; entry_type: string; value_date: string; narration: string; lines: { line_no: number; code: string; name: string; debit: string; credit: string; memo: string | null }[] }[] | null;
  canRequestReversal: boolean;
  canDecideReversal: boolean;
}

const COMPONENT_LABEL: Record<string, string> = { PENALTY: 'Penal charges', FEE: 'Fees', INTEREST: 'Interest', PRINCIPAL: 'Principal', ADVANCE: 'Advance (future installments)' };

export default function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: p, loading, error, reload } = useApi<Payment>(`/payments/${id}`);
  const [reverse, setReverse] = useState(false);
  const [decide, setDecide] = useState<'approve' | 'reject' | null>(null);

  if (loading && !p) return <Spinner />;
  if (error || !p) return <EmptyState title="Payment not found" body="It may not exist, or it belongs to a loan you can’t access." />;
  const pending = p.reversals.find((r) => r.status === 'REQUESTED');

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/payments" className="hover:underline">
            Payments
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="num font-mono">{p.payment_no}</span>
            <PaymentStatusBadge status={p.status} />
          </span>
        }
        subtitle={
          <>
            <Link href={`/loans/${p.loan_id}`} className="font-medium text-ink-800 hover:underline">
              {p.customer_name} · {p.loan_no}
            </Link>{' '}
            · {p.branch_name}
          </>
        }
        actions={
          <>
            {p.receipt && (
              <a href={`/api/v1/payments/${p.id}/receipt.pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-canvas">
                <FileText className="size-4" /> Receipt PDF
              </a>
            )}
            {p.canRequestReversal && (
              <Button variant="secondary" onClick={() => setReverse(true)}>
                <Undo2 className="size-4" /> Request reversal
              </Button>
            )}
          </>
        }
      />

      {pending && (
        <div className="mb-6 rounded-lg border border-warn/30 bg-warn-soft p-4">
          <p className="text-sm font-medium text-warn">Reversal requested by {pending.requested_by_name ?? 'someone'} · {dateTime(pending.requested_at)}</p>
          <p className="mt-1 text-[13px] text-ink-800">
            {REVERSAL_REASON_LABELS[pending.reason_code as keyof typeof REVERSAL_REASON_LABELS]}: {pending.reason_text}
          </p>
          {p.canDecideReversal ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="danger" onClick={() => setDecide('approve')}>
                Approve reversal
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDecide('reject')}>
                Reject
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-muted">A different person with approval rights must decide.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader title="Payment" />
          <dl className="grid grid-cols-2 gap-4 p-5">
            <Detail label="Amount" value={<span className={`num text-lg font-semibold ${p.status === 'REVERSED' ? 'line-through' : ''}`}>{inr(p.amount)}</span>} />
            <Detail label="Received" value={dateTime(p.received_at)} />
            <Detail label="Paid by" value={<MethodLabel method={p.method} />} />
            <Detail label={p.method === 'CHEQUE' ? 'Cheque no.' : 'Reference'} value={p.reference_no} mono />
            {p.method === 'CHEQUE' && <Detail label="Cheque" value={`${p.cheque_bank}, ${date(p.cheque_date)} · ${titleCase(p.cheque_status)}`} />}
            <Detail label="Collected by" value={p.collectedByName ?? 'Branch counter / office'} />
            <Detail label="Recorded by" value={p.recordedByName} />
            <Detail label="Held in" value={p.account ? `${p.account.code} ${p.account.name}` : '—'} />
            <Detail label="Bank reconciliation" value={<Badge tone={p.reconciliation_status === 'UNRECONCILED' ? 'neutral' : 'ok'}>{titleCase(p.reconciliation_status)}</Badge>} />
            {p.location_text && <Detail label="Location" value={p.location_text} />}
            {p.notes && <Detail label="Note" value={p.notes} />}
          </dl>
          {p.receipt && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-[13px]">
              <span>
                Receipt <span className="num font-mono font-medium">{p.receipt.receipt_no}</span> · {p.receipt.status === 'CANCELLED' ? <Badge tone="bad">Cancelled</Badge> : <Badge tone="ok">Issued</Badge>}
              </span>
              <a href={p.receipt.verifyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-strong hover:underline">
                Public verification page <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="What it paid" description="Allocation is fixed when the payment is recorded and never changes." />
          <Table>
            <thead>
              <tr>
                <Th>Installment</Th>
                <Th>Component</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {p.allocations.map((a) => (
                <tr key={a.seq}>
                  <Td className="num">{a.installment_no ?? '—'}</Td>
                  <Td>{COMPONENT_LABEL[a.component] ?? a.component}</Td>
                  <Td className="num text-right">{inr(a.amount)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        {p.journal && (
          <Card className="xl:col-span-2">
            <CardHeader title="Accounting entries" />
            {p.journal.map((e) => (
              <div key={e.id} className="border-b border-line last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <p className="text-[13px] font-medium">
                    <span className="num font-mono">{e.entry_no}</span> · {e.narration}
                  </p>
                  <Badge tone={e.entry_type === 'REVERSAL' ? 'bad' : 'neutral'}>{titleCase(e.entry_type)}</Badge>
                </div>
                <Table>
                  <tbody>
                    {e.lines.map((l) => (
                      <tr key={l.line_no}>
                        <Td>
                          <span className="num font-mono text-[12px] text-muted">{l.code}</span> {l.name}
                        </Td>
                        <Td className="text-[12px] text-muted">{l.memo}</Td>
                        <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
                        <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ))}
          </Card>
        )}

        {p.reversals.length > 0 && (
          <Card className="xl:col-span-2">
            <CardHeader title="Reversal history" />
            <ul className="divide-y divide-line">
              {p.reversals.map((r) => (
                <li key={r.id} className="px-5 py-3 text-[13px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{REVERSAL_REASON_LABELS[r.reason_code as keyof typeof REVERSAL_REASON_LABELS]}</span>
                    <Badge tone={r.status === 'APPROVED' ? 'bad' : r.status === 'REJECTED' ? 'neutral' : 'warn'}>{r.status === 'APPROVED' ? 'Reversed' : titleCase(r.status)}</Badge>
                  </div>
                  <p className="text-muted">{r.reason_text}</p>
                  <p className="text-[12px] text-subtle">
                    Asked by {r.requested_by_name} · {dateTime(r.requested_at)}
                    {r.decided_at && ` · decided by ${r.decided_by_name} · ${dateTime(r.decided_at)}`}
                    {r.decision_note && ` · “${r.decision_note}”`}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {reverse && <ReversalRequestDialog payment={p} onClose={() => setReverse(false)} onDone={reload} />}
      {decide && pending && <DecideDialog reversalId={pending.id} kind={decide} amount={p.amount} onClose={() => setDecide(null)} onDone={reload} />}
    </>
  );
}

function DecideDialog({ reversalId, kind, amount, onClose, onDone }: { reversalId: string; kind: 'approve' | 'reject'; amount: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const withStepUp = useStepUp();
  const [note, setNote] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await withStepUp(() => api('POST', `/reversals/${reversalId}/${kind}`, { body: { note: note || undefined } }));
      toast('ok', kind === 'approve' ? 'Payment reversed; receipt cancelled' : 'Reversal rejected');
      onClose();
      onDone();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={kind === 'approve' ? 'Approve reversal' : 'Reject reversal'}
      description={kind === 'approve' ? `${inr(amount)} will be taken off the loan, the receipt cancelled and a mirror accounting entry posted. This cannot be undone.` : 'The payment stays as recorded.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant={kind === 'approve' ? 'danger' : 'primary'} onClick={() => go()} loading={busy}>
            {kind === 'approve' ? 'Reverse payment' : 'Reject request'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error.fieldErrors().note ?? error.message}</Alert>}
        <Field label={kind === 'approve' ? 'Note (optional)' : 'Reason'} required={kind === 'reject'}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
