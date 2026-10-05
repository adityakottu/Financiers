'use client';

import { CheckCircle2, PauseCircle, PlayCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Check { code: string; label: string; ok: boolean; detail: string; samples?: string[] }
interface Run { id: string; trigger: string; started_at: string; finished_at: string | null; ok: boolean | null; checks: Check[]; run_by_name: string | null }
interface Maintenance { enabled: boolean; message: string | null; forced: boolean }

/** System health: maintenance mode (doc 14 §3.1) and the ledger / audit integrity checks. */
export default function SystemPage() {
  const { can } = useSession();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data: m, reload: reloadM } = useApi<Maintenance>('/system/maintenance');
  const { data: runs, reload } = useApi<Run[]>(can('audit.view') ? '/integrity/runs' : null);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const [toggle, toggling] = useSubmit(async () => {
    try {
      await withStepUp(() => api('PUT', '/system/maintenance', { body: { enabled: !m!.enabled, ...(message ? { message } : {}) } }));
      toast('ok', m!.enabled ? 'Maintenance mode is off — changes allowed again' : 'Maintenance mode is on — all changes are paused');
      setMessage('');
      reloadM();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  });
  const [run, running] = useSubmit(async () => {
    try {
      const r = await api<{ ok: boolean }>('POST', '/integrity/run', { body: {} });
      toast(r.ok ? 'ok' : 'bad', r.ok ? 'All integrity checks passed' : 'An integrity check FAILED — see below and the incident runbook');
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });

  const latest = runs?.[0];
  return (
    <>
      <PageHeader title="System health" subtitle="Maintenance mode and the nightly ledger / audit integrity checks" />
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Maintenance mode"
            description="While on, every change is refused (payments, approvals, edits); people can still sign in and look things up. Use it during a restore or an investigation."
          />
          {!m ? (
            <Spinner />
          ) : (
            <div className="space-y-3 px-5 pb-5">
              <p className="flex items-center gap-2 text-[14px]">
                {m.enabled ? <PauseCircle className="size-5 text-warn" /> : <PlayCircle className="size-5 text-ok" />}
                <strong>{m.enabled ? 'On — changes are paused' : 'Off — normal operation'}</strong>
                {m.message && <span className="text-muted">“{m.message}”</span>}
              </p>
              {m.forced && <Alert tone="warn">Forced on by the server setting MAINTENANCE_MODE; it can only be switched off there.</Alert>}
              {can('settings.company') && !m.forced && (
                <div className="flex flex-wrap items-end gap-3">
                  {!m.enabled && (
                    <Field label="Message shown to users (optional)">
                      <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Restoring last night’s backup — back by 11:00" className="w-96 max-w-full" />
                    </Field>
                  )}
                  <Button variant={m.enabled ? 'primary' : 'danger'} onClick={() => toggle()} loading={toggling}>
                    {m.enabled ? 'Switch off' : 'Switch on'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>

        {can('audit.view') && (
          <Card>
            <CardHeader
              title="Integrity checks"
              description="Journal entries balance; loan balances equal the ledger; every payment is journaled, allocated and receipted; reversals mirrored; cash never negative; audit trail unaltered. Runs every night."
              actions={
                can('jobs.run') && (
                  <Button size="sm" variant="secondary" onClick={() => run()} loading={running}>
                    <RefreshCw className="size-3.5" /> Run now
                  </Button>
                )
              }
            />
            {!runs ? (
              <Spinner />
            ) : !latest ? (
              <EmptyState icon={<ShieldCheck className="size-8" />} title="No checks have run yet" body="They run after the nightly end-of-day job, or click Run now." />
            ) : (
              <>
                <div className="border-b border-line px-5 pb-4">
                  {latest.ok ? <Alert tone="ok">Last check {dateTime(latest.started_at)}: everything agrees.</Alert> : <Alert>Last check {dateTime(latest.started_at)} FAILED. Follow docs/runbooks/incident-response.md.</Alert>}
                  <ul className="mt-3 space-y-1.5 text-[13px]">
                    {latest.checks.map((c) => (
                      <li key={c.code} className="flex items-start gap-2">
                        {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-bad" />}
                        <span>
                          <span className="font-medium">{c.label}</span> — <span className="text-muted">{c.detail}</span>
                          {!c.ok && c.samples?.length ? <span className="block font-mono text-[12px] text-bad">{c.samples.slice(0, 5).join(' · ')}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <ul className="divide-y divide-line text-[13px]">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center justify-between px-5 py-2 text-left hover:bg-canvas">
                        <span>
                          {dateTime(r.started_at)} · {r.trigger === 'NIGHTLY' ? 'nightly' : r.trigger === 'CLI' ? 'command line' : `by ${r.run_by_name ?? '—'}`}
                        </span>
                        <Badge tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'passed' : 'failed'}</Badge>
                      </button>
                      {open === r.id && (
                        <ul className="space-y-1 px-8 pb-3 text-[12px] text-muted">
                          {r.checks.map((c) => (
                            <li key={c.code}>
                              {c.ok ? '✓' : '✗'} {c.label} — {c.detail}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
