'use client';

import { passwordProblems, PASSWORD_RULES } from '@fin/contracts';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, ApiError, restrictionRoute } from '@/lib/api';

export default function SetupPasswordPage() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problems = next ? passwordProblems(next) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setError('The two new passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/password/change', { body: { currentPassword: current, newPassword: next } });
      const me = await api<{ restriction: string | null }>('GET', '/auth/me');
      router.replace(restrictionRoute(me.restriction) ?? '/');
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-6 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
        <KeyRound className="size-5" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Set your own password</h1>
      <p className="mt-1 text-sm text-muted">Your account was created with a temporary password. Choose a new one to continue.</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Temporary password">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
        </Field>
        <Field label="New password" hint={PASSWORD_RULES} error={problems[0]}>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required aria-invalid={problems.length > 0} />
        </Field>
        <Field label="Confirm new password" error={confirm && confirm !== next ? 'Does not match' : undefined}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={problems.length > 0 || !confirm}>
          Save and continue
        </Button>
      </form>
    </>
  );
}
