'use client';

import { Pencil, Plus, UserCog } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td, Th } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { date } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Employee {
  id: string;
  employee_code: string;
  full_name: string;
  designation: string | null;
  mobile: string | null;
  joined_on: string | null;
  is_collector: boolean;
  status: string;
  version: number;
  branch_id: string;
  branch_code: string;
  user_id: string | null;
  username: string | null;
}

export default function EmployeesPage() {
  const { can, me } = useSession();
  const [branchId, setBranchId] = useState('');
  const [collectors, setCollectors] = useState(false);
  const { data, loading, reload } = useApi<{ data: Employee[] }>(`/employees${qs({ branchId, collectorsOnly: collectors || undefined })}`);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  if (!can('employee.view')) return <EmptyState title="You don’t have access to employees" />;

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle="Staff records, collectors and their linked sign-in accounts"
        actions={
          can('employee.manage') && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" /> New employee
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-4 border-b border-line p-4">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-56" aria-label="Branch">
            <option value="">All branches</option>
            {me?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
          <Checkbox label="Collectors only" checked={collectors} onChange={(e) => setCollectors(e.target.checked)} />
        </div>
        {loading || !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<UserCog className="size-8" />} title="No employees yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Branch</Th>
                <Th>Role</Th>
                <Th>Mobile</Th>
                <Th>Sign-in</Th>
                <Th>Joined</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.data.map((e) => (
                <tr key={e.id} className="hover:bg-canvas/60">
                  <Td className="num font-mono text-[12px]">{e.employee_code}</Td>
                  <Td className="font-medium text-ink-950">{e.full_name}</Td>
                  <Td className="text-muted">{e.branch_code}</Td>
                  <Td>
                    <span className="text-muted">{e.designation ?? '—'}</span> {e.is_collector && <Badge tone="accent">Collector</Badge>}
                  </Td>
                  <Td className="num text-muted">{e.mobile ?? '—'}</Td>
                  <Td className="text-muted">{e.username ? `@${e.username}` : <span className="text-subtle">Not linked</span>}</Td>
                  <Td className="num text-muted">{date(e.joined_on)}</Td>
                  <Td>
                    <StatusBadge status={e.status} />
                  </Td>
                  <Td className="text-right">
                    {can('employee.manage') && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`Edit ${e.full_name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <EmployeeDialog employee={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function EmployeeDialog({ employee, onClose, onSaved }: { employee: Employee | null; onClose: () => void; onSaved: () => void }) {
  const { me, can } = useSession();
  const toast = useToast();
  const { data: users } = useApi<{ data: { id: string; username: string; full_name: string }[] }>(can('user.manage') ? '/users' : null);
  const [v, setV] = useState({
    branchId: employee?.branch_id ?? (me?.branches.length === 1 ? me.branches[0]!.id : ''),
    employeeCode: employee?.employee_code ?? '',
    fullName: employee?.full_name ?? '',
    designation: employee?.designation ?? '',
    mobile: employee?.mobile ?? '',
    joinedOn: employee?.joined_on ?? '',
    isCollector: employee?.is_collector ?? false,
    userId: employee?.user_id ?? '',
    status: employee?.status ?? 'ACTIVE',
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = error?.fieldErrors() ?? {};

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { employeeCode, status, ...rest } = v;
      if (employee) await api('PATCH', `/employees/${employee.id}`, { body: { ...rest, status }, ifMatch: employee.version });
      else await api('POST', '/employees', { body: { ...rest, employeeCode } });
      toast('ok', employee ? 'Employee updated' : 'Employee added');
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={employee ? `Edit ${employee.full_name}` : 'New employee'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !error.details && <Alert>{error.message}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Employee code" required error={fe.employeeCode}>
            <Input value={v.employeeCode} onChange={(e) => setV({ ...v, employeeCode: e.target.value.toUpperCase() })} disabled={!!employee} className="num font-mono uppercase" />
          </Field>
          <Field label="Branch" required error={fe.branchId}>
            <Select value={v.branchId} onChange={(e) => setV({ ...v, branchId: e.target.value })}>
              <option value="">Select branch</option>
              {me?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Full name" required error={fe.fullName}>
            <Input value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} />
          </Field>
          <Field label="Designation" error={fe.designation}>
            <Input value={v.designation} onChange={(e) => setV({ ...v, designation: e.target.value })} />
          </Field>
          <Field label="Mobile" error={fe.mobile}>
            <Input value={v.mobile} inputMode="tel" onChange={(e) => setV({ ...v, mobile: e.target.value })} />
          </Field>
          <Field label="Joined on" error={fe.joinedOn}>
            <Input type="date" value={v.joinedOn} onChange={(e) => setV({ ...v, joinedOn: e.target.value })} />
          </Field>
          {users && (
            <Field label="Linked sign-in account" error={fe.userId}>
              <Select value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })}>
                <option value="">Not linked</option>
                {users.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    @{u.username} — {u.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {employee && (
            <Field label="Status">
              <Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          )}
        </div>
        <Checkbox label="Collects payments in the field (collector)" checked={v.isCollector} onChange={(e) => setV({ ...v, isCollector: e.target.checked })} />
      </div>
    </Dialog>
  );
}
