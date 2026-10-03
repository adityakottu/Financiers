'use client';

import { MESSAGE_EVENT_LABELS } from '@fin/contracts';
import { Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MessageStatus } from '@/components/loan-collections';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Tabs, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError, get, qs } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Message {
  id: string; channel: string; event_code: string; to_number: string; body: string; status: string; skip_reason: string | null; error_text: string | null;
  attempts: number; queued_at: string; sent_at: string | null; delivered_at: string | null; read_at: string | null; available_at: string;
  customer_id: string; customer_name: string; loan_id: string | null; loan_no: string | null; sent_by: string | null; triggered_by: string;
}
interface Template { id: string; channel: string; event_code: string; language: string; body: string; variables: string[]; dlt_template_id: string | null; wa_template_name: string | null; wa_language: string; is_active: boolean; updated_at: string }
interface Rule { id: string; offset_days: number; channel: string; event_code: string; min_amount: string; is_active: boolean }
interface Providers { sms: { provider: string; live: boolean }; whatsapp: { provider: string; live: boolean }; webhooks: { msg91: boolean; whatsapp: boolean } }

type Tab = 'log' | 'templates' | 'reminders';
const ALLOWED: Record<string, string[]> = {
  PAYMENT_RECEIVED: ['name', 'amount', 'loan_no', 'date', 'receipt_no', 'balance', 'company'],
  DUE_REMINDER: ['name', 'amount', 'loan_no', 'due_date', 'company'],
  OVERDUE: ['name', 'amount', 'loan_no', 'due_date', 'company'],
  LOAN_DISBURSED: ['name', 'loan_no', 'amount', 'installment', 'due_date', 'company'],
  LOAN_CLOSED: ['name', 'loan_no', 'company'],
  PAYMENT_REVERSED: ['name', 'receipt_no', 'amount', 'loan_no', 'company'],
};
const channelLabel = (c: string) => (c === 'SMS' ? 'SMS' : 'WhatsApp');

export default function CommunicationsPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('log');
  const providers = useApi<Providers>(can('message.view') ? '/messages/providers' : null);
  if (!can('message.view')) return <EmptyState title="You don’t have access to communications" />;
  const p = providers.data;
  return (
    <>
      <PageHeader title="Communications" subtitle="SMS and WhatsApp to customers — official provider APIs only, with consent" />
      {p && (!p.sms.live || !p.whatsapp.live) && (
        <div className="mb-4">
          <Alert tone="warn">
            Test mode for {[!p.sms.live && 'SMS', !p.whatsapp.live && 'WhatsApp'].filter(Boolean).join(' and ')}: messages are prepared and logged as “Not sent (test mode)”, but nothing reaches customers. Configure MSG91 (DLT-registered templates) and the WhatsApp Business Cloud API in the server
            environment to go live.
          </Alert>
        </div>
      )}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'log', label: 'Message log' },
          { id: 'templates', label: 'Templates' },
          { id: 'reminders', label: 'Reminder rules' },
        ]}
      />
      <div className="mt-5">
        {tab === 'log' && <Log />}
        {tab === 'templates' && <Templates />}
        {tab === 'reminders' && <Reminders />}
      </div>
    </>
  );
}

