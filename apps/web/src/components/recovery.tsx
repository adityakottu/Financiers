'use client';

import { useState } from 'react';
import { useStepUp } from './step-up';
import { useToast } from './toast';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from './ui';
import { api, ApiError } from '@/lib/api';
import { useSubmit } from '@/lib/hooks';

export const STAGE_TONE = (code: string): 'neutral' | 'info' | 'warn' | 'bad' | 'ok' =>
  code === 'RESOLVED' ? 'ok' : code === 'WRITTEN_OFF' ? 'neutral' : code === 'REPOSSESSION' ? 'bad' : code === 'ESCALATED' || code === 'SETTLEMENT' ? 'warn' : 'info';

/**
 * One form dialog for every recovery action: fields, a submit that may need step-up, and the
 * server's message shown in place (never swallowed).
 */
export function ActionDialog({
  title,
  description,
  action,
  fields,
  onClose,
  onDone,
  submit,
  stepUp,
  danger,
}: {
  title: string;
  description?: string;
  action: string;
  fields: { key: string; label: string; type?: 'text' | 'textarea' | 'date' | 'money' | 'select'; options?: { value: string; label: string }[]; hint?: string; required?: boolean; initial?: string }[];
  onClose: () => void;
  onDone: () => void;
  submit: (v: Record<string, string>) => Promise<unknown>;
  stepUp?: boolean;
  danger?: boolean;
}) {
  const toast = useToast();
  const withStepUp = useStepUp();
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])));
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
      await (stepUp ? withStepUp(() => submit(body)) : submit(body));
      toast('ok', `${action} — done`);
      onDone();
      onClose();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  const missing = fields.some((f) => f.required && !v[f.key]);
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
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => go()} loading={busy} disabled={missing}>
            {action}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} error={fe[f.key]} required={f.required}>
            {f.type === 'textarea' ? (
              <Textarea rows={3} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            ) : f.type === 'select' ? (
              <Select value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                <option value="">Choose…</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'money' ? 'decimal' : undefined}
                className={f.type === 'money' ? 'num' : undefined}
                value={v[f.key]}
                onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
    </Dialog>
  );
}

export const post = (path: string) => (body: Record<string, string>) => api('POST', path, { body });
