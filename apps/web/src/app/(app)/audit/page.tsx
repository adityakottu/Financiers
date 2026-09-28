'use client';

import { ChevronDown, ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Spinner, Table, Td, Th } from '@/components/ui';
import { api, get, qs } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Row {
  id: string;
  at: string;
  username: string | null;
  role_codes: string[];
  ip: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  request_id: string | null;
}

const TONE: [RegExp, 'bad' | 'warn' | 'info' | 'neutral'][] = [
  [/locked|disabled|revealed|mfa_reset|force_logout|access_changed/, 'bad'],
  [/reset|password|mfa/, 'warn'],
  [/created|login/, 'info'],
];

function Diff({ oldV, newV }: { oldV: Record<string, unknown> | null; newV: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(oldV ?? {}), ...Object.keys(newV ?? {})])];
  if (!keys.length) return <p className="text-[12px] text-subtle">No field values recorded.</p>;
  const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <table className="w-full text-[12px]">
      <thead>
        <tr className="text-left text-subtle">
          <th className="py-1 pr-4 font-medium">Field</th>
          {oldV && <th className="py-1 pr-4 font-medium">Before</th>}
          <th className="py-1 font-medium">{oldV ? 'After' : 'Value'}</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="align-top">
            <td className="py-1 pr-4 font-mono text-muted">{k}</td>
            {oldV && <td className="break-all py-1 pr-4 font-mono text-bad/80">{show(oldV[k])}</td>}
            <td className="break-all py-1 font-mono text-ok">{show(newV?.[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function AuditPage() {
  const { can, me } = useSession();
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const a = useDebounced(action.trim(), 300);
  const e = useDebounced(entityId.trim(), 300);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [chain, setChain] = useState<{ ok: boolean; checked: number; brokenAtId: string | null } | null>(null);
  const filters = { action: a, entityId: e, from, to, limit: 50 };

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    get<{ data: Row[]; nextCursor: string | null }>(`/audit-logs${qs(filters)}`, ctrl.signal)
      .then((r) => {
        setRows(r.data);
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, e, from, to]);

  if (!can('audit.view')) return <EmptyState title="You don’t have access to the audit log" />;

  async function more() {
    const r = await get<{ data: Row[]; nextCursor: string | null }>(`/audit-logs${qs({ ...filters, cursor })}`);
    setRows((p) => [...p, ...r.data]);
    setCursor(r.nextCursor);
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every sensitive action, who did it, and what changed. Entries cannot be edited or deleted."
        actions={
          me?.scope === 'ALL' && (
            <Button variant="secondary" onClick={async () => setChain(await api('GET', '/audit-logs/verify'))}>
              <ShieldCheck className="size-4" /> Verify integrity
            </Button>
          )
        }
      />
      {chain && (
        <div className="mb-4">
          {chain.ok ? (
            <Alert tone="ok">Integrity verified: all {chain.checked.toLocaleString('en-IN')} entries are intact and in sequence.</Alert>
          ) : (
            <Alert>
              <span className="inline-flex items-center gap-1.5 font-medium">
                <ShieldAlert className="size-4" /> Chain broken at entry #{chain.brokenAtId}.
              </span>{' '}
              History was altered outside the application. Escalate to management immediately.
            </Alert>
          )}
        </div>
      )}
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input placeholder="Action, e.g. customer. or auth.login" value={action} onChange={(ev) => setAction(ev.target.value)} aria-label="Action" />
          <Input placeholder="Record ID" value={entityId} onChange={(ev) => setEntityId(ev.target.value)} aria-label="Record ID" className="font-mono" />
          <Input type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} aria-label="From date" />
          <Input type="date" value={to} onChange={(ev) => setTo(ev.target.value)} aria-label="To date" />
        </div>
        {loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No entries match" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-8" />
                  <Th>When</Th>
                  <Th>User</Th>
                  <Th>Action</Th>
                  <Th>Record</Th>
                  <Th>IP</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open.has(r.id);
                  const tone = TONE.find(([re]) => re.test(r.action))?.[1] ?? 'neutral';
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className="cursor-pointer hover:bg-canvas/60"
                        onClick={() => setOpen((s) => (s.has(r.id) ? new Set([...s].filter((x) => x !== r.id)) : new Set([...s, r.id])))}
                      >
                        <Td className="text-subtle">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Td>
                        <Td className="num whitespace-nowrap text-muted">{dateTime(r.at)}</Td>
                        <Td>{r.username ? `@${r.username}` : <span className="text-subtle">system / anonymous</span>}</Td>
                        <Td>
                          <Badge tone={tone}>{r.action}</Badge>
                        </Td>
                        <Td className="max-w-[16rem] truncate font-mono text-[12px] text-muted">{r.entity_type ? `${r.entity_type}:${r.entity_id}` : '—'}</Td>
                        <Td className="num text-muted">{r.ip ?? '—'}</Td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-canvas/40">
                          <Td />
                          <Td colSpan={5}>
                            <Diff oldV={r.old_values} newV={r.new_values} />
                            <p className="mt-2 text-[11px] text-subtle">
                              #{r.id} · roles {r.role_codes.join(', ') || '—'} · request {r.request_id ?? '—'}
                              {r.reason && ` · reason: ${r.reason}`}
                            </p>
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
            {cursor && (
              <div className="border-t border-line p-3 text-center">
                <Button variant="secondary" size="sm" onClick={more}>
                  Load older entries
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
