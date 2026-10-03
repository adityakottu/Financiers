'use client';

import { Gavel, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Stat, StatGrid } from '@/components/charts';
import { ActionDialog, post, STAGE_TONE } from '@/components/recovery';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Tabs, Td, Th } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { count, date, dateTime, inr } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface CaseRow { id: string; case_no: string; stage: string; stage_name: string; status: string; opened_at: string; requested_stage: string | null; loan_id: string; loan_no: string; dpd: number; overdue_amount: string; principal_outstanding: string; customer_name: string; branch_code: string; owner_name: string | null; last_contact_at: string | null; repossessed_assets: number }
interface Stage { code: string; name: string; description: string | null; sort_order: number; requires_approval: boolean; is_terminal: boolean; allowed_next: string[]; active: boolean }
interface Approvals {
  stages: { id: string; case_no: string; requested_stage: string; request_note: string; requested_at: string; requested_by_name: string; loan_no: string }[];
  sales: { id: string; case_id: string; sale_no: string; sale_price: string; buyer_name: string; requested_at: string; requested_by_name: string; loan_no: string }[];
  writeOffs: { id: string; case_id: string; reason: string; requested_at: string; requested_by_name: string; loan_no: string; balance_payable: string }[];
}
type Tab = 'cases' | 'approvals' | 'setup';
const BUCKETS = [
  ['DPD_1_30', '1–30 days'],
  ['DPD_31_60', '31–60 days'],
  ['DPD_61_90', '61–90 days'],
  ['DPD_90_PLUS', '90+ days'],
] as const;

