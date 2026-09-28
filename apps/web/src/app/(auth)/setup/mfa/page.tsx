'use client';

import { Copy, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RecoveryCodes } from '@/components/recovery-codes';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

interface Setup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export default function SetupMfaPage() {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Setup>('POST', '/auth/mfa/setup')
      .then(setSetup)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ recoveryCodes: string[] }>('POST', '/auth/mfa/enable', { body: { code: code.trim() } });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError((err as ApiError).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Save your recovery codes</h1>
        <p className="mt-1 text-sm text-muted">
          If you lose your phone, each code lets you sign in once. Store them somewhere safe — they won’t be shown again.
        </p>
        <div className="mt-6">
          <RecoveryCodes codes={codes} />
        </div>
        <Button className="mt-6 w-full" onClick={() => router.replace('/')}>
          I’ve saved them — continue
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="mb-6 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
        <Smartphone className="size-5" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Set up two-step verification</h1>
      <p className="mt-1 text-sm text-muted">
        Your role requires it. Scan this code with Google Authenticator, Microsoft Authenticator or any TOTP app.
      </p>
      {error && (
        <div className="mt-6">
          <Alert>{error}</Alert>
        </div>
      )}
      {!setup ? (
        !error && <Spinner label="Preparing" />
      ) : (
        <form onSubmit={enable} className="mt-6 space-y-5">
          <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} />
            <details className="w-full text-[12px] text-muted">
              <summary className="cursor-pointer text-center">Can’t scan? Enter the key manually</summary>
              <div className="mt-2 flex items-center gap-2">
                <code className="num flex-1 break-all rounded bg-canvas px-2 py-1.5 font-mono text-[12px] text-ink-900">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
                <button type="button" onClick={() => navigator.clipboard.writeText(setup.secret)} className="rounded p-1.5 hover:bg-canvas" aria-label="Copy key">
                  <Copy className="size-4" />
                </button>
              </div>
            </details>
          </div>
          <Field label="Enter the 6-digit code shown in the app">
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} autoComplete="one-time-code" className="num text-center text-lg tracking-[0.3em]" required />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Turn on two-step verification
          </Button>
        </form>
      )}
    </>
  );
}
