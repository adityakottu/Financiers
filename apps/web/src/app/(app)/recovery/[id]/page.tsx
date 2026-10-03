'use client';

import { RECOVERY_ACTION_LABELS } from '@fin/contracts';
import { ArrowLeft, Car, FileX, MessageSquarePlus, MoveRight, PhoneCall, Tag } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Stat, StatGrid } from '@/components/charts';
import { ActionDialog, post, STAGE_TONE } from '@/components/recovery';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { api, ApiError, get } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface CaseView {
  id: string;
  case_no: string;
  stage: string;
  stage_name: string;
  status: string;
  opened_at: string;
  dpd_at_open: number;
  overdue_at_open: string;
  requested_stage: string | null;
  request_note: string | null;
  requested_by_name: string | null;
  close_reason: string | null;
  owner_name: string | null;
  loan_id: string;
  loan_no: string;
  loan_status: string;
  dpd: number;
  overdue_amount: string;
  balance_payable: string;
  principal_outstanding: string;
  interest_outstanding: string;
  advance_balance: string;
  next_due_date: string | null;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  branch_code: string;
  branch_name: string;
  nextStages: { code: string; name: string; requiresApproval: boolean; isTerminal: boolean }[];
  actions: { id: string; action_type: string; at: string; summary: string; actor_name: string | null }[];
  assets: { id: string; asset_no: string; status: string; category: string; make: string | null; model: string | null; registration_no: string | null; asset_value: string | null; repossession_id: string | null; repossessed_on: string | null; location: string | null; condition_notes: string | null; valuation: string | null }[];
  sales: { id: string; sale_no: string; status: string; sale_price: string; sold_on: string; buyer_name: string; requested_by_name: string; decided_by_name: string | null; account_name: string; applied_amount: string | null; surplus_amount: string | null }[];
  writeOffs: { id: string; status: string; reason: string; requested_by_name: string; requested_at: string; decided_by_name: string | null; amount: string | null; written_off_on: string | null; decision_note: string | null }[];
  can: { note: boolean; manage: boolean; decideStage: boolean; repossess: boolean; decideSale: boolean; requestWriteOff: boolean; decideWriteOff: boolean; me: string };
}

