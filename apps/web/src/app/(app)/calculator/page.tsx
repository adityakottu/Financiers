'use client';

import type { Schedule } from '@fin/loan-engine';
import { Calculator } from 'lucide-react';
import { useEffect, useState } from 'react';
import { defaultFirstDue, FREQUENCY_LABELS, METHOD_LABELS, ScheduleTable, ScheduleTotals, todayIST } from '@/components/lending';
import { Alert, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';

export default function CalculatorPage() {
  const today = todayIST();
  const [v, setV] = useState({
    method: 'FLAT',
    principal: '100000',
    annualRate: '24',
    frequency: 'MONTHLY',
    numInstallments: '12',
    customIntervalDays: '10',
    disbursementDate: today,
    firstDueDate: defaultFirstDue(today, 'MONTHLY'),
    roundingUnit: '1',
    processingPct: '0',
    gst: true,
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((p) => ({ ...p, [k]: e.target.value }));
  const input = useDebounced(v, 300);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const feeRules =
      Number(input.processingPct) > 0
        ? [{ code: 'PROCESSING', label: 'Processing fee', basis: 'PCT_OF_PRINCIPAL', value: input.processingPct, gstRatePct: input.gst ? '18' : '0', mode: 'DEDUCT_FROM_DISBURSAL' }]
        : [];
    api<{ schedule: Schedule }>('POST', '/loans/calculator', {
      signal: ctrl.signal,
      body: {
        method: input.method,
        principal: input.principal,
        annualRate: input.annualRate,
        frequency: input.frequency,
        numInstallments: input.numInstallments,
        customIntervalDays: input.frequency === 'CUSTOM' ? input.customIntervalDays : undefined,
        disbursementDate: input.disbursementDate,
        firstDueDate: input.firstDueDate,
        roundingUnit: input.roundingUnit,
        feeRules,
      },
    })
      .then((r) => {
        setSchedule(r.schedule);
        setError(null);
      })
      .catch((e) => (e as Error).name !== 'AbortError' && setError(e as ApiError))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [input]);

  const fe = error?.fieldErrors() ?? {};

  return (
    <>
      <PageHeader title="Loan calculator" subtitle="Try any amount, rate and method. The same engine produces every real loan’s schedule." />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[360px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Terms" />
          <div className="grid gap-4 p-5">
            <Field label="Interest method">
              <Select value={v.method} onChange={set('method')}>
                {Object.entries(METHOD_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Loan amount (₹)" error={fe.principal}>
                <Input value={v.principal} onChange={set('principal')} inputMode="decimal" className="num" />
              </Field>
              <Field label="Rate (% p.a.)" error={fe.annualRate}>
                <Input value={v.annualRate} onChange={set('annualRate')} inputMode="decimal" className="num" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Frequency">
                <Select
                  value={v.frequency}
                  onChange={(e) => setV((p) => ({ ...p, frequency: e.target.value, firstDueDate: defaultFirstDue(p.disbursementDate, e.target.value, Number(p.customIntervalDays)) }))}
                >
                  {Object.entries(FREQUENCY_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Installments" error={fe.numInstallments}>
                <Input value={v.numInstallments} onChange={set('numInstallments')} inputMode="numeric" className="num" />
              </Field>
            </div>
            {v.frequency === 'CUSTOM' && (
              <Field label="Days between installments">
                <Input value={v.customIntervalDays} onChange={set('customIntervalDays')} inputMode="numeric" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Disbursement" error={fe.disbursementDate}>
                <Input type="date" value={v.disbursementDate} onChange={set('disbursementDate')} />
              </Field>
              <Field label="First due" error={fe.firstDueDate}>
                <Input type="date" value={v.firstDueDate} onChange={set('firstDueDate')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Round installment to">
                <Select value={v.roundingUnit} onChange={set('roundingUnit')}>
                  <option value="0.01">Paise</option>
                  <option value="1">₹1</option>
                  <option value="10">₹10</option>
                </Select>
              </Field>
              <Field label="Processing fee (%)" hint="Deducted at disbursal">
                <Input value={v.processingPct} onChange={set('processingPct')} inputMode="decimal" className="num" />
              </Field>
            </div>
            <Checkbox label="Add 18% GST on fee ⚖" checked={v.gst} onChange={(e) => setV((p) => ({ ...p, gst: e.target.checked }))} />
          </div>
        </Card>

        <div className="min-w-0 space-y-5">
          {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
          {!schedule ? (
            loading ? <Spinner label="Calculating" /> : <EmptyState icon={<Calculator className="size-8" />} title="Enter terms to see the schedule" />
          ) : (
            <div className={loading ? 'opacity-60 transition-opacity' : undefined}>
              <ScheduleTotals s={schedule} />
              <p className="mt-3 text-[13px] text-muted">
                {METHOD_LABELS[schedule.terms.method]} at {Number(schedule.terms.annualRate)}% p.a. —{' '}
                {schedule.rows.length} {FREQUENCY_LABELS[schedule.terms.frequency]!.toLowerCase()} installments. The APR shows the real yearly cost including fees and the payment timing.
              </p>
              <Card className="mt-5">
                <CardHeader title="Repayment schedule" />
                <ScheduleTable rows={schedule.rows} />
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
