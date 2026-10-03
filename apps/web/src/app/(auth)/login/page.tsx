'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError, restrictionRoute } from '@/lib/api';

function safeNext(next: string | null): string {
  // Only same-site relative paths — never redirect to another origin.
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mfaRequired: boolean }>('POST', '/auth/login', { body: { identifier, password }, noAuthRedirect: true });
      if (r.mfaRequired) {
        router.replace(`/login/mfa?next=${encodeURIComponent(safeNext(params.get('next')))}`);
        return;
      }
      const me = await api<{ restriction: string | null }>('GET', '/auth/me', { noAuthRedirect: true });
      router.replace(restrictionRoute(me.restriction) ?? safeNext(params.get('next')));
    } catch (err) {
      setError((err as ApiError).message);
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Sign in</h1>
      <p className="mt-1 text-sm text-muted">Use your username, email or mobile number.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Username, email or mobile">
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px]">
        <Link href="/forgot-password" className="text-ink-700 underline-offset-2 hover:underline">
          Forgot password?
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