function Cases() {
  const { can } = useSession();
  const [status, setStatus] = useState('OPEN');
  const [bucket, setBucket] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [opening, setOpening] = useState(false);
  const params = new URLSearchParams(Object.entries({ status, bucket, q: dq }).filter(([, v]) => v) as [string, string][]);
  const { data, reload } = useApi<{ data: CaseRow[]; buckets: Record<string, number> }>(`/recovery/cases?${params}`);
  return (
    <div className="space-y-6">
      {data && (
        <StatGrid cols={6}>
          {BUCKETS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setBucket(bucket === k ? '' : k)} className="contents text-left">
              <Stat label={`Overdue ${l}`} value={count(data.buckets[k])} hint={bucket === k ? 'filtering ✓' : 'loans'} tone={k === 'DPD_90_PLUS' && data.buckets[k] ? 'bad' : undefined} />
            </button>
          ))}
          <Stat label="Overdue without a case" value={count(data.buckets.overdue_without_case)} tone={data.buckets.overdue_without_case ? 'warn' : undefined} />
          <Stat label="Cases shown" value={count(data.data.length)} />
        </StatGrid>
      )}
      <Card>
        <CardHeader
          title="Recovery cases"
          description="Opened by hand or automatically by the nightly job once a loan passes the configured days past due."
          actions={
            can('recovery.manage') && (
              <Button size="sm" onClick={() => setOpening(true)}>
                <Plus className="size-3.5" /> Open a case
              </Button>
            )
          }
        />
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 pb-4">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="OPEN">Open</option>
              <option value="CLOSED">Closed</option>
              <option value="">All</option>
            </Select>
          </Field>
          <Field label="Search">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Case, loan or customer" />
          </Field>
        </div>
        {!data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Gavel className="size-8" />} title="No cases here" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Case</Th>
                <Th>Customer · loan</Th>
                <Th>Stage</Th>
                <Th className="text-right">DPD</Th>
                <Th className="text-right">Overdue</Th>
                <Th>Owner</Th>
                <Th>Last contact</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((c) => (
                <tr key={c.id} className="hover:bg-canvas">
                  <Td>
                    <Link href={`/recovery/${c.id}`} className="num font-mono text-[12px] font-medium text-ink-950 hover:underline">
                      {c.case_no}
                    </Link>
                    <span className="block text-[12px] text-subtle">opened {date(c.opened_at)}</span>
                  </Td>
                  <Td>
                    <span className="font-medium">{c.customer_name}</span>
                    <span className="block text-[12px] text-muted">
                      {c.loan_no} · {c.branch_code}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={STAGE_TONE(c.stage)}>{c.stage_name}</Badge>
                    {c.requested_stage && <span className="ml-1 text-[12px] text-warn">→ {c.requested_stage.replace('_', ' ').toLowerCase()} (to approve)</span>}
                    {c.repossessed_assets > 0 && <span className="ml-1 text-[12px] text-bad">asset held</span>}
                  </Td>
                  <Td className="num text-right">{c.dpd}</Td>
                  <Td className="num text-right">{inr(c.overdue_amount, { decimals: false })}</Td>
                  <Td className="text-[13px]">{c.owner_name ?? '—'}</Td>
                  <Td className="text-[12px] text-muted">{c.last_contact_at ? dateTime(c.last_contact_at) : 'none yet'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {opening && <OpenCase onClose={() => setOpening(false)} onDone={reload} />}
    </div>
  );
}

function OpenCase({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [loans, setLoans] = useState<{ id: string; loan_no: string; dpd: number; overdue_amount: string; customer_name: string; branch_code: string }[]>([]);
  useEffect(() => {
    get<typeof loans>('/recovery/candidates').then(setLoans).catch(() => undefined);
  }, []);
  return (
    <ActionDialog
      title="Open a recovery case"
      description="Overdue active loans without an open case."
      action="Open case"
      fields={[
        { key: 'loanId', label: 'Loan', type: 'select', required: true, options: loans.map((l) => ({ value: l.id, label: `${l.loan_no} · ${l.customer_name} · ${l.dpd} days · ₹${Number(l.overdue_amount).toLocaleString('en-IN')} (${l.branch_code})` })) },
        { key: 'note', label: 'Why open it now', type: 'textarea', required: true },
      ]}
      onClose={onClose}
      onDone={onDone}
      submit={post('/recovery/cases')}
    />
  );
}

function ApprovalsInbox() {
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data, reload } = useApi<Approvals>('/recovery/approvals');
  const [rejecting, setRejecting] = useState<string | null>(null);
  const decide = async (path: string, approve: boolean, msg: string) => {
    if (!approve) return setRejecting(path);
    try {
      await withStepUp(() => api('POST', `${path}/approve`, { body: {} }));
      toast('ok', msg);
      reload();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  };
  if (!data) return <Spinner />;
  const empty = !data.stages.length && !data.sales.length && !data.writeOffs.length;
  if (empty) return <EmptyState title="Nothing waiting for approval" />;
  const Row = ({ title, sub, by, path, msg, caseId, mine }: { title: string; sub: string; by: string; path: string; msg: string; caseId: string; mine: boolean }) => (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <Link href={`/recovery/${caseId}`} className="font-medium hover:underline">
          {title}
        </Link>
        <p className="text-[13px] text-muted">{sub}</p>
        <p className="text-[12px] text-subtle">asked by {by}</p>
      </div>
      {mine ? (
        <Badge tone="neutral">Your request — someone else decides</Badge>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => decide(path, false, msg)}>
            Reject
          </Button>
          <Button size="sm" onClick={() => decide(path, true, msg)}>
            Approve
          </Button>
        </div>
      )}
    </li>
  );
  return (
    <Card>
      <ul className="divide-y divide-line">
        {data.stages.map((s) => (
          <Row key={s.id} title={`${s.case_no} → ${s.requested_stage.replace('_', ' ').toLowerCase()}`} sub={`${s.loan_no} — “${s.request_note}”`} by={`${s.requested_by_name}, ${dateTime(s.requested_at)}`} path={`/recovery/cases/${s.id}/stage`} msg="Stage move approved" caseId={s.id} mine={false} />
        ))}
        {data.sales.map((s) => (
          <Row key={s.id} title={`Sale ${s.sale_no}: ${inr(s.sale_price)} to ${s.buyer_name}`} sub={s.loan_no} by={`${s.requested_by_name}, ${dateTime(s.requested_at)}`} path={`/recovery/sales/${s.id}`} msg="Sale approved and applied to the loan" caseId={s.case_id} mine={false} />
        ))}
        {data.writeOffs.map((w) => (
          <Row key={w.id} title={`Write off ${w.loan_no}`} sub={`“${w.reason}”`} by={`${w.requested_by_name}, ${dateTime(w.requested_at)}`} path={`/recovery/write-offs/${w.id}`} msg="Loan written off" caseId={w.case_id} mine={false} />
        ))}
      </ul>
      <p className="border-t border-line px-5 py-2 text-[12px] text-subtle">Approving needs your password again. The person who asked can never approve their own request.</p>
      {rejecting && (
        <ActionDialog title="Reject request" action="Reject" fields={[{ key: 'note', label: 'Why is it not approved?', type: 'textarea', required: true }]} onClose={() => setRejecting(null)} onDone={reload} submit={post(`${rejecting}/reject`)} />
      )}
    </Card>
  );
}

function Setup() {
  const { can } = useSession();
  const toast = useToast();
  const { data: stages, reload } = useApi<Stage[]>('/recovery/stages');
  const { data: settings, reload: reloadSettings } = useApi<{ autoOpenDpd: number }>('/recovery/settings');
  const [dpd, setDpd] = useState<string | null>(null);
  const [editing, setEditing] = useState<Stage | 'new' | null>(null);
  const configure = can('recovery.configure');
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Opening cases automatically" description="The nightly job opens a case for every active loan at or beyond this many days past due. 0 turns it off." />
        <div className="flex items-end gap-3 px-5 pb-5">
          <Field label="Days past due">
            <Input inputMode="numeric" className="num w-28" value={dpd ?? String(settings?.autoOpenDpd ?? '')} onChange={(e) => setDpd(e.target.value)} disabled={!configure} />
          </Field>
          {configure && (
            <Button
              variant="secondary"
              disabled={dpd === null}
              onClick={async () => {
                try {
                  await api('PUT', '/recovery/settings', { body: { autoOpenDpd: Number(dpd) } });
                  toast('ok', 'Saved');
                  setDpd(null);
                  reloadSettings();
                } catch (e) {
                  toast('bad', (e as ApiError).message);
                }
              }}
            >
              Save
            </Button>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Stages"
          description="Your recovery workflow. No legal step is built in ⚖ — define stages your legal advisor approves. Moving into a stage marked “needs approval” waits for a second person."
          actions={
            configure && (
              <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
                <Plus className="size-3.5" /> Add stage
              </Button>
            )
          }
        />
        {!stages ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Stage</Th>
                <Th>Can move to</Th>
                <Th>Rules</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr key={s.code} className={s.active ? '' : 'opacity-50'}>
                  <Td>
                    <span className="font-medium">{s.name}</span> <span className="font-mono text-[11px] text-subtle">{s.code}</span>
                    {s.description && <span className="block text-[12px] text-muted">{s.description}</span>}
                  </Td>
                  <Td className="text-[12px] text-muted">{s.allowed_next.join(', ') || '—'}</Td>
                  <Td className="space-x-1">
                    {s.requires_approval && <Badge tone="warn">needs approval</Badge>}
                    {s.is_terminal && <Badge>closes the case</Badge>}
                    {!s.active && <Badge>disabled</Badge>}
                  </Td>
                  <Td className="text-right">
                    {configure && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && (
        <ActionDialog
          title={editing === 'new' ? 'Add stage' : `Edit ${editing.name}`}
          action="Save stage"
          fields={[
            { key: 'code', label: 'Code', initial: editing === 'new' ? '' : editing.code, required: true, hint: 'Capitals and _ ; cannot be changed later' },
            { key: 'name', label: 'Name', initial: editing === 'new' ? '' : editing.name, required: true },
            { key: 'description', label: 'Description', initial: editing === 'new' ? '' : (editing.description ?? '') },
            { key: 'sortOrder', label: 'Order', initial: editing === 'new' ? '60' : String(editing.sort_order), required: true },
            { key: 'allowedNext', label: 'Can move to (codes, comma separated)', initial: editing === 'new' ? '' : editing.allowed_next.join(', ') },
            { key: 'requiresApproval', label: 'Needs approval to enter', type: 'select', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], initial: editing !== 'new' && editing.requires_approval ? 'yes' : 'no', required: true },
            { key: 'isTerminal', label: 'Closes the case', type: 'select', options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], initial: editing !== 'new' && editing.is_terminal ? 'yes' : 'no', required: true },
            { key: 'active', label: 'Active', type: 'select', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], initial: editing === 'new' || editing.active ? 'yes' : 'no', required: true },
          ]}
          onClose={() => setEditing(null)}
          onDone={reload}
          submit={(v) =>
            api('PUT', '/recovery/stages', {
              body: {
                code: v.code,
                name: v.name,
                description: v.description ?? '',
                sortOrder: Number(v.sortOrder),
                allowedNext: (v.allowedNext ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
                requiresApproval: v.requiresApproval === 'yes',
                isTerminal: v.isTerminal === 'yes',
                active: v.active === 'yes',
              },
            })
          }
        />
      )}
    </div>
  );
}

export default function RecoveryPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('cases');
  const { data: approvals } = useApi<Approvals>(can('recovery.approve') || can('loan.write_off') ? '/recovery/approvals' : null);
  const waiting = approvals ? approvals.stages.length + approvals.sales.length + approvals.writeOffs.length : undefined;
  if (!can('recovery.view')) return <EmptyState title="You don’t have access to recovery" />;
  return (
    <>
      <PageHeader title="Recovery" subtitle="Overdue loans, worked case by case — every step recorded, every decision by two people" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cases', label: 'Cases' },
          ...(can('recovery.approve') || can('loan.write_off') ? [{ id: 'approvals' as Tab, label: 'Approvals', count: waiting }] : []),
          { id: 'setup', label: 'Stages & settings' },
        ]}
      />
      <div className="mt-5">
        {tab === 'cases' && <Cases />}
        {tab === 'approvals' && <ApprovalsInbox />}
        {tab === 'setup' && <Setup />}
      </div>
    </>
  );
}
