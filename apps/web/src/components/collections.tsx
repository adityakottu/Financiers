'use client';

import { VISIT_OUTCOME_LABELS, VISIT_OUTCOMES } from '@fin/contracts';
import { MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSubmit } from '@/lib/hooks';
import { todayIST } from './lending';
import { useToast } from './toast';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from './ui';

/** Reminder through the official SMS API (never a personal WhatsApp). */
export function RemindButton({ loanId, name, overdue }: { loanId: string; name: string; overdue: boolean }) {
  const toast = useToast();
  const [send, busy] = useSubmit(async () => {
    try {
      const r = await api<{ status: string; reason?: string }>('POST', `/loans/${loanId}/messages`, { body: { channel: 'SMS', eventCode: overdue ? 'OVERDUE' : 'DUE_REMINDER' } });
      toast(r.status === 'SKIPPED' ? 'bad' : 'ok', r.status === 'SKIPPED' ? `Not sent: ${r.reason}` : `Reminder SMS queued for ${name}`);
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  return (
    <button onClick={() => send()} disabled={busy} className="grid size-11 place-items-center rounded-md border border-line-strong text-ink-700 hover:bg-canvas disabled:opacity-50" aria-label={`Send reminder SMS to ${name}`}>
      <MessageSquare className="size-4" />
    </button>
  );
}

export function VisitDialog({ card, onClose, onDone }: { card: { id: string; customer_name: string; loan_no: string }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<string>('NOT_AVAILABLE');
  const [notes, setNotes] = useState('');
  const [promisedAmount, setPromisedAmount] = useState('');
  const [promisedDate, setPromisedDate] = useState(todayIST());
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', `/loans/${card.id}/visits`, { body: { outcome, notes: notes || undefined, ...(outcome === 'PROMISED' ? { promisedAmount, promisedDate } : {}) } });
      toast('ok', 'Visit recorded');
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
      title="Record visit"
      description={`${card.customer_name} · ${card.loan_no}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy}>
            Save visit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        <Field label="What happened" required>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {VISIT_OUTCOMES.filter((o) => o !== 'PAID' && o !== 'PARTIAL').map((o) => (
              <option key={o} value={o}>
                {VISIT_OUTCOME_LABELS[o]}
              </option>
            ))}
          </Select>
        </Field>
        {outcome === 'PROMISED' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Promised amount (₹)" required error={fe.promisedAmount}>
              <Input inputMode="decimal" value={promisedAmount} onChange={(e) => setPromisedAmount(e.target.value)} className="num" />
            </Field>
            <Field label="By date" required error={fe.promisedDate}>
              <Input type="date" min={todayIST()} value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Notes" hint="Optional">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
        <p className="text-[12px] text-subtle">Payments are recorded with “Collect”; visits are for when nothing (or not enough) was collected.</p>
      </div>
    </Dialog>
  );
}
