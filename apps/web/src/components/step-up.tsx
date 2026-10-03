'use client';

import { ShieldCheck } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, Button, Dialog, Field, Input } from './ui';

type Runner = <T>(action: () => Promise<T>) => Promise<T>;
const Ctx = createContext<Runner | null>(null);

/**
 * Sensitive actions (role changes, KYC reveal, reset links) require a password (+ code) entered
 * in the last 5 minutes. `withStepUp(action)` runs the action, and if the server answers
 * REAUTH_REQUIRED it asks for credentials, re-authenticates and retries once.
 */
export function StepUpProvider({ children }: { children: React.ReactNode }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = () =>
    new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject };
      setPassword('');
      setCode('');
      setError(null);
      setOpen(true);
    });

  const withStepUp: Runner = useCallback(async (action) => {
    try {
      return await action();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'REAUTH_REQUIRED') throw e;
      await ask();
      return action();
    }
  }, []);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/reauth', { body: { password, ...(me?.mfaEnabled ? { code } : {}) } });
      setOpen(false);
      pending.current?.resolve();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setOpen(false);
    pending.current?.reject(new ApiError(403, 'REAUTH_CANCELLED', 'Cancelled'));
  }

  return (
    <Ctx.Provider value={withStepUp}>
      {children}
      <Dialog open={open} onClose={cancel} title="Confirm it’s you" description="This action needs your password again.">
        <form id="step-up" onSubmit={confirm} className="space-y-4">
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <ShieldCheck className="size-4 text-accent" /> Valid for 5 minutes after confirming.
          </div>
          {error && <Alert>{error}</Alert>}
          <Field label="Password" required>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
          </Field>
          {me?.mfaEnabled && (
            <Field label="Authenticator code" required>
              <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={11} required />
            </Field>
          )}
        </form>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" form="step-up" loading={busy}>
            Confirm
          </Button>
        </div>
      </Dialog>
    </Ctx.Provider>
  );
}

export function useStepUp(): Runner {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStepUp outside StepUpProvider');
  return v;
}
