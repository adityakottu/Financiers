'use client';

import { MESSAGE_EVENT_LABELS, VISIT_OUTCOME_LABELS } from '@fin/contracts';
import { FileText, MessageSquare, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError, get } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { VisitDialog } from './collections';
import { MethodLabel, PaymentStatusBadge } from './payments';
import { useToast } from './toast';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Select, Spinner, Table, Td, Th } from './ui';

export interface PaymentRow {
  id: string;
  payment_no: string;
  amount: string;
  method: string;
  reference_no: string | null;
  status: string;
  received_at: string;
  value_date: string;
  receipt_no: string | null;
  receipt_status: string | null;
  collected_by_name: string | null;
  loan_id: string;
  loan_no: string;
  customer_id: string;
  customer_name: string;
  branch_code: string;
  advance_amount: string;
  cheque_status: string | null;
}

export function PaymentsTable({ rows, showLoan }: { rows: PaymentRow[]; showLoan?: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Received</Th>
          <Th>Payment</Th>
          {showLoan && <Th>Customer · loan</Th>}
          <Th>Method</Th>
          <Th className="text-right">Amount</Th>
          <Th>Status</Th>
          <Th>Collected by</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id} className={p.status === 'REVERSED' ? 'text-subtle' : ''}>
            <Td className="whitespace-nowrap text-[12px]">{dateTime(p.received_at)}</Td>
            <Td>
              <Link href={`/payments/${p.id}`} className="num font-mono text-[12px] font-medium text-ink-900 hover:underline">
                {p.payment_no}
              </Link>
              {p.receipt_no && <p className="num font-mono text-[11px] text-muted">{p.receipt_no}</p>}
            </Td>
            {showLoan && (
              <Td className="min-w-40">
                <Link href={`/loans/${p.loan_id}`} className="font-medium hover:underline">
                  {p.customer_name}
                </Link>
                <p className="num text-[12px] text-muted">
                  {p.loan_no} · {p.branch_code}
                </p>
              </Td>
            )}
            <Td className="whitespace-nowrap">
              <MethodLabel method={p.method} reference={p.reference_no} />
              {p.cheque_status && <p className="text-[11px] text-muted">Cheque {p.cheque_status.toLowerCase()}</p>}
            </Td>
            <Td className={`num whitespace-nowrap text-right font-medium ${p.status === 'REVERSED' ? 'line-through' : ''}`}>{inr(p.amount)}</Td>
            <Td>
              <PaymentStatusBadge status={p.status} />
            </Td>
            <Td className="text-[12px] text-muted">{p.collected_by_name ?? 'Counter / office'}</Td>
            <Td className="text-right">
              {p.receipt_no && (
                <a href={`/api/v1/payments/${p.id}/receipt.pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] text-accent-strong hover:underline">
                  <FileText className="size-3.5" /> Receipt
                </a>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function LoanPaymentsPanel({ loanId, refresh }: { loanId: string; refresh: number }) {
  const { data, loading, reload } = useApi<{ data: PaymentRow[] }>(`/payments?loanId=${loanId}&limit=200`);
  useEffect(() => {
    if (refresh) reload();
  }, [refresh, reload]);
  if (loading && !data) return <Spinner />;
  const rows = data?.data ?? [];
  const live = rows.filter((r) => r.status !== 'REVERSED');
  return (
    <Card>
      <CardHeader title="Payments" description={`${live.length} payments · ${inr(live.reduce((s, r) => s + Number(r.amount), 0).toFixed(2))} received${rows.length > live.length ? ` · ${rows.length - live.length} reversed` : ''}`} />
      {rows.length ? <PaymentsTable rows={rows} /> : <EmptyState title="No payments yet" body="Payments recorded by collectors or at the counter appear here with their receipts." />}
    </Card>
  );
}

interface Activity {
  visits: { id: string; visited_at: string; outcome: string; notes: string | null; by: string | null }[];
  promises: { id: string; promised_amount: string; promised_date: string; status: string; paid_amount: string; created_at: string }[];
  assignments: { id: string; from_at: string; to_at: string | null; reason: string | null; employee: string; by: string | null }[];
}
interface Message {
  id: string;
  channel: string;
  event_code: string;
  status: string;
  skip_reason: string | null;
  error_text: string | null;
  queued_at: string;
  body: string;
  sent_by: string | null;
}

const MSG_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = { DELIVERED: 'ok', READ: 'ok', SENT: 'info', QUEUED: 'neutral', SENDING: 'neutral', FAILED: 'bad', SKIPPED: 'neutral', SIMULATED: 'warn' };
export function MessageStatus({ status }: { status: string }) {
  return <Badge tone={MSG_TONE[status] ?? 'neutral'}>{status === 'SIMULATED' ? 'Not sent (test mode)' : titleCase(status)}</Badge>;
}

export function LoanCollectionsPanel({ loan, onChanged }: { loan: { id: string; loan_no: string; customer_name: string; status: string; branch_id: string; overdue_amount: string; collector: { id: string; full_name: string } | null }; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<Activity>(`/loans/${loan.id}/collections`);
  const messages = useApi<{ data: Message[] }>(can('message.view') ? `/messages?loanId=${loan.id}&limit=30` : null);
  const [collectors, setCollectors] = useState<{ id: string; full_name: string; branch_id: string; active_loans: string }[] | null>(null);
  const [assignTo, setAssignTo] = useState(loan.collector?.id ?? '');
  const [visit, setVisit] = useState(false);
  const active = loan.status === 'ACTIVE';

  useEffect(() => {
    if (can('collection.assign')) get<{ data: NonNullable<typeof collectors> }>(`/collections/collectors?branchId=${loan.branch_id}`).then((r) => setCollectors(r.data)).catch(() => setCollectors([]));
  }, [can, loan.branch_id]);

  const [assign, assigning] = useSubmit(async () => {
    try {
      await api('POST', '/collections/assign', { body: { loanIds: [loan.id], employeeId: assignTo || null } });
      toast('ok', assignTo ? 'Collector assigned' : 'Collector removed');
      onChanged();
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  const [send, sending] = useSubmit(async (channel: 'SMS' | 'WHATSAPP') => {
    try {
      const r = await api<{ status: string; reason?: string }>('POST', `/loans/${loan.id}/messages`, { body: { channel, eventCode: Number(loan.overdue_amount) > 0 ? 'OVERDUE' : 'DUE_REMINDER' } });
      toast(r.status === 'SKIPPED' ? 'bad' : 'ok', r.status === 'SKIPPED' ? `Not sent: ${r.reason}` : `${channel === 'SMS' ? 'SMS' : 'WhatsApp'} reminder queued`);
      messages.reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader title="Collector" description="Who visits this customer and collects installments." />
        <div className="space-y-3 p-5">
          <p className="flex items-center gap-2 text-sm">
            <UserCheck className="size-4 text-subtle" />
            {loan.collector ? <span className="font-medium">{loan.collector.full_name}</span> : <span className="text-muted">Not assigned</span>}
          </p>
          {can('collection.assign') && ['ACTIVE', 'APPROVED'].includes(loan.status) && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Collector" className="sm:max-w-xs">
                <option value="">— No collector —</option>
                {(collectors ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} ({c.active_loans} loans)
                  </option>
                ))}
              </Select>
              <Button variant="secondary" onClick={() => assign()} loading={assigning} disabled={(assignTo || null) === (loan.collector?.id ?? null)}>
                Save
              </Button>
            </div>
          )}
          {data && data.assignments.length > 0 && (
            <ul className="space-y-1 border-t border-line pt-3 text-[12px] text-muted">
              {data.assignments.map((a) => (
                <li key={a.id}>
                  {a.employee} · from {dateTime(a.from_at)}
                  {a.to_at ? ` to ${dateTime(a.to_at)}` : ' (current)'}
                  {a.by ? ` · by ${a.by}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Messages"
          description="Sent through the official SMS and WhatsApp Business APIs only."
          actions={
            can('message.send') && active ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => send('SMS')} loading={sending}>
                  <MessageSquare className="size-3.5" /> SMS reminder
                </Button>
                <Button size="sm" variant="secondary" onClick={() => send('WHATSAPP')} loading={sending}>
                  WhatsApp
                </Button>
              </>
            ) : undefined
          }
        />
        {!can('message.view') ? (
          <p className="p-5 text-[13px] text-muted">You can send reminders; the message log is visible to managers.</p>
        ) : !messages.data ? (
          <Spinner />
        ) : messages.data.data.length === 0 ? (
          <EmptyState title="No messages yet" />
        ) : (
          <ul className="divide-y divide-line">
            {messages.data.data.map((m) => (
              <li key={m.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium">
                    {m.channel === 'SMS' ? 'SMS' : 'WhatsApp'} · {MESSAGE_EVENT_LABELS[m.event_code as keyof typeof MESSAGE_EVENT_LABELS] ?? m.event_code}
                  </p>
                  <MessageStatus status={m.status} />
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{m.body}</p>
                <p className="mt-0.5 text-[11px] text-subtle">
                  {dateTime(m.queued_at)}
                  {m.sent_by ? ` · by ${m.sent_by}` : ' · automatic'}
                  {m.skip_reason ? ` · ${m.skip_reason}` : ''}
                  {m.error_text ? ` · ${m.error_text}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader
          title="Visits & promises"
          actions={
            can('payment.collect') && active ? (
              <Button size="sm" variant="secondary" onClick={() => setVisit(true)}>
                Record visit
              </Button>
            ) : undefined
          }
        />
        {!data ? (
          <Spinner />
        ) : data.visits.length === 0 && data.promises.length === 0 ? (
          <EmptyState title="No visits recorded" />
        ) : (
          <div className="grid grid-cols-1 gap-px bg-line md:grid-cols-2">
            <ul className="divide-y divide-line bg-surface">
              {data.visits.map((v) => (
                <li key={v.id} className="px-5 py-3 text-[13px]">
                  <p className="font-medium">{VISIT_OUTCOME_LABELS[v.outcome as keyof typeof VISIT_OUTCOME_LABELS] ?? v.outcome}</p>
                  {v.notes && <p className="text-muted">{v.notes}</p>}
                  <p className="text-[11px] text-subtle">
                    {dateTime(v.visited_at)}
                    {v.by ? ` · ${v.by}` : ''}
                  </p>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-line bg-surface">
              {data.promises.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
                  <span>
                    Promised <span className="num font-medium">{inr(p.promised_amount)}</span> by {date(p.promised_date)}
                    {p.status !== 'OPEN' && p.status !== 'CANCELLED' && <span className="block text-[12px] text-muted">paid {inr(p.paid_amount)}</span>}
                  </span>
                  <Badge tone={p.status === 'KEPT' ? 'ok' : p.status === 'BROKEN' ? 'bad' : p.status === 'PARTIAL' ? 'warn' : 'info'}>{titleCase(p.status)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      {visit && <VisitDialog card={loan} onClose={() => setVisit(false)} onDone={reload} />}
      {!active && loan.status !== 'APPROVED' && <Alert tone="info">Collections apply to active loans.</Alert>}
    </div>
  );
}

