'use client';

import { Building2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/toast';
import { Alert, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Spinner, StatusBadge, Table, Td, Th, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Branch {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
}

export default function BranchesPage() {
  const { can } = useSession();
  const { data, loading, reload } = useApi<{ data: Branch[] }>('/branches');
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  if (!can('branch.manage')) return <EmptyState title="You don’t have access to branch settings" />;

  return (
    <>
      <PageHeader
        title="Branches"
        subtitle="Branch codes appear in loan and receipt numbers"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus className="size-4" /> New branch
          </Button>
        }
      />
      <Card>
        {loading || !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Building2 className="size-8" />} title="No branches" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Phone</Th>
                <Th>Address</Th>
                <Th>Created</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.data.map((b) => (
                <tr key={b.id} className="hover:bg-canvas/60">
                  <Td className="num font-mono font-medium">{b.code}</Td>
                  <Td className="font-medium text-ink-950">{b.name}</Td>
                  <Td className="num text-muted">{b.phone ?? '—'}</Td>
                  <Td className="max-w-xs truncate text-muted">{b.address ?? '—'}</Td>
                  <Td className="num text-muted">{date(b.created_at)}</Td>
                  <Td>
                    <StatusBadge status={b.is_active ? 'ACTIVE' : 'INACTIVE'} />
                  </Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(b)} aria-label={`Edit ${b.name}`}>
                      <Pencil className="size-3.5" />
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <BranchDialog branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function BranchDialog({ branch, onClose, onSaved }: { branch: Branch | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ code: branch?.code ?? '', name: branch?.name ?? '', address: branch?.address ?? '', phone: branch?.phone ?? '', isActive: branch?.is_active ?? true });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = error?.fieldErrors() ?? {};

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (branch) {
        await api('PATCH', `/branches/${branch.id}`, { body: { name: v.name, address: v.address, phone: v.phone, isActive: v.isActive }, ifMatch: branch.version });
      } else {
        await api('POST', '/branches', { body: { code: v.code, name: v.name, address: v.address, phone: v.phone } });
      }
      toast('ok', branch ? 'Branch updated' : 'Branch created');
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
      onClose={onClose}
      title={branch ? `Edit ${branch.name}` : 'New branch'}
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
        <Field label="Code" required hint="2–8 letters or numbers, e.g. KKD. Cannot be changed later." error={fe.code}>
          <Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} disabled={!!branch} maxLength={8} className="num font-mono uppercase" />
        </Field>
        <Field label="Name" required error={fe.name}>
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </Field>
        <Field label="Phone" error={fe.phone}>
          <Input value={v.phone} inputMode="tel" onChange={(e) => setV({ ...v, phone: e.target.value })} />
        </Field>
        <Field label="Address" error={fe.address}>
          <Textarea value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} rows={2} />
        </Field>
        {branch && <Checkbox label="Branch is active" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} />}
      </div>
    </Dialog>
  );
}
