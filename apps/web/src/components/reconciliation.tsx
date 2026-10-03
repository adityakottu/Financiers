'use client';

import { DIFFERENCE_REASON_LABELS, DIFFERENCE_REASONS, DIFFERENCE_RESOLUTION_LABELS } from '@fin/contracts';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useStepUp } from './step-up';
import { useToast } from './toast';
import { Alert, Badge, Button, Dialog, Field, Input, Select, Spinner, Textarea } from './ui';

export interface Figures { opening: string; collected: string; reversed: string; deposited: string; expenses: string; other: string; expected: string; adjustments: string }
interface Difference { id: string; amount: string; direction: string; reason_code: string; resolution: string; notes: string; status: string; recorded_by_name: string; decided_by_name: string | null; recorded_at: string; decision_note: string | null }
export interface SettlementView {
  employee: { id: string; name: string; code: string; branchId: string };
  date: string;
  dayClosed: boolean;
  figures: Figures;
  collections: Record<'cash' | 'upi' | 'bank' | 'cheque', { total: string; count: number; matched: number }> & { total: string };
  settlement: { id: string; status: string; declared_cash: string | null; declared_by_name: string | null; declared_at: string | null; counted_cash: string | null; counted_by_name: string | null; counted_at: string | null; difference: string | null; expected_cash: string | null } | null;
  status: string;
  stale: boolean;
  differences: Difference[];
  threshold: string;
  can: { declare: boolean; count: boolean; approve: boolean };
}

export const SETTLEMENT_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = { MATCHED: 'ok', APPROVED: 'ok', SHORT: 'bad', EXCESS: 'bad', SUBMITTED: 'info', OPEN: 'warn', NOTHING_TO_SETTLE: 'neutral' };
export const SETTLEMENT_LABEL: Record<string, string> = { MATCHED: 'Matched', APPROVED: 'Difference approved', SHORT: 'Short', EXCESS: 'Excess', SUBMITTED: 'Declared — to count', OPEN: 'Not counted', NOTHING_TO_SETTLE: 'Nothing to settle' };

export function CashLines({ f }: { f: Figures }) {
  const rows: [string, string, string?][] = [
    ['Opening cash', f.opening],
    ['+ Cash collected', f.collected],
    ['− Payments reversed', f.reversed],
    ['− Deposited / handed over', f.deposited],
    ['− Expenses paid', f.expenses],
    ...(Number(f.other) ? [['± Other', f.other] as [string, string]] : []),
  ];
  return (
    <dl className="space-y-1 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between">
          <dt className="text-muted">{k}</dt>
          <dd className="num">{inr(v)}</dd>
        </div>
      ))}
      <div className="flex justify-between border-t border-line pt-1 font-semibold">
        <dt>Expected cash in hand</dt>
        <dd className="num">{inr(f.expected)}</dd>
      </div>
      {Number(f.adjustments) !== 0 && (
        <div className="flex justify-between text-[12px] text-muted">
          <dt>Approved difference adjustments</dt>
          <dd className="num">{inr(f.adjustments)}</dd>
        </div>
      )}
    </dl>
  );
}

