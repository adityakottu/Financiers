'use client';

import { ROLE_CODES, passwordProblems } from '@fin/contracts';
import { Copy, KeyRound, LogOut, Plus, ShieldCheck, ShieldOff, Unlock, UserCog, UserX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Spinner, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { relative } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ROLE_LABELS, useSession } from '@/lib/session';

interface UserRow {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  mobile: string | null;
  status: string;
  mfa_enabled: boolean;
  must_change_password: boolean;
  locked_until: string | null;
  last_login_at: string | null;
  roles: string[];
  branches: { id: string; code: string }[];
}
interface Branch {
  id: string;
  code: string;
  name: string;
}

export default function UsersPage() {
  const { can, me } = useSession();
  const { data, loading, reload } = useApi<{ data: UserRow[] }>('/users');
  const { data: branches } = useApi<{ data: Branch[] }>('/branches');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);

  if (!can('user.manage')) return <EmptyState title="You don’t have access to user administration" />;

  return (
    <>
      <PageHeader
        title="Users & access"
        subtitle="Who can sign in, their roles and which branches they can see"
        actions={
          can('permission.assign') && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New user
            </Button>
          )
        }
      />
      <Card>
        {loading || !data ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Roles</Th>
                <Th>Branches</Th>
                <Th>Security</Th>
                <Th>Last sign-in</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((u) => {
                const locked = u.locked_until && new Date(u.locked_until) > new Date();
                return (
                  <tr key={u.id} className="cursor-pointer hover:bg-canvas/60" onClick={() => setSelected(u)}>
                    <Td>
                      <p className="font-medium text-ink-950">
                        {u.full_name} {u.id === me?.id && <span className="text-[12px] font-normal text-subtle">(you)</span>}
                      </p>
                      <p className="text-[12px] text-muted">@{u.username}</p>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {u.roles.map((r) => (
                          <Badge key={r} tone={r === 'SUPER_ADMIN' ? 'accent' : 'neutral'}>
                            {ROLE_LABELS[r] ?? r}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td className="text-muted">{u.roles.some((r) => r === 'SUPER_ADMIN' || r === 'MANAGEMENT') ? 'All' : u.branches.map((b) => b.code).join(', ') || '—'}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {u.mfa_enabled ? <Badge tone="ok">2FA on</Badge> : <Badge>2FA off</Badge>}
                        {u.must_change_password && <Badge tone="warn">Temp password</Badge>}
                        {locked && <Badge tone="bad">Locked</Badge>}
                      </div>
                    </Td>
                    <Td className="text-muted">{relative(u.last_login_at)}</Td>
                    <Td>
                      <StatusBadge status={u.status} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <CreateUserDialog branches={branches?.data ?? []} onClose={() => setCreating(false)} onSaved={reload} />}
      {selected && (
        <UserDialog
          user={selected}
          branches={branches?.data ?? []}
          onClose={() => setSelected(null)}
          onSaved={() => {
            reload();
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function RolesAndBranches({
  roles,
  setRoles,
  branchIds,
  setBranchIds,
  branches,
}: {
  roles: string[];
  setRoles: (r: string[]) => void;
  branchIds: string[];
  setBranchIds: (b: string[]) => void;
  branches: Branch[];
}) {
  const allBranches = roles.some((r) => r === 'SUPER_ADMIN' || r === 'MANAGEMENT');
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-800">Roles</legend>
        <div className="space-y-2">
          {ROLE_CODES.map((r) => (
            <Checkbox key={r} label={ROLE_LABELS[r]} checked={roles.includes(r)} onChange={() => setRoles(toggle(roles, r))} />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-ink-800">Branches</legend>
        {allBranches ? (
          <p className="text-[13px] text-muted">This role sees every branch.</p>
        ) : (
          <div className="space-y-2">
            {branches.map((b) => (
              <Checkbox key={b.id} label={`${b.code} — ${b.name}`} checked={branchIds.includes(b.id)} onChange={() => setBranchIds(toggle(branchIds, b.id))} />
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function CreateUserDialog({ branches, onClose, onSaved }: { branches: Branch[]; onClose: () => void; onSaved: () => void }) {
  const withStepUp = useStepUp();
  const toast = useToast();
  const [v, setV] = useState({ username: '', fullName: '', email: '', mobile: '', temporaryPassword: '' });
  const [roles, setRoles] = useState<string[]>(['COLLECTION_EMPLOYEE']);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = error?.fieldErrors() ?? {};
  const pwProblem = v.temporaryPassword ? passwordProblems(v.temporaryPassword, v.username)[0] : undefined;

  function generate() {
    const words = ['Godavari', 'Krishna', 'Tirupati', 'Kakinada', 'Nellore', 'Vizag', 'Guntur', 'Ongole'];
    const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0]! % words.length];
    setV({ ...v, temporaryPassword: `${pick()}#${pick()}${crypto.getRandomValues(new Uint32Array(1))[0]! % 900 + 100}` });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await withStepUp(() => api('POST', '/users', { body: { ...v, roleCodes: roles, branchIds } }));
      toast('ok', `User @${v.username} created. Share the temporary password securely.`);
      onSaved();
      onClose();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New user"
      description="They must change the temporary password at first sign-in."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!!pwProblem || roles.length === 0}>
            Create user
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert>{error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" required error={fe.username}>
            <Input value={v.username} onChange={(e) => setV({ ...v, username: e.target.value.toLowerCase() })} autoCapitalize="none" />
          </Field>
          <Field label="Full name" required error={fe.fullName}>
            <Input value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} />
          </Field>
          <Field label="Email" error={fe.email}>
            <Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </Field>
          <Field label="Mobile" error={fe.mobile}>
            <Input value={v.mobile} inputMode="tel" onChange={(e) => setV({ ...v, mobile: e.target.value })} />
          </Field>
          <Field label="Temporary password" required error={pwProblem ?? fe.temporaryPassword} className="sm:col-span-2">
            <div className="flex gap-2">
              <Input value={v.temporaryPassword} onChange={(e) => setV({ ...v, temporaryPassword: e.target.value })} className="num font-mono" autoComplete="off" />
              <Button type="button" variant="secondary" onClick={generate}>
                Generate
              </Button>
            </div>
          </Field>
        </div>
        <RolesAndBranches roles={roles} setRoles={setRoles} branchIds={branchIds} setBranchIds={setBranchIds} branches={branches} />
      </div>
    </Dialog>
  );
}

function UserDialog({ user, branches, onClose, onSaved }: { user: UserRow; branches: Branch[]; onClose: () => void; onSaved: () => void }) {
  const { me, can } = useSession();
  const withStepUp = useStepUp();
  const toast = useToast();
  const self = user.id === me?.id;
  const [roles, setRoles] = useState(user.roles);
  const [branchIds, setBranchIds] = useState(user.branches.map((b) => b.id));
  const [resetPath, setResetPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accessChanged = useMemo(
    () => roles.slice().sort().join() !== user.roles.slice().sort().join() || branchIds.slice().sort().join() !== user.branches.map((b) => b.id).sort().join(),
    [roles, branchIds, user],
  );

  async function run(label: string, fn: () => Promise<unknown>, close = true) {
    setError(null);
    try {
      await withStepUp(fn);
      toast('ok', label);
      if (close) onSaved();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError((e as ApiError).message);
    }
  }

  const locked = user.locked_until && new Date(user.locked_until) > new Date();
  const link = resetPath ? `${location.origin}${resetPath}` : null;

  return (
    <Dialog open wide onClose={onClose} title={user.full_name} description={`@${user.username}${user.email ? ` · ${user.email}` : ''}`}>
      <div className="space-y-6">
        {error && <Alert>{error}</Alert>}
        {can('permission.assign') && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-ink-950">Access</h3>
            {self ? (
              <p className="text-[13px] text-muted">You can’t change your own roles or branches.</p>
            ) : (
              <>
                <RolesAndBranches roles={roles} setRoles={setRoles} branchIds={branchIds} setBranchIds={setBranchIds} branches={branches} />
                <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-canvas px-3 py-2">
                  <p className="text-[12px] text-muted">Saving signs the user out of every device.</p>
                  <Button size="sm" disabled={!accessChanged || roles.length === 0} onClick={() => run('Access updated', () => api('PUT', `/users/${user.id}/access`, { body: { roleCodes: roles, branchIds } }))}>
                    <UserCog className="size-3.5" /> Save access
                  </Button>
                </div>
              </>
            )}
          </section>
        )}

        {!self && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-ink-950">Account actions</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="secondary" onClick={() => run('Reset link created', async () => setResetPath((await api<{ resetPath: string }>('POST', `/users/${user.id}/reset-link`)).resetPath), false)}>
                <KeyRound className="size-4" /> Create password reset link
              </Button>
              {locked && (
                <Button variant="secondary" onClick={() => run('Account unlocked', () => api('POST', `/users/${user.id}/unlock`))}>
                  <Unlock className="size-4" /> Unlock account
                </Button>
              )}
              {user.mfa_enabled && (
                <Button variant="secondary" onClick={() => run('Two-step verification reset; they will enrol again at next sign-in', () => api('POST', `/users/${user.id}/reset-mfa`))}>
                  <ShieldOff className="size-4" /> Reset two-step verification
                </Button>
              )}
              {can('session.manage_others') && (
                <Button variant="secondary" onClick={() => run('Signed out everywhere', () => api('POST', `/users/${user.id}/force-logout`))}>
                  <LogOut className="size-4" /> Sign out all devices
                </Button>
              )}
              {user.status === 'ACTIVE' ? (
                <Button variant="danger" onClick={() => confirm(`Disable ${user.full_name}? They will be signed out immediately.`) && run('User disabled', () => api('POST', `/users/${user.id}/disable`))}>
                  <UserX className="size-4" /> Disable user
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => run('User enabled', () => api('POST', `/users/${user.id}/enable`))}>
                  <ShieldCheck className="size-4" /> Enable user
                </Button>
              )}
            </div>
            {link && (
              <div className="mt-4">
                <Alert tone="info">Valid for 30 minutes and one use. Share it with the user directly — not in a group chat.</Alert>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-canvas px-2 py-1.5 font-mono text-[12px]">{link}</code>
                  <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(link)}>
                    <Copy className="size-3.5" /> Copy
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
