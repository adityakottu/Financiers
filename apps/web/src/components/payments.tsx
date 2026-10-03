'use client';

import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PaymentMethod, REVERSAL_REASON_LABELS, REVERSAL_REASONS } from '@fin/contracts';
import { AlertTriangle, CheckCircle2, FileText, Landmark, Smartphone, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, get, newIdempotencyKey } from '@/lib/api';
import { date, inr } from '@/lib/format';
import { useDebounced, useSubmit } from '@/lib/hooks';
import { todayIST } from './lending';
import { useToast } from './toast';
import { Alert, Badge, Button, Checkbox, cx, Dialog, Field, Input, Select, Spinner, Textarea } from './ui';

export const METHOD_ICON: Record<PaymentMethod, React.ComponentType<{ className?: string }>> = { CASH: Wallet, UPI: Smartphone, BANK_TRANSFER: Landmark, CHEQUE: FileText };

export function PaymentStatusBadge({ status }: { status: string }) {
  const t = { POSTED: ['ok', 'Posted'], REVERSAL_PENDING: ['warn', 'Reversal pending'], REVERSED: ['bad', 'Reversed'] }[status] ?? ['neutral', status];
  return <Badge tone={t[0] as 'ok'}>{t[1]}</Badge>;
}

export function MethodLabel({ method, reference }: { method: string; reference?: string | null }) {
  const Icon = METHOD_ICON[method as PaymentMethod] ?? Wallet;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 text-subtle" />
      {PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method}
      {reference && <span className="num font-mono text-[12px] text-muted">{reference}</span>}
    </span>
  );
}

export interface CollectTarget {
  id: string;
  loan_no: string;
  customer_name: string;
  overdue_amount: string;
  due_today?: string;
  next_due_date?: string | null;
  next_due_amount?: string | null;
  installment_amount?: string;
  balance_payable?: string;
  advance_balance?: string;
}

interface Preview {
  amount: string;
  fullSettlement: boolean;
  components: Record<'penalty' | 'fee' | 'interest' | 'principal' | 'advance', string>;
  installmentsCleared: number[];
  installmentsPart: number[];
  balanceAfter: string;
  nextDue: { date: string; amount: string; installmentNo: number } | null;
}

interface BankOption {
  id: string;
  code: string;
  name: string;
  bank_name: string;
  account_no_last4: string | null;
}

export interface PaymentResult extends Preview {
  id: string;
  paymentNo: string;
  receiptNo: string;
  verifyUrl: string;
  method: string;
  loanClosed: boolean;
  messages: { status: string; reason?: string }[];
}

/** Plain-language summary of what a payment settles (doc 08 §7). */
export function allocationSentence(p: Pick<Preview, 'installmentsCleared' | 'installmentsPart' | 'components' | 'fullSettlement'>) {
  const parts: string[] = [];
  if (p.fullSettlement) parts.push('Settles the whole loan.');
  if (p.installmentsCleared.length) parts.push(`Clears installment ${p.installmentsCleared.join(', ')}.`);
  if (p.installmentsPart.length) parts.push(`Part-pays installment ${p.installmentsPart.join(', ')}.`);
  if (Number(p.components.advance) > 0) parts.push(`${inr(p.components.advance)} kept as advance for the next installment.`);
  return parts.join(' ');
}

function Components({ c }: { c: Preview['components'] }) {
  const rows: [string, string][] = [
    ['Penal charges', c.penalty],
    ['Fees', c.fee],
    ['Interest', c.interest],
    ['Principal', c.principal],
    ['Advance', c.advance],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
      {rows
        .filter(([, v]) => Number(v) > 0)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="num text-right">{inr(v)}</dd>
          </div>
        ))}
    </dl>
  );
}

/**
 * Collect a payment: amount (with quick picks), method, reference, a live preview of exactly what
 * it settles, then a receipt. One idempotency key per dialog, so double taps and retries record once.
 */
