'use client';

import { ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError, restrictionRoute } from '@/lib/api';

function MfaForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/mfa/verify', { body: { code: code.trim() }, noAuthRedirect: true });
      const me = await api<{ restriction: string | null }>('GET', '/auth/me', { noAuthRedirect: true });
      const next = params.get('next');
      router.replace(restrictionRoute(me.restriction) ?? (next?.startsWith('/') && !next.startsWith('//') ? next : '/'));
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 401 && e.code !== 'INVALID_CODE') {
        router.replace('/login');
        return;
      }
      setError(e.message);
      setCode('');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-6 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
        <ShieldCheck className="size-5" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Two-step verification</h1>
      <p className="mt-1 text-sm text-muted">
        {useRecovery ? 'Enter one of your saved recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label={useRecovery ? 'Recovery code' : 'Code'}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            maxLength={useRecovery ? 11 : 6}
            placeholder={useRecovery ? 'xxxxx-xxxxx' : '000000'}
            className="num text-center text-lg tracking-[0.3em]"
            autoFocus
            required
          />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Verify
        </Button>
      </form>
      <button type="button" onClick={() => setUseRecovery((r) => !r)} className="mt-6 w-full text-center text-[13px] text-ink-700 hover:underline">
        {useRecovery ? 'Use authenticator code instead' : 'Lost your phone? Use a recovery code'}
      </button>
    </>
  );
}

export default function MfaPage() {
  return (
    <Suspense>
      <MfaForm />
    </Suspense>
  );
}