/** One employee's cash for one day: figures from the ledger, the count, differences and approvals. */
export function SettlementDialog({ employeeId, day, onClose, onChanged }: { employeeId: string; day: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data: s, reload } = useApi<SettlementView>(`/reconciliation/settlements/${employeeId}/${day}`);
  const [counted, setCounted] = useState('');
  const [diff, setDiff] = useState({ amount: '', reasonCode: 'COUNTING_ERROR', resolution: '', notes: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const done = (msg: string) => {
    toast('ok', msg);
    reload();
    onChanged();
  };
  const [count, counting] = useSubmit(async () => {
    setError(null);
    try {
      const r = await api<{ status: string; difference: string }>('POST', `/reconciliation/settlements/${employeeId}/${day}/count`, { body: { countedCash: counted } });
      done(r.status === 'MATCHED' ? 'Cash matches the books' : `Cash is ${r.status.toLowerCase()} by ${inr(r.difference.replace('-', ''))}`);
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const [explain, explaining] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', `/reconciliation/settlements/${s!.settlement!.id}/differences`, { body: diff });
      setDiff({ amount: '', reasonCode: 'COUNTING_ERROR', resolution: '', notes: '' });
      done('Explanation recorded — waiting for approval');
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const [decide, deciding] = useSubmit(async (id: string, approve: boolean) => {
    setError(null);
    try {
      if (approve) await withStepUp(() => api('POST', `/reconciliation/differences/${id}/approve`, { body: {} }));
      else await api('POST', `/reconciliation/differences/${id}/reject`, { body: { reason: 'Explanation not accepted' } });
      done(approve ? 'Difference approved' : 'Explanation rejected');
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    }
  });
  if (!s) return null;
  const st = s.settlement;
  const short = s.status === 'SHORT';
  const resolutions = short ? ['CARRY_FORWARD', 'RECOVER_FROM_EMPLOYEE', 'WRITE_OFF'] : ['CASH_EXCESS_INCOME', 'TO_SUSPENSE'];
  const fe = error?.fieldErrors() ?? {};
  const open = Number(st?.difference ?? 0) === 0 ? 0 : Math.abs(Number(st!.difference)) - s.differences.filter((d) => d.status !== 'REJECTED').reduce((a, d) => a + Number(d.amount), 0);
  return (
    <Dialog open wide onClose={onClose} title={`${s.employee.name} · ${date(s.date)}`} description="Cash expected from the books, counted by someone else, and every difference explained and approved.">
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={SETTLEMENT_TONE[s.status]}>{SETTLEMENT_LABEL[s.status] ?? s.status}</Badge>
          {s.stale && <Badge tone="warn">Cash moved after counting — count again</Badge>}
          {s.dayClosed && <Badge>Day closed</Badge>}
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg bg-canvas p-3">
            <CashLines f={s.figures} />
          </div>
          <div className="space-y-2 text-[13px]">
            <p className="font-medium">Collected that day</p>
            {(['upi', 'bank', 'cheque'] as const).map((k) =>
              s.collections[k].count ? (
                <p key={k} className="flex justify-between">
                  <span className="text-muted">{k === 'upi' ? 'UPI' : k === 'bank' ? 'Bank transfer' : 'Cheque'}</span>
                  <span>
                    <span className="num">{inr(s.collections[k].total)}</span> <span className="text-[12px] text-muted">({s.collections[k].matched}/{s.collections[k].count} confirmed by bank)</span>
                  </span>
                </p>
              ) : null,
            )}
            <p className="flex justify-between">
              <span className="text-muted">Cash</span>
              <span className="num">{inr(s.collections.cash.total)}</span>
            </p>
            {st?.declared_cash && (
              <p className="border-t border-line pt-2 text-muted">
                Declared {inr(st.declared_cash)} by {st.declared_by_name} · {dateTime(st.declared_at)}
              </p>
            )}
            {st?.counted_cash && (
              <p className="text-muted">
                Counted <span className="num font-medium text-ink-900">{inr(st.counted_cash)}</span> by {st.counted_by_name} · {dateTime(st.counted_at)}
                {Number(st.difference) !== 0 && <span className="text-bad"> · {Number(st.difference) > 0 ? 'short' : 'excess'} {inr(st.difference!.replace('-', ''))}</span>}
              </p>
            )}
          </div>
        </div>

        {s.can.count && !s.dayClosed && s.status !== 'APPROVED' && (
          <div className="flex items-end gap-2 rounded-md border border-line p-3">
            <Field label="Cash counted (₹)" error={fe.countedCash}>
              <Input inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} className="num" placeholder={s.figures.expected} />
            </Field>
            <Button onClick={() => count()} loading={counting} disabled={!counted}>
              {st?.counted_cash ? 'Count again' : 'Record count'}
            </Button>
          </div>
        )}

        {s.differences.length > 0 && (
          <ul className="divide-y divide-line rounded-md border border-line">
            {s.differences.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 p-3 text-[13px] sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">
                    {inr(d.amount)} {d.direction.toLowerCase()} · {DIFFERENCE_REASON_LABELS[d.reason_code as keyof typeof DIFFERENCE_REASON_LABELS]} → {DIFFERENCE_RESOLUTION_LABELS[d.resolution as keyof typeof DIFFERENCE_RESOLUTION_LABELS]}
                  </p>
                  <p className="text-muted">{d.notes}</p>
                  <p className="text-[12px] text-subtle">
                    by {d.recorded_by_name} · {dateTime(d.recorded_at)}
                    {d.decided_by_name && ` · ${d.status.toLowerCase()} by ${d.decided_by_name}`}
                    {d.decision_note && ` — ${d.decision_note}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={d.status === 'APPROVED' ? 'ok' : d.status === 'REJECTED' ? 'neutral' : 'warn'}>{titleCase(d.status)}</Badge>
                  {d.status === 'PENDING' && s.can.approve && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => decide(d.id, false)} loading={deciding}>
                        Reject
                      </Button>
                      <Button size="sm" onClick={() => decide(d.id, true)} loading={deciding}>
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {Number(d0(open)) > 0 && ['SHORT', 'EXCESS'].includes(s.status) && s.can.count && (
          <div className="space-y-3 rounded-md border border-warn/30 bg-warn-soft/40 p-3">
            <p className="text-[13px] font-medium">Explain {inr(open.toFixed(2))} {short ? 'short' : 'excess'} (differences above {inr(s.threshold, { decimals: false })} need Management)</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Amount (₹)" error={fe.amount}>
                <Input inputMode="decimal" value={diff.amount} onChange={(e) => setDiff({ ...diff, amount: e.target.value })} placeholder={open.toFixed(2)} className="num" />
              </Field>
              <Field label="Reason">
                <Select value={diff.reasonCode} onChange={(e) => setDiff({ ...diff, reasonCode: e.target.value, resolution: e.target.value === 'PENDING_DEPOSIT' ? 'CARRY_FORWARD' : diff.resolution === 'CARRY_FORWARD' ? '' : diff.resolution })}>
                  {DIFFERENCE_REASONS.filter((r) => short || r !== 'PENDING_DEPOSIT').map((r) => (
                    <option key={r} value={r}>
                      {DIFFERENCE_REASON_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Resolution" error={fe.resolution}>
                <Select value={diff.resolution} onChange={(e) => setDiff({ ...diff, resolution: e.target.value })}>
                  <option value="">Choose…</option>
                  {resolutions
                    .filter((r) => (diff.reasonCode === 'PENDING_DEPOSIT') === (r === 'CARRY_FORWARD'))
                    .map((r) => (
                      <option key={r} value={r}>
                        {DIFFERENCE_RESOLUTION_LABELS[r as keyof typeof DIFFERENCE_RESOLUTION_LABELS]}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Field label="What happened" error={fe.notes}>
              <Textarea rows={2} value={diff.notes} onChange={(e) => setDiff({ ...diff, notes: e.target.value })} />
            </Field>
            <div className="flex justify-end">
              <Button onClick={() => explain()} loading={explaining} disabled={!diff.amount || !diff.resolution}>
                Record explanation
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
const d0 = (n: number) => n.toFixed(2);

/** Collector's own end-of-day: expected cash and a declaration. */
export function MyCashCard({ employeeId, day }: { employeeId: string; day: string }) {
  const toast = useToast();
  const { data: s, reload } = useApi<SettlementView>(`/reconciliation/settlements/${employeeId}/${day}`);
  const [cash, setCash] = useState('');
  const [declare, busy] = useSubmit(async () => {
    try {
      await api('POST', `/reconciliation/settlements/${employeeId}/${day}/declare`, { body: { declaredCash: cash } });
      toast('ok', 'Cash declared — your manager or accountant will count it');
      setCash('');
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  if (!s) return <Spinner />;
  const st = s.settlement;
  return (
    <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
      <div className="rounded-lg bg-canvas p-3">
        <CashLines f={s.figures} />
      </div>
      <div className="space-y-3 text-[13px]">
        <Badge tone={SETTLEMENT_TONE[s.status]}>{SETTLEMENT_LABEL[s.status] ?? s.status}</Badge>
        {st?.declared_cash && <p className="text-muted">You declared {inr(st.declared_cash)} at {dateTime(st.declared_at)}.</p>}
        {st?.counted_cash && (
          <p className="text-muted">
            Counted {inr(st.counted_cash)} by {st.counted_by_name}.{Number(st.difference) !== 0 && ` Difference ${inr(st.difference!.replace('-', ''))} ${Number(st.difference) > 0 ? 'short' : 'excess'} — your manager will discuss it with you.`}
          </p>
        )}
        {!s.dayClosed && ['OPEN', 'SUBMITTED'].includes(s.status) && (
          <div className="flex items-end gap-2">
            <Field label="Cash in my hand now (₹)">
              <Input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} className="num" placeholder={s.figures.expected} />
            </Field>
            <Button onClick={() => declare()} loading={busy} disabled={!cash}>
              Declare
            </Button>
          </div>
        )}
        {s.dayClosed && <p className="text-muted">The day is closed for your branch.</p>}
      </div>
    </div>
  );
}
