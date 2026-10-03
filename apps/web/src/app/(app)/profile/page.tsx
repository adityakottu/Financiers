'use client';

import { passwordProblems, PASSWORD_RULES } from '@fin/contracts';
import { LogOut, Monitor, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { RecoveryCodes } from '@/components/recovery-codes';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Detail, Field, Input, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { browserLabel, dateTime, relative } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ROLE_LABELS, useSession } from '@/lib/session';

interface Session {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}
interface LoginEvent {
  id: string;
  success: boolean;
  reason: string;
  ip: string | null;
  user_agent: string | null;
  at: string;
}

export default function ProfilePage() {
  const { me } = useSession();
  if (!me) return <Spinner />;
  return (
    <>
      <PageHeader title="Profile & security" subtitle={`@${me.username}`} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Your account" />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 p-5">
            <Detail label="Name" value={me.fullName} />
            <Detail label="Roles" value={me.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')} />
            <Detail label="Email" value={me.email} />
            <Detail label="Mobile" value={me.mobile} mono />
            <Detail label="Branches" value={me.scope === 'ALL' ? 'All branches' : me.branches.map((b) => b.code).join(', ')} />
            <Detail label="Last sign-in" value={dateTime(me.lastLoginAt)} />
          </dl>
        </Card>
        <TwoFactorCard />
        <ChangePasswordCard />
        <SessionsCard />
        <HistoryCard />
      </div>
    </>
  );
}

function ChangePasswordCard() {
  const toast = useToast();
  const [v, setV] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = v.next ? passwordProblems(v.next)[0] : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (v.next !== v.confirm) return setError('The two new passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/password/change', { body: { currentPassword: v.current, newPassword: v.next } });
      toast('ok', 'Password changed. Your other devices were signed out.');
      setV({ current: '', next: '', confirm: '' });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Change password" description="Other devices are signed out when you change it." />
      <form onSubmit={submit} className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} required />
        </Field>
        <Field label="New password" hint={PASSWORD_RULES} error={problem}>
          <Input type="password" autoComplete="new-password" value={v.next} onChange={(e) => setV({ ...v, next: e.target.value })} required />
        </Field>
        <Field label="Confirm new password" error={v.confirm && v.confirm !== v.next ? 'Does not match' : undefined}>
          <Input type="password" autoComplete="new-password" value={v.confirm} onChange={(e) => setV({ ...v, confirm: e.target.value })} required />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" loading={busy} disabled={!!problem}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TwoFactorCard() {
  const { me } = useSession();
  const withStepUp = useStepUp();
  const toast = useToast();
  const [codes, setCodes] = useState<string[] | null>(null);

  async function regenerate() {
    try {
      const r = await withStepUp(() => api<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes'));
      setCodes(r.recoveryCodes);
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Two-step verification"
        actions={me?.mfaEnabled ? <Badge tone="ok"><ShieldCheck className="size-3.5" /> On</Badge> : <Badge tone="warn">Off</Badge>}
      />
      <div className="space-y-4 p-5 text-[13px] text-muted">
        {me?.mfaEnabled ? (
          <>
            <p>You sign in with your password and a code from your authenticator app.</p>
            {codes ? (
              <>
                <Alert tone="warn">Your old recovery codes no longer work. Save these new ones.</Alert>
                <RecoveryCodes codes={codes} />
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={regenerate}>
                Generate new recovery codes
              </Button>
            )}
          </>
        ) : (
          <>
            <p>Add a second step to protect your account, even if your password leaks.</p>
            <a href="/setup/mfa">
              <Button size="sm">Set up two-step verification</Button>
            </a>
          </>
        )}
      </div>
    </Card>
  );
}

function SessionsCard() {
  const toast = useToast();
  const { data, loading, reload } = useApi<{ data: Session[] }>('/auth/sessions');

  async function revoke(id: string) {
    await api('DELETE', `/auth/sessions/${id}`);
    toast('ok', 'Device signed out');
    reload();
  }
  async function everywhere() {
    if (!confirm('Sign out of every device, including this one?')) return;
    await api('POST', '/auth/logout-all');
    location.href = '/login';
  }

  return (
    <Card>
      <CardHeader
        title="Signed-in devices"
        actions={
          <Button size="sm" variant="secondary" onClick={everywhere}>
            <LogOut className="size-3.5" /> Sign out everywhere
          </Button>
        }
      />
      {loading || !data ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-line">
          {data.data.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="flex items-center gap-3">
                <Monitor className="size-4 text-subtle" />
                <div>
                  <p className="text-sm text-ink-950">
                    {browserLabel(s.user_agent)} {s.current && <Badge tone="accent">This device</Badge>}
                  </p>
                  <p className="num text-[12px] text-muted">
                    {s.ip ?? 'unknown IP'} · active {relative(s.last_seen_at)} · since {dateTime(s.created_at)}
                  </p>
                </div>
              </div>
              {!s.current && (
                <Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const REASON: Record<string, string> = {
  OK: 'Signed in',
  MFA_PENDING: 'Password accepted',
  BAD_PASSWORD: 'Wrong password',
  LOCKED: 'Blocked (locked)',
  MFA_FAILED: 'Wrong verification code',
  REAUTH_FAILED: 'Wrong password on confirmation',
  RESET_REQUESTED: 'Password reset requested',
  DISABLED: 'Account disabled',
  PASSWORD_CHANGE_BAD_CURRENT: 'Wrong current password',
};

function HistoryCard() {
  const { data, loading } = useApi<{ data: LoginEvent[] }>('/auth/login-history');
  return (
    <Card>
      <CardHeader title="Recent sign-in activity" description="If you don’t recognise something, change your password and tell your administrator." />
      {loading || !data ? (
        <Spinner />
      ) : (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto">
          {data.data.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
              <span className={e.success ? 'text-ink-950' : 'text-bad'}>{REASON[e.reason] ?? e.reason}</span>
              <span className="num text-right text-[12px] text-muted">
                {dateTime(e.at)} · {e.ip ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