function Log() {
  const { can } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [rows, setRows] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setRows(null);
    get<{ data: Message[]; nextCursor: string | null }>(`/messages${qs({ status, channel, limit: 100 })}`).then((r) => {
      setRows(r.data);
      setCursor(r.nextCursor);
    });
  }, [status, channel, tick]);
  const [relay, relaying] = useSubmit(async () => {
    try {
      const r = await api<{ sent: number; simulated: number; failed: number; retried: number }>('POST', '/messages/relay');
      toast('ok', `Sent ${r.sent}, test-mode ${r.simulated}, failed ${r.failed}, retrying ${r.retried}`);
      setTick((n) => n + 1);
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  });
  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-end">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SIMULATED', 'SKIPPED'].map((s) => (
              <option key={s} value={s}>
                {s === 'SIMULATED' ? 'Not sent (test mode)' : s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All</option>
            <option value="SMS">SMS</option>
            <option value="WHATSAPP">WhatsApp</option>
          </Select>
        </Field>
        {can('message.configure') && (
          <Button variant="secondary" className="sm:ml-auto" onClick={() => relay()} loading={relaying}>
            <Send className="size-4" /> Send queued now
          </Button>
        )}
      </div>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No messages" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Queued</Th>
              <Th>To</Th>
              <Th>Message</Th>
              <Th>Status</Th>
              <Th>Sent by</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <Td className="whitespace-nowrap text-[12px]">{dateTime(m.queued_at)}</Td>
                <Td className="min-w-36">
                  <Link href={`/customers/${m.customer_id}`} className="font-medium hover:underline">
                    {m.customer_name}
                  </Link>
                  <p className="num text-[12px] text-muted">
                    {channelLabel(m.channel)} · {m.to_number}
                    {m.loan_no && (
                      <>
                        {' · '}
                        <Link href={`/loans/${m.loan_id}`} className="hover:underline">
                          {m.loan_no}
                        </Link>
                      </>
                    )}
                  </p>
                </Td>
                <Td className="max-w-md">
                  <p className="text-[12px] font-medium">{MESSAGE_EVENT_LABELS[m.event_code as keyof typeof MESSAGE_EVENT_LABELS] ?? m.event_code}</p>
                  <p className="line-clamp-2 text-[12px] text-muted">{m.body}</p>
                  {(m.skip_reason || m.error_text) && <p className="text-[12px] text-warn">{m.skip_reason ?? m.error_text}</p>}
                </Td>
                <Td>
                  <MessageStatus status={m.status} />
                  {m.status === 'QUEUED' && new Date(m.available_at) > new Date() && <p className="mt-0.5 text-[11px] text-subtle">sends {dateTime(m.available_at)}</p>}
                </Td>
                <Td className="text-[12px] text-muted">{m.sent_by ?? 'Automatic'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {cursor && <p className="border-t border-line px-4 py-2 text-[12px] text-muted">Showing the latest 100.</p>}
    </Card>
  );
}

function Templates() {
  const { can } = useSession();
  const { data, reload } = useApi<{ data: Template[] }>('/message-templates');
  const [edit, setEdit] = useState<Template | null>(null);
  if (!data) return <Spinner />;
  return (
    <Card>
      <CardHeader title="Message templates" description="SMS templates must match the DLT-registered text exactly; WhatsApp templates must be approved in WhatsApp Manager. ⚖ Have wording reviewed for fair-practice compliance." />
      <Table>
        <thead>
          <tr>
            <Th>Message</Th>
            <Th>Channel</Th>
            <Th>Text</Th>
            <Th>Registration</Th>
            <Th>Status</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {data.data.map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">{MESSAGE_EVENT_LABELS[t.event_code as keyof typeof MESSAGE_EVENT_LABELS] ?? t.event_code}</Td>
              <Td>{channelLabel(t.channel)}</Td>
              <Td className="max-w-md text-[12px] text-muted">{t.body}</Td>
              <Td className="num text-[12px]">{t.channel === 'SMS' ? (t.dlt_template_id ?? <span className="text-warn">No DLT ID</span>) : (t.wa_template_name ?? <span className="text-warn">No template name</span>)}</Td>
              <Td>{t.is_active ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}</Td>
              <Td className="text-right">
                {can('message.configure') && (
                  <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
                    Edit
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {edit && <TemplateDialog t={edit} onClose={() => setEdit(null)} onDone={reload} />}
    </Card>
  );
}

function TemplateDialog({ t, onClose, onDone }: { t: Template; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState(t.body);
  const [dlt, setDlt] = useState(t.dlt_template_id ?? '');
  const [wa, setWa] = useState(t.wa_template_name ?? '');
  const [lang, setLang] = useState(t.wa_language);
  const [active, setActive] = useState(t.is_active);
  const [error, setError] = useState<ApiError | null>(null);
  const [go, busy] = useSubmit(async () => {
    setError(null);
    try {
      await api('PUT', `/message-templates/${t.id}`, { body: { body, dltTemplateId: dlt || null, waTemplateName: wa || null, waLanguage: lang, isActive: active } });
      toast('ok', 'Template saved');
      onClose();
      onDone();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  const fe = error?.fieldErrors() ?? {};
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${MESSAGE_EVENT_LABELS[t.event_code as keyof typeof MESSAGE_EVENT_LABELS]} · ${channelLabel(t.channel)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => go()} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && !Object.keys(fe).length && <Alert>{error.message}</Alert>}
        <Field label="Text" required error={fe.body} hint={`Placeholders: ${ALLOWED[t.event_code]!.map((v) => `{{${v}}}`).join(' ')}`}>
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} />
        </Field>
        {t.channel === 'SMS' ? (
          <Field label="DLT template ID" error={fe.dltTemplateId} hint="From your DLT portal (Jio, Vodafone Idea, Airtel…). Required before SMS can be sent.">
            <Input value={dlt} onChange={(e) => setDlt(e.target.value)} className="num font-mono" inputMode="numeric" />
          </Field>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
            <Field label="Approved template name" error={fe.waTemplateName} hint="Exactly as approved in WhatsApp Manager; body variables in the same order.">
              <Input value={wa} onChange={(e) => setWa(e.target.value)} className="num font-mono" />
            </Field>
            <Field label="Language code" error={fe.waLanguage}>
              <Input value={lang} onChange={(e) => setLang(e.target.value)} className="num font-mono" />
            </Field>
          </div>
        )}
        <Checkbox label="Template is on" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </div>
    </Dialog>
  );
}

function Reminders() {
  const { can } = useSession();
  const toast = useToast();
  const { data, reload } = useApi<{ data: Rule[] }>('/reminder-rules');
  if (!data) return <Spinner />;
  async function toggle(r: Rule) {
    try {
      await api('PUT', `/reminder-rules/${r.id}`, { body: { isActive: !r.is_active, minAmount: r.min_amount } });
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  }
  const when = (d: number) => (d < 0 ? `${-d} day${d === -1 ? '' : 's'} before due` : d === 0 ? 'On the due date' : `${d} day${d === 1 ? '' : 's'} overdue`);
  return (
    <Card>
      <CardHeader title="Automatic reminders" description="Queued by the nightly job and sent between 09:00 and 20:00 IST. Each rule fires once per installment. WhatsApp only goes to customers who agreed to it." />
      <Table>
        <thead>
          <tr>
            <Th>When</Th>
            <Th>Channel</Th>
            <Th>Message</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {data.data
            .slice()
            .sort((a, b) => a.offset_days - b.offset_days || a.channel.localeCompare(b.channel))
            .map((r) => (
              <tr key={r.id}>
                <Td>{when(r.offset_days)}</Td>
                <Td>{channelLabel(r.channel)}</Td>
                <Td>{MESSAGE_EVENT_LABELS[r.event_code as keyof typeof MESSAGE_EVENT_LABELS]}</Td>
                <Td>
                  {can('message.configure') ? (
                    <Checkbox label={r.is_active ? 'On' : 'Off'} checked={r.is_active} onChange={() => toggle(r)} />
                  ) : r.is_active ? (
                    <Badge tone="ok">On</Badge>
                  ) : (
                    <Badge>Off</Badge>
                  )}
                </Td>
              </tr>
            ))}
        </tbody>
      </Table>
    </Card>
  );
}
