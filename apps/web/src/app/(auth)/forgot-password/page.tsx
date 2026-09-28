'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>('POST', '/auth/password/forgot', { body: { identifier }, noAuthRedirect: true });
      setDone(r.message);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">
        Enter your username, email or mobile. You can also ask your administrator for a reset link.
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}
        {done && <Alert tone="ok">{done}</Alert>}
        <Field label="Username, email or mobile">
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!!done}>
          Send reset instructions
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px]">
        <Link href="/login" className="text-ink-700 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
