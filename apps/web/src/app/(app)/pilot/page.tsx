'use client';

import { CheckCircle2, FileSpreadsheet, GitCompare, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Summary { oldTotal: string; appTotal: string; difference: string; oldRows: number; appPayments: number; matched: number; differences: number; dayClosedInApp: boolean }
interface DayRow { id: string; date: string; fileName: string; signedOffAt: string | null; signedOffBy: string | null; note: string | null; summary: Summary }
interface Line { loanId: string; loanNo: string; legacyNo: string | null; customer: string; oldAmount: string; appAmount: string; difference: string; oldMethods: Record<string, string>; appMethods: Record<string, string>; oldReceipts: string[]; appReceipts: string[]; status: string }
interface Day {
  id: string;
  branch_code: string;
  business_date: string;
  file_name: string;
  uploaded_by_name: string;
  uploaded_at: string;
  signed_off_at: string | null;
  signed_off_by_name: string | null;
  sign_off_note: string | null;
  frozen: boolean;
  comparison: { summary: Summary; byMethod: { method: string; old: string; app: string; difference: string }[]; lines: Line[]; unknown: { row: number; loanRef: string; amount: string; method: string }[] };
}

const LINE: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' | 'info' }> = {
  MATCHED: { label: 'Matches', tone: 'ok' },
  AMOUNT_DIFFERS: { label: 'Amount differs', tone: 'bad' },
  METHOD_DIFFERS: { label: 'Method differs', tone: 'warn' },
  ONLY_IN_OLD: { label: 'Only in old sheet', tone: 'bad' },
  ONLY_IN_SYSTEM: { label: 'Only in the app', tone: 'bad' },
};
const methods = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k.replace('_', ' ').toLowerCase()} ${inr(v)}`).join(', ') || '—';
const yesterday = () => new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);

/** Pilot parallel run (doc 15): the old process's day sheet against the app, every day of the pilot. */
export default function PilotPage() {
  const { me, can } = useSession();
  const { data: branches } = useApi<{ data: { id: string; code: string; name: string }[] }>('/branches');
  const [branch, setBranch] = useState('');
  useEffect(() => {
    if (!branch && branches?.data.length) setBranch((me?.branches[0] && branches.data.find((b) => b.id === me.branches[0]!.id)?.id) ?? branches.data[0]!.id);
  }, [branches, branch, me]);
  const { data, loading, reload } = useApi<{ data: DayRow[]; exit: { signedOffDays: number; cleanDays: number; explainedDays: number; target: number } }>(branch ? `/pilot/days?branchId=${branch}` : null);
  const [open, setOpen] = useState<string | null>(null);
  const [day, setDay] = useState(yesterday());
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [upload, uploading] = useSubmit(async () => {
    setError(null);
    const fd = new FormData();
    fd.append('branchId', branch);
    fd.append('date', day);
    fd.append('file', file!);
    try {
      const d = await api<Day>('POST', '/pilot/days', { body: fd });
      setFile(null);
      reload();
      setOpen(d.id);
    } catch (e) {
      setError(e as ApiError);
    }
  });

  return (
    <>
      <PageHeader
        title="Pilot comparison"
        subtitle="During the pilot the branch keeps its old process. Each day, upload the old day sheet; it is compared with the app loan by loan."
        actions={
          <a href="/api/v1/imports/templates/parallel-run" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-canvas">
            <FileSpreadsheet className="size-4" /> Day-sheet template
          </a>
        }
      />
      <div className="space-y-6">
        <Card>
          <form
            className="flex flex-wrap items-end gap-3 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              upload();
            }}
          >
            <Field label="Branch">
              <Select value={branch} onChange={(e) => setBranch(e.target.value)}>
                {branches?.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Day">
              <Input type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label="Old day sheet (.xlsx or .csv)">
              <Input type="file" required accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Button type="submit" loading={uploading} disabled={!file || !branch}>
              <Upload className="size-4" /> Compare
            </Button>
            {error && (
              <div className="w-full">
                <Alert>
                  {error.message}
                  {Array.isArray(error.details) && (
                    <ul className="mt-1 list-disc pl-5">
                      {(error.details as unknown as { row: number; field: string; message: string }[]).slice(0, 10).map((d, i) => (
                        <li key={i}>
                          Row {d.row}
                          {d.field ? ` (${d.field})` : ''}: {d.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </Alert>
              </div>
            )}
          </form>
        </Card>

        {data && (
          <Alert tone={data.exit.cleanDays + data.exit.explainedDays >= data.exit.target ? 'ok' : 'info'}>
            Pilot exit (checklist F1): <strong>{data.exit.signedOffDays}</strong> of {data.exit.target}+ business days signed off — {data.exit.cleanDays} with no differences, {data.exit.explainedDays} with every difference explained.
          </Alert>
        )}

        <Card>
          <CardHeader title="Days" />
          {loading && !data ? (
            <Spinner />
          ) : !data?.data.length ? (
            <EmptyState icon={<GitCompare className="size-5" />} title="No days compared yet" body="Upload yesterday’s day sheet from the old process to start." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Day</Th>
                    <Th className="text-right">Old sheet</Th>
                    <Th className="text-right">App</Th>
                    <Th className="text-right">Difference</Th>
                    <Th>Loans</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((d) => (
                    <tr key={d.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(d.id)}>
                      <Td>{date(d.date)}</Td>
                      <Td className="text-right tabular-nums">{inr(d.summary.oldTotal)}</Td>
                      <Td className="text-right tabular-nums">{inr(d.summary.appTotal)}</Td>
                      <Td className={`text-right tabular-nums ${Number(d.summary.difference) !== 0 ? 'text-bad' : ''}`}>{inr(d.summary.difference)}</Td>
                      <Td className="text-[13px]">
                        {d.summary.matched} match{d.summary.differences > 0 && <span className="text-bad"> · {d.summary.differences} differ</span>}
                      </Td>
                      <Td>{d.signedOffAt ? <Badge tone="ok">Signed off by {d.signedOffBy}</Badge> : <Badge tone="warn">To sign off</Badge>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>
      {open && <DayDialog id={open} canSign={can('pilot.sign_off')} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function DayDialog({ id, canSign, onClose, onChanged }: { id: string; canSign: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data: d, reload } = useApi<Day>(`/pilot/days/${id}`);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sign, signing] = useSubmit(async () => {
    setError(null);
    try {
      await api('POST', `/pilot/days/${id}/sign-off`, { body: note.trim() ? { note } : {} });
      toast('ok', 'Day signed off');
      reload();
      onChanged();
    } catch (e) {
      setError((e as ApiError).message);
    }
  });
  const s = d?.comparison.summary;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={d ? `${d.branch_code} · ${date(d.business_date)}` : 'Day'}
      description={d ? `${d.file_name} — uploaded by ${d.uploaded_by_name}, ${dateTime(d.uploaded_at)}` : undefined}
      footer={
        d && !d.signed_off_at && canSign ? (
          <Button onClick={() => sign()} loading={signing}>
            <CheckCircle2 className="size-4" /> Sign off this day
          </Button>
        ) : undefined
      }
    >
      {!d || !s ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-[14px]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Old sheet" value={inr(s.oldTotal)} sub={`${s.oldRows} rows`} />
            <Stat label="In the app" value={inr(s.appTotal)} sub={`${s.appPayments} payments`} />
            <Stat label="Difference" value={inr(s.difference)} bad={Number(s.difference) !== 0} />
            <Stat label="Loans" value={`${s.matched} match`} sub={s.differences ? `${s.differences} differ` : 'no differences'} bad={s.differences > 0} />
          </div>
          {!s.dayClosedInApp && !d.signed_off_at && <Alert tone="warn">This day is not closed in the app yet. Close it under Reconciliation before signing off.</Alert>}
          {d.signed_off_at && (
            <Alert tone="ok">
              Signed off by {d.signed_off_by_name}, {dateTime(d.signed_off_at)}. {d.frozen && 'The comparison is frozen as it was at sign-off.'}
              {d.sign_off_note && <div className="mt-1 italic">“{d.sign_off_note}”</div>}
            </Alert>
          )}
          <div className="overflow-x-auto rounded-lg border border-line">
            <Table>
              <thead>
                <tr>
                  <Th>Method</Th>
                  <Th className="text-right">Old sheet</Th>
                  <Th className="text-right">App</Th>
                  <Th className="text-right">Difference</Th>
                </tr>
              </thead>
              <tbody>
                {d.comparison.byMethod.map((m) => (
                  <tr key={m.method}>
                    <Td>{m.method.replace('_', ' ').toLowerCase()}</Td>
                    <Td className="text-right tabular-nums">{inr(m.old)}</Td>
                    <Td className="text-right tabular-nums">{inr(m.app)}</Td>
                    <Td className={`text-right tabular-nums ${Number(m.difference) !== 0 ? 'text-bad' : ''}`}>{inr(m.difference)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {d.comparison.unknown.length > 0 && (
            <Alert>
              Not found in this branch: {d.comparison.unknown.map((u) => `${u.loanRef} (row ${u.row}, ${inr(u.amount)})`).join('; ')}
            </Alert>
          )}
          <div className="max-h-96 overflow-auto rounded-lg border border-line">
            <Table>
              <thead>
                <tr>
                  <Th>Loan</Th>
                  <Th>Old sheet</Th>
                  <Th>App</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {d.comparison.lines.map((l) => (
                  <tr key={l.loanId}>
                    <Td>
                      <a href={`/loans/${l.loanId}`} className="font-mono text-[13px] text-accent-strong hover:underline">
                        {l.loanNo}
                      </a>
                      {l.legacyNo && <span className="text-muted"> · {l.legacyNo}</span>}
                      <div className="text-[12px] text-muted">{l.customer}</div>
                    </Td>
                    <Td className="text-[13px]">
                      {methods(l.oldMethods)}
                      {l.oldReceipts.length > 0 && <div className="text-muted">{l.oldReceipts.join(', ')}</div>}
                    </Td>
                    <Td className="text-[13px]">
                      {methods(l.appMethods)}
                      {l.appReceipts.length > 0 && <div className="text-muted">{l.appReceipts.join(', ')}</div>}
                    </Td>
                    <Td>
                      <Badge tone={LINE[l.status]?.tone ?? 'info'}>{LINE[l.status]?.label ?? l.status}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {!d.signed_off_at && canSign && (
            <Field label={s.differences ? 'Explain every difference (required)' : 'Note (optional)'}>
              <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. OLD-L-1187 paid at home after the counter closed; entered next morning." />
            </Field>
          )}
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`text-[17px] font-semibold tabular-nums ${bad ? 'text-bad' : ''}`}>{value}</div>
      {sub && <div className="text-[12px] text-muted">{sub}</div>}
    </div>
  );
}
