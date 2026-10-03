'use client';

import { passwordProblems, PASSWORD_RULES } from '@fin/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const problems = password ? passwordProblems(password) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError('The two passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/password/reset', { body: { token, newPassword: password }, noAuthRedirect: true });
      setDone(true);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Password updated</h1>
        <p className="mt-1 text-sm text-muted">All your other sessions were signed out.</p>
        <Link href="/login" className="mt-8 inline-flex h-10 w-full items-center justify-center rounded-md bg-ink-900 text-sm font-medium text-white">
          Sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Choose a new password</h1>
      {!token && (
        <div className="mt-4">
          <Alert>This link is missing its token. Ask your administrator for a new one.</Alert>
        </div>
      )}
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="New password" hint={PASSWORD_RULES} error={problems[0]}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </Field>
        <Field label="Confirm new password" error={confirm && confirm !== password ? 'Does not match' : undefined}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!token || problems.length > 0}>
          Set password
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