type Open =
  | { kind: 'note' }
  | { kind: 'stage' }
  | { kind: 'reject-stage' }
  | { kind: 'repossess'; assetId: string }
  | { kind: 'release'; assetId: string }
  | { kind: 'sale'; assetId: string }
  | { kind: 'reject-sale'; id: string }
  | { kind: 'write-off' }
  | { kind: 'reject-write-off'; id: string }
  | { kind: 'close' };

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function RecoveryCasePage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data: c, error, reload } = useApi<CaseView>(`/recovery/cases/${id}`);
  const [open, setOpen] = useState<Open | null>(null);
  const [banks, setBanks] = useState<{ id: string; code: string; name: string }[]>([]);
  useEffect(() => {
    get<{ accounts: { id: string; code: string; name: string; subtype: string | null }[] }>('/reports/options')
      .then((o) => setBanks(o.accounts.filter((a) => a.subtype === 'BANK')))
      .catch(() => undefined);
  }, []);

  const approve = async (path: string, msg: string) => {
    try {
      await withStepUp(() => api('POST', path, { body: {} }));
      toast('ok', msg);
      reload();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') toast('bad', (e as ApiError).message);
    }
  };

  if (error) return <Alert>{error.message}</Alert>;
  if (!c) return <Spinner />;
  const closed = c.status === 'CLOSED';
  const pendingSale = c.sales.find((s) => s.status === 'PENDING');
  const pendingWo = c.writeOffs.find((w) => w.status === 'PENDING');
  const close = () => setOpen(null);
  const icon = (t: string) => (t === 'CALL' ? PhoneCall : t === 'VISIT' ? Car : t.startsWith('SALE') ? Tag : t.startsWith('WRITE') || t === 'WRITTEN_OFF' ? FileX : t.startsWith('STAGE') ? MoveRight : MessageSquarePlus);

  return (
    <>
      <Link href="/recovery" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-700 hover:underline">
        <ArrowLeft className="size-3.5" /> Recovery
      </Link>
      <PageHeader
        title={`${c.case_no} · ${c.customer_name}`}
        subtitle={`${c.loan_no} · ${c.branch_name} · opened ${date(c.opened_at)} at ${c.dpd_at_open} days past due`}
        actions={
          <div className="flex flex-wrap gap-2">
            {c.can.note && (
              <Button variant="secondary" onClick={() => setOpen({ kind: 'note' })}>
                <MessageSquarePlus className="size-4" /> Add note / call / visit
              </Button>
            )}
            {c.can.manage && !c.requested_stage && c.nextStages.length > 0 && (
              <Button onClick={() => setOpen({ kind: 'stage' })}>
                <MoveRight className="size-4" /> Move stage
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={STAGE_TONE(c.stage)}>{c.stage_name}</Badge>
        {closed && <Badge>Closed{c.close_reason ? ` — ${c.close_reason}` : ''}</Badge>}
        {c.loan_status !== 'ACTIVE' && <Badge tone={c.loan_status === 'WRITTEN_OFF' ? 'bad' : 'ok'}>Loan {titleCase(c.loan_status)}</Badge>}
        <span className="text-[13px] text-muted">Owner: {c.owner_name ?? 'not assigned'}</span>
        <Link href={`/loans/${c.loan_id}`} className="text-[13px] text-ink-700 hover:underline">
          Open the loan →
        </Link>
      </div>

      {c.requested_stage && (
        <div className="mb-6">
          <Alert tone="warn">
            <p>
              <strong>{c.requested_by_name}</strong> asked to move this case to <strong>{titleCase(c.requested_stage)}</strong>: “{c.request_note}”.
            </p>
            {c.can.decideStage ? (
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => approve(`/recovery/cases/${c.id}/stage/approve`, 'Stage move approved')}>
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'reject-stage' })}>
                  Reject
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-[12px]">Waiting for someone with approval rights (not the requester).</p>
            )}
          </Alert>
        </div>
      )}

      <StatGrid cols={6}>
        <Stat label="Days past due" value={String(c.dpd)} tone={c.dpd > 90 ? 'bad' : c.dpd > 0 ? 'warn' : 'ok'} />
        <Stat label="Overdue" value={inr(c.overdue_amount, { decimals: false })} hint={`was ${inr(c.overdue_at_open, { decimals: false })} at opening`} />
        <Stat label="Principal outstanding" value={inr(c.principal_outstanding, { decimals: false })} />
        <Stat label="Interest due" value={inr(c.interest_outstanding, { decimals: false })} />
        <Stat label="Balance payable" value={inr(c.balance_payable, { decimals: false })} hint="all remaining installments" />
        <Stat label="Advance held" value={inr(c.advance_balance, { decimals: false })} />
      </StatGrid>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="History" description="Every call, visit, decision and money movement on this case. Nothing here can be edited or deleted." />
          <ol className="divide-y divide-line">
            {c.actions.map((a) => {
              const I = icon(a.action_type);
              return (
                <li key={a.id} className="flex gap-3 px-5 py-3">
                  <I className="mt-0.5 size-4 shrink-0 text-subtle" />
                  <div>
                    <p className="text-[13px]">
                      <span className="font-medium">{RECOVERY_ACTION_LABELS[a.action_type] ?? a.action_type}</span> — {a.summary}
                    </p>
                    <p className="text-[12px] text-subtle">
                      {a.actor_name ?? 'System (nightly job)'} · {dateTime(a.at)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Financed asset" description={c.can.repossess ? 'Repossession is recorded as custody; it posts nothing. A sale needs approval and settles the loan.' : undefined} />
            {c.assets.length === 0 ? (
              <EmptyState title="No asset on this loan" />
            ) : (
              <ul className="divide-y divide-line">
                {c.assets.map((a) => (
                  <li key={a.id} className="space-y-2 px-5 py-3 text-[13px]">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{[a.make, a.model, a.registration_no].filter(Boolean).join(' ') || a.asset_no}</span>
                      <Badge tone={a.status === 'REPOSSESSED' ? 'bad' : a.status === 'SOLD' ? 'neutral' : 'ok'}>{titleCase(a.status)}</Badge>
                    </div>
                    {a.repossession_id && (
                      <p className="text-muted">
                        Repossessed {date(a.repossessed_on)} · kept at {a.location}
                        {a.valuation && ` · valued ${inr(a.valuation, { decimals: false })}`}
                        <span className="block text-[12px] text-subtle">{a.condition_notes}</span>
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {a.status === 'ACTIVE' && c.can.repossess && (
                        <Button size="sm" variant="danger" onClick={() => setOpen({ kind: 'repossess', assetId: a.id })}>
                          Record repossession
                        </Button>
                      )}
                      {a.status === 'REPOSSESSED' && c.can.manage && !pendingSale && (
                        <>
                          <Button size="sm" onClick={() => setOpen({ kind: 'sale', assetId: a.id })}>
                            Record sale
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'release', assetId: a.id })}>
                            Release to customer
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {c.can.manage && c.stage !== 'REPOSSESSION' && c.assets.some((a) => a.status === 'ACTIVE') && (
              <p className="border-t border-line px-5 py-2 text-[12px] text-subtle">Repossession can be recorded once the case is approved into the Repossession stage ⚖.</p>
            )}
          </Card>

          {c.sales.length > 0 && (
            <Card>
              <CardHeader title="Sale" />
              <ul className="divide-y divide-line text-[13px]">
                {c.sales.map((s) => (
                  <li key={s.id} className="space-y-1 px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {s.sale_no} · {inr(s.sale_price)}
                      </span>
                      <Badge tone={s.status === 'APPROVED' ? 'ok' : s.status === 'PENDING' ? 'warn' : 'neutral'}>{titleCase(s.status)}</Badge>
                    </div>
                    <p className="text-muted">
                      To {s.buyer_name} on {date(s.sold_on)} · into {s.account_name} · asked by {s.requested_by_name}
                      {s.decided_by_name && ` · decided by ${s.decided_by_name}`}
                    </p>
                    {s.status === 'APPROVED' && (
                      <p className="text-[12px] text-subtle">
                        Applied to the loan {inr(s.applied_amount)}
                        {Number(s.surplus_amount) > 0 && ` · surplus ${inr(s.surplus_amount)} owed to the customer`}
                      </p>
                    )}
                    {s.status === 'PENDING' && c.can.decideSale && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" onClick={() => approve(`/recovery/sales/${s.id}/approve`, 'Sale approved and applied to the loan')}>
                          Approve sale
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'reject-sale', id: s.id })}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Write-off" description="Removes exactly the receivables on the books to bad debts (E13) ⚖. Needs a second person." />
            {c.writeOffs.length > 0 && (
              <ul className="divide-y divide-line text-[13px]">
                {c.writeOffs.map((w) => (
                  <li key={w.id} className="space-y-1 px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span>Asked by {w.requested_by_name}</span>
                      <Badge tone={w.status === 'APPROVED' ? 'bad' : w.status === 'PENDING' ? 'warn' : 'neutral'}>{titleCase(w.status)}</Badge>
                    </div>
                    <p className="text-muted">“{w.reason}”</p>
                    {w.status === 'APPROVED' && (
                      <p className="text-[12px] text-subtle">
                        {inr(w.amount)} written off on {date(w.written_off_on)} by {w.decided_by_name}. Money received later is booked as bad debts recovered.
                      </p>
                    )}
                    {w.status === 'REJECTED' && <p className="text-[12px] text-subtle">Rejected by {w.decided_by_name}{w.decision_note ? ` — ${w.decision_note}` : ''}</p>}
                    {w.status === 'PENDING' && c.can.decideWriteOff && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="danger" onClick={() => approve(`/recovery/write-offs/${w.id}/approve`, 'Loan written off')}>
                          Approve write-off
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'reject-write-off', id: w.id })}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {c.can.requestWriteOff && !pendingWo && (
              <div className="px-5 pb-4">
                <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: 'write-off' })}>
                  <FileX className="size-3.5" /> Ask for a write-off
                </Button>
              </div>
            )}
          </Card>

          {c.can.manage && (
            <Button variant="ghost" onClick={() => setOpen({ kind: 'close' })}>
              Close this case…
            </Button>
          )}
        </div>
      </div>

      {open?.kind === 'note' && (
        <ActionDialog
          title="Add to the case history"
          action="Save"
          fields={[
            { key: 'type', label: 'What', type: 'select', required: true, initial: 'CALL', options: [{ value: 'CALL', label: 'Call' }, { value: 'VISIT', label: 'Visit' }, { value: 'NOTE', label: 'Note' }] },
            { key: 'summary', label: 'What happened', type: 'textarea', required: true },
          ]}
          onClose={close}
          onDone={reload}
          submit={post(`/recovery/cases/${c.id}/actions`)}
        />
      )}
      {open?.kind === 'stage' && (
        <ActionDialog
          title="Move to another stage"
          description="Stages marked “needs approval” wait for a second person."
          action="Move"
          fields={[
            { key: 'stage', label: 'Next stage', type: 'select', required: true, options: c.nextStages.map((s) => ({ value: s.code, label: `${s.name}${s.requiresApproval ? ' (needs approval)' : ''}${s.isTerminal ? ' (closes the case)' : ''}` })) },
            { key: 'note', label: 'Why', type: 'textarea', required: true },
          ]}
          onClose={close}
          onDone={reload}
          submit={post(`/recovery/cases/${c.id}/stage`)}
        />
      )}
      {open?.kind === 'reject-stage' && <ActionDialog title="Reject the stage move" action="Reject" fields={[{ key: 'note', label: 'Why', type: 'textarea', required: true }]} onClose={close} onDone={reload} submit={post(`/recovery/cases/${c.id}/stage/reject`)} />}
      {open?.kind === 'repossess' && (
        <ActionDialog
          title="Record repossession"
          description="Only after the steps your legal advisor requires ⚖. This records custody; nothing is posted to the books."
          action="Record repossession"
          danger
          fields={[
            { key: 'repossessedOn', label: 'Date', type: 'date', required: true, initial: today() },
            { key: 'location', label: 'Kept at', required: true, hint: 'Yard or branch where the asset is held' },
            { key: 'conditionNotes', label: 'Condition', type: 'textarea', required: true, hint: 'Odometer, damage, keys, papers' },
            { key: 'valuation', label: 'Valuation (₹)', type: 'money', hint: 'Optional' },
          ]}
          onClose={close}
          onDone={reload}
          submit={(v) => post(`/recovery/cases/${c.id}/repossess`)({ ...v, assetId: open.assetId })}
        />
      )}
      {open?.kind === 'release' && <ActionDialog title="Release the asset to the customer" action="Release" fields={[{ key: 'reason', label: 'Why', type: 'textarea', required: true }]} onClose={close} onDone={reload} submit={(v) => api('POST', `/recovery/cases/${c.id}/assets/${open.assetId}/release`, { body: v })} />}
      {open?.kind === 'sale' && (
        <ActionDialog
          title="Record the sale"
          description="A second person approves it. The money then settles the loan through the customer's advance; anything above the dues is owed back to the customer ⚖."
          action="Send for approval"
          fields={[
            { key: 'salePrice', label: 'Sale price (₹)', type: 'money', required: true },
            { key: 'soldOn', label: 'Sold on', type: 'date', required: true, initial: today() },
            { key: 'buyerName', label: 'Buyer', required: true },
            { key: 'buyerReference', label: 'Invoice / agreement no.' },
            { key: 'accountId', label: 'Money received in', type: 'select', required: true, options: banks.map((b) => ({ value: b.id, label: `${b.code} ${b.name}` })) },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onClose={close}
          onDone={reload}
          submit={(v) => post(`/recovery/cases/${c.id}/sales`)({ ...v, assetId: open.assetId })}
        />
      )}
      {open?.kind === 'reject-sale' && <ActionDialog title="Reject the sale" action="Reject" fields={[{ key: 'note', label: 'Why', type: 'textarea', required: true }]} onClose={close} onDone={reload} submit={post(`/recovery/sales/${open.id}/reject`)} />}
      {open?.kind === 'write-off' && (
        <ActionDialog
          title="Ask for a write-off"
          description="Management decides. Write-offs follow your board-approved policy ⚖."
          action="Send request"
          danger
          fields={[{ key: 'reason', label: 'Why the dues cannot be recovered', type: 'textarea', required: true, hint: 'At least 20 characters: what was tried, where the customer and asset are' }]}
          onClose={close}
          onDone={reload}
          submit={post(`/recovery/cases/${c.id}/write-off`)}
        />
      )}
      {open?.kind === 'reject-write-off' && <ActionDialog title="Reject the write-off" action="Reject" fields={[{ key: 'note', label: 'Why', type: 'textarea', required: true }]} onClose={close} onDone={reload} submit={post(`/recovery/write-offs/${open.id}/reject`)} />}
      {open?.kind === 'close' && <ActionDialog title="Close this case" description="Use a stage that closes the case when dues are cleared; close by hand only when the case was opened by mistake." action="Close case" fields={[{ key: 'reason', label: 'Why', type: 'textarea', required: true }]} onClose={close} onDone={reload} submit={post(`/recovery/cases/${c.id}/close`)} />}
    </>
  );
}