export function CollectDialog({ loan, onClose, onDone }: { loan: CollectTarget; onClose: () => void; onDone: (r: PaymentResult) => void }) {
  const toast = useToast();
  const key = useRef(newIdempotencyKey());
  const overdue = Number(loan.overdue_amount);
  const dueToday = Number(loan.due_today ?? 0);
  const quick: [string, number][] = (
    [
      ['Overdue', overdue],
      ['Overdue + today', overdue + dueToday],
      ['Next installment', Number(loan.next_due_amount ?? 0)],
      ['One installment', Number(loan.installment_amount ?? 0)],
    ] as [string, number][]
  ).filter(([, v], i, all) => v > 0 && all.findIndex(([, x]) => x === v) === i);
  const [amount, setAmount] = useState(quick[0] ? quick[0][1].toFixed(2) : '');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [reference, setReference] = useState('');
  const [accountId, setAccountId] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDate, setChequeDate] = useState(todayIST());
  const [atCounter, setAtCounter] = useState(false);
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);
  const debounced = useDebounced(amount, 350);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!/^\d+(\.\d{1,2})?$/.test(debounced) || Number(debounced) <= 0) return;
    const ctrl = new AbortController();
    api<Preview>('POST', `/loans/${loan.id}/payments/preview`, { body: { amount: debounced }, signal: ctrl.signal })
      .then(setPreview)
      .catch((e) => (e as Error).name !== 'AbortError' && setPreviewError(e as ApiError));
    return () => ctrl.abort();
  }, [debounced, loan.id]);

  useEffect(() => {
    if (method === 'BANK_TRANSFER' && banks === null) {
      get<{ data: BankOption[] }>(`/loans/${loan.id}/payments/accounts`)
        .then((r) => {
          setBanks(r.data);
          if (r.data[0]) setAccountId((a) => a || r.data[0]!.id);
        })
        .catch(() => setBanks([]));
    }
  }, [method, banks, loan.id]);

  const [submit, busy] = useSubmit(async (confirmDuplicate: boolean) => {
    setError(null);
    try {
      const r = await api<PaymentResult>('POST', `/loans/${loan.id}/payments`, {
        idempotencyKey: key.current,
        body: {
          amount,
          method,
          reference: method === 'CASH' ? undefined : reference,
          accountId: method === 'BANK_TRANSFER' ? accountId : undefined,
          chequeBank: method === 'CHEQUE' ? chequeBank : undefined,
          chequeDate: method === 'CHEQUE' ? chequeDate : undefined,
          atCounter: method === 'CASH' ? atCounter : false,
          notes: notes || undefined,
          confirmDuplicate,
          notify,
        },
      });
      setResult(r);
      setDuplicate(null);
      toast('ok', `₹${Number(r.amount).toLocaleString('en-IN')} recorded · receipt ${r.receiptNo}`);
      onDone(r);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'POSSIBLE_DUPLICATE') setDuplicate(err.message);
      else setError(err);
    }
  });

  const fe = error?.fieldErrors() ?? {};
  const max = previewError?.code === 'EXCEEDS_BALANCE' ? (previewError.details as unknown as { maxAmount?: string } | undefined)?.maxAmount : undefined;

  if (result) {
    return (
      <Dialog open onClose={onClose} title="Payment recorded">
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-12 text-ok" />
          <div>
            <p className="num text-3xl font-semibold text-ink-950">{inr(result.amount)}</p>
            <p className="mt-1 text-[13px] text-muted">
              {loan.customer_name} · {loan.loan_no}
            </p>
            <p className="num mt-1 font-mono text-[13px]">Receipt {result.receiptNo}</p>
          </div>
          <p className="text-sm text-ink-800">{allocationSentence(result)}</p>
          <div className="rounded-lg bg-canvas p-3 text-left">
            <Components c={result.components} />
          </div>
          {result.loanClosed ? (
            <Alert tone="ok">Loan fully repaid and closed.</Alert>
          ) : (
            <p className="text-[13px] text-muted">
              Balance {inr(result.balanceAfter)}
              {result.nextDue ? ` · next ${inr(result.nextDue.amount)} due ${date(result.nextDue.date)}` : ''}
            </p>
          )}
          {result.messages.some((m) => m.status === 'SKIPPED') && (
            <p className="text-[12px] text-subtle">{result.messages.filter((m) => m.reason).map((m) => m.reason).join('; ')}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <a href={`/api/v1/payments/${result.id}/receipt.pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-canvas">
              <FileText className="size-4" /> Open receipt
            </a>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Collect · ${loan.loan_no}`}
      description={`${loan.customer_name}${overdue > 0 ? ` · ${inr(loan.overdue_amount)} overdue` : ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit(false)} loading={busy} disabled={!preview || !!duplicate}>
            Record {preview ? inr(preview.amount) : 'payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        {duplicate && (
          <div className="space-y-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-[13px] text-warn" role="alert">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {duplicate}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDuplicate(null)}>
                No, go back
              </Button>
              <Button size="sm" onClick={() => submit(true)} loading={busy}>
                Yes, it is a separate payment
              </Button>
            </div>
          </div>
        )}

        <Field label="Amount received (₹)" required error={fe.amount}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} className="num h-12 text-lg font-semibold" autoFocus />
        </Field>
        {quick.length > 0 && (
          <div className="-mt-2 flex flex-wrap gap-2">
            {quick.map(([label, v]) => (
              <button key={label} type="button" onClick={() => setAmount(v.toFixed(2))} className={cx('rounded-full border px-3 py-1 text-[12px]', Number(amount) === v ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line hover:bg-canvas')}>
                {label} <span className="num">{inr(v.toFixed(2), { decimals: false })}</span>
              </button>
            ))}
          </div>
        )}

        <div className="min-h-[52px] rounded-md bg-canvas px-3 py-2 text-[13px]" aria-live="polite">
          {previewError ? (
            <p className="text-bad">
              {previewError.message}
              {max && (
                <button type="button" className="ml-2 underline" onClick={() => setAmount(max)}>
                  Use {inr(max)}
                </button>
              )}
            </p>
          ) : preview ? (
            <>
              <p className="font-medium text-ink-900">{allocationSentence(preview) || 'Applied to dues.'}</p>
              <p className="text-muted">
                Balance after: {inr(preview.balanceAfter)}
                {preview.nextDue ? ` · next ${inr(preview.nextDue.amount)} due ${date(preview.nextDue.date)}` : ''}
              </p>
            </>
          ) : amount ? (
            <Spinner label="Checking" />
          ) : (
            <p className="text-muted">Enter the amount to see what it pays.</p>
          )}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-800">Paid by</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PAYMENT_METHODS.map((m) => {
              const Icon = METHOD_ICON[m];
              return (
                <label key={m} className={cx('flex cursor-pointer items-center justify-center gap-2 rounded-md border px-2 py-2.5 text-[13px] font-medium', method === m ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line hover:bg-canvas')}>
                  <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} className="sr-only" />
                  <Icon className="size-4" /> {PAYMENT_METHOD_LABELS[m]}
                </label>
              );
            })}
          </div>
        </fieldset>

        {method === 'CASH' && <Checkbox label="Received at the branch counter (not in the field)" checked={atCounter} onChange={(e) => setAtCounter(e.target.checked)} />}
        {method !== 'CASH' && (
          <Field label={method === 'CHEQUE' ? 'Cheque number' : method === 'UPI' ? 'UPI transaction ID' : 'UTR / reference'} required error={fe.reference}>
            <Input value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} className="num font-mono uppercase" autoCapitalize="characters" />
          </Field>
        )}
        {method === 'BANK_TRANSFER' && (
          <Field label="Received into" required error={fe.accountId}>
            {banks === null ? (
              <Spinner />
            ) : banks.length === 0 ? (
              <Alert tone="warn">No company bank account is set up. An accountant can add one under Accounts.</Alert>
            ) : (
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.account_no_last4 ? ` (…${b.account_no_last4})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {method === 'CHEQUE' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bank" required error={fe.chequeBank}>
              <Input value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} />
            </Field>
            <Field label="Cheque date" required error={fe.chequeDate}>
              <Input type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Note" hint="Optional">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
        <Checkbox label="Send the customer an SMS / WhatsApp confirmation" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
      </div>
    </Dialog>
  );
}

export function ReversalRequestDialog({ payment, onClose, onDone }: { payment: { id: string; payment_no: string; amount: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reasonCode, setReasonCode] = useState<string>('WRONG_AMOUNT');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', `/payments/${payment.id}/reversal`, { body: { reasonCode, reasonText } });
      toast('ok', 'Reversal requested — another person must approve it');
      onClose();
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reverse ${payment.payment_no}`}
      description={`${inr(payment.amount)}. Payments are never edited: a wrong payment is reversed and recorded again. A second person must approve.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button variant="danger" onClick={() => go()} loading={busy}>
            Request reversal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        <Field label="Reason" required error={fe.reasonCode}>
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            {REVERSAL_REASONS.filter((r) => r !== 'CHEQUE_BOUNCED').map((r) => (
              <option key={r} value={r}>
                {REVERSAL_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What happened" required error={fe.reasonText}>
          <Textarea rows={3} value={reasonText} onChange={(e) => setReasonText(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}
