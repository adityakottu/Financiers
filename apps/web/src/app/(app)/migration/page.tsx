'use client';

import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { useState } from 'react';
import { useStepUp } from '@/components/step-up';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

type Kind = 'CUSTOMERS' | 'LOANS';
interface RowError { row: number; field: string | null; message: string }
interface Batch {
  id: string;
  batch_no: string;
  kind: Kind;
  file_name: string;
  cutover_date: string | null;
  status: 'VALIDATED' | 'REJECTED' | 'CONFIRMED' | 'CANCELLED';
  rows_total: number;
  rows_valid: number;
  rows_invalid: number;
  totals: Record<string, string | number>;
  uploaded_at: string;
  uploaded_by: string;
  uploaded_by_name: string;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  errors?: RowError[];
}

const TONE = { VALIDATED: 'info', REJECTED: 'bad', CONFIRMED: 'ok', CANCELLED: 'neutral' } as const;
const STATUS = { VALIDATED: 'Waiting for confirmation', REJECTED: 'Rejected — fix and upload again', CONFIRMED: 'Imported', CANCELLED: 'Cancelled' };
const KIND = { CUSTOMERS: 'Customers', LOANS: 'Running loans' };

function TemplateLink({ kind, label }: { kind: string; label: string }) {
  return (
    <a href={`/api/v1/imports/templates/${kind}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium hover:bg-canvas">
      <FileSpreadsheet className="size-4" /> {label}
    </a>
  );
}

/** Data migration from the old system (Phase 9): upload → check → a second person confirms. */
export default function MigrationPage() {
  const { can } = useSession();
  const { data, loading, reload } = useApi<{ data: Batch[] }>('/imports');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="Data migration"
        subtitle="Bring customers and running loans over from the old system. Every row is checked; nothing is created until a second person confirms."
        actions={
          <>
            <TemplateLink kind="customers" label="Customers template" />
            <TemplateLink kind="loans" label="Loans template" />
          </>
        }
      />
      <div className="space-y-6">
        <Alert tone="info">
          Order: 1) customers, 2) running loans (each loan’s principal outstanding must equal the old ledger), 3) opening cash, bank and other balances by{' '}
          <a className="underline" href="/journals">manual journal</a> against 3900, 4) compare the trial balance with the old books ⚖. ID numbers (Aadhaar, PAN…) are never bulk-imported — collect KYC in the app.
        </Alert>
        {can('import.run') && <UploadCard onDone={(id) => { reload(); setOpen(id); }} />}
        <Card>
          <CardHeader title="Imports" description="The latest 100 uploads" />
          {loading && !data ? (
            <Spinner />
          ) : !data?.data.length ? (
            <EmptyState icon={<Upload className="size-5" />} title="No imports yet" body="Download a template, fill it from the old system and upload it here." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Import</Th>
                    <Th>What</Th>
                    <Th className="text-right">Rows</Th>
                    <Th className="text-right">With errors</Th>
                    <Th>Status</Th>
                    <Th>Uploaded</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((b) => (
                    <tr key={b.id} className="cursor-pointer hover:bg-canvas" onClick={() => setOpen(b.id)}>
                      <Td className="font-mono text-[13px]">{b.batch_no}</Td>
                      <Td>
                        {KIND[b.kind]} <span className="text-muted">· {b.file_name}</span>
                        {b.cutover_date && <div className="text-[12px] text-muted">Cut-over {date(b.cutover_date)}</div>}
                      </Td>
                      <Td className="text-right tabular-nums">{b.rows_total}</Td>
                      <Td className={`text-right tabular-nums ${b.rows_invalid ? 'text-bad' : ''}`}>{b.rows_invalid}</Td>
                      <Td>
                        <Badge tone={TONE[b.status]}>{STATUS[b.status]}</Badge>
                      </Td>
                      <Td className="text-[13px]">
                        {b.uploaded_by_name}
                        <div className="text-muted">{dateTime(b.uploaded_at)}</div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Card>
      </div>
      {open && <BatchDialog id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function UploadCard({ onDone }: { onDone: (id: string) => void }) {
  const [kind, setKind] = useState<Kind>('CUSTOMERS');
  const [cutover, setCutover] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [upload, uploading] = useSubmit(async () => {
    setError(null);
    const fd = new FormData();
    fd.append('kind', kind);
    if (kind === 'LOANS' && cutover) fd.append('cutoverDate', cutover);
    fd.append('file', file!);
    try {
      const b = await api<Batch>('POST', '/imports', { body: fd });
      setFile(null);
      onDone(b.id);
    } catch (e) {
      setError(e as ApiError);
    }
  });
  return (
    <Card>
      <CardHeader
        title="Upload a filled template"
        description={kind === 'LOANS' ? 'Each loan is created on the product’s real schedule and checked against the old ledger. Checking a large file takes up to a minute.' : 'Up to 20,000 customers per file.'}
      />
      <form
        className="flex flex-wrap items-end gap-3 px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          upload();
        }}
      >
        <Field label="What">
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="CUSTOMERS">Customers</option>
            <option value="LOANS">Running loans</option>
          </Select>
        </Field>
        {kind === 'LOANS' && (
          <Field label="Cut-over date" hint="The day the old balances are true at">
            <Input type="date" required value={cutover} onChange={(e) => setCutover(e.target.value)} />
          </Field>
        )}
        <Field label="File (.xlsx or .csv)">
          <Input type="file" required accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Button type="submit" loading={uploading} disabled={!file}>
          <Upload className="size-4" /> Check file
        </Button>
        {error && (
          <div className="w-full">
            <Alert>
              {error.message}
              {Array.isArray(error.details) && error.details.length > 1 && (
                <ul className="mt-1 list-disc pl-5">
                  {(error.details as unknown as RowError[]).slice(0, 10).map((d, i) => (
                    <li key={i}>{d.message}</li>
                  ))}
                </ul>
              )}
            </Alert>
          </div>
        )}
      </form>
    </Card>
  );
}

function BatchDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, me } = useSession();
  const toast = useToast();
  const withStepUp = useStepUp();
  const { data: b, reload } = useApi<Batch>(`/imports/${id}`);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    reload();
    onChanged();
  };
  const [confirm, confirming] = useSubmit(async () => {
    setError(null);
    try {
      const r = await withStepUp(() => api<{ created: number }>('POST', `/imports/${id}/confirm`, { body: { acceptInvalid: accept } }));
      toast('ok', `Imported ${r.created} ${b!.kind === 'LOANS' ? 'loans' : 'customers'}`);
      done();
    } catch (e) {
      if ((e as ApiError).code !== 'REAUTH_CANCELLED') setError((e as ApiError).message);
    }
  });
  const [cancel, cancelling] = useSubmit(async () => {
    try {
      await api('POST', `/imports/${id}/cancel`, { body: {} });
      done();
    } catch (e) {
      setError((e as ApiError).message);
    }
  });
  const own = b?.uploaded_by === me?.id;
  const canConfirm = b?.status === 'VALIDATED' && can('import.confirm') && !own && !(b.kind === 'LOANS' && b.rows_invalid > 0);
  const t = b?.totals ?? {};
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={b ? `${b.batch_no} · ${KIND[b.kind]}` : 'Import'}
      description={b ? `${b.file_name} — uploaded by ${b.uploaded_by_name}, ${dateTime(b.uploaded_at)}` : undefined}
      footer={
        b && (
          <>
            {(b.status === 'VALIDATED' || b.status === 'REJECTED') && (
              <Button variant="secondary" onClick={() => cancel()} loading={cancelling}>
                Cancel import
              </Button>
            )}
            {canConfirm && (
              <Button onClick={() => confirm()} loading={confirming} disabled={b.rows_invalid > 0 && !accept}>
                Confirm and import {b.rows_valid}
              </Button>
            )}
          </>
        )
      }
    >
      {!b ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-[14px]">
          <div className="flex flex-wrap gap-2">
            <Badge tone={TONE[b.status]}>{STATUS[b.status]}</Badge>
            <Badge>{b.rows_total} rows</Badge>
            <Badge tone="ok">{b.rows_valid} ready</Badge>
            {b.rows_invalid > 0 && <Badge tone="bad">{b.rows_invalid} with errors</Badge>}
            {b.cutover_date && <Badge tone="info">Cut-over {date(b.cutover_date)}</Badge>}
          </div>
          {b.kind === 'LOANS' && t.principal !== undefined && (
            <div className="rounded-lg border border-line p-4">
              <p className="mb-2 font-medium">Opening balances {b.status === 'CONFIRMED' ? 'posted' : 'to be posted'} (E15: Dr receivables / Cr 3900 Opening Balance Equity ⚖)</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
                <dt className="text-muted">Loans</dt>
                <dd className="tabular-nums">{t.loans}</dd>
                <dt className="text-muted">Principal (1310)</dt>
                <dd className="tabular-nums">{inr(String(t.principal))}</dd>
                <dt className="text-muted">Interest due (1320)</dt>
                <dd className="tabular-nums">{inr(String(t.interest))}</dd>
                <dt className="text-muted">Fees (1330)</dt>
                <dd className="tabular-nums">{inr(String(t.fees))}</dd>
                <dt className="text-muted">Penal (1340)</dt>
                <dd className="tabular-nums">{inr(String(t.penalty))}</dd>
                <dt className="font-medium">Total (Cr 3900)</dt>
                <dd className="font-medium tabular-nums">{inr(String(t.total))}</dd>
              </dl>
            </div>
          )}
          {b.status === 'CONFIRMED' && <Alert tone="ok">Imported by confirmation of {b.confirmed_by_name}, {dateTime(b.confirmed_at)}.</Alert>}
          {b.status === 'VALIDATED' && own && <Alert tone="info">You uploaded this file, so someone else with “confirm imports” must confirm it.</Alert>}
          {b.status === 'VALIDATED' && b.kind === 'LOANS' && b.rows_invalid > 0 && <Alert tone="warn">Every loan row must be valid before anything is imported. Fix the rows below and upload again.</Alert>}
          {canConfirm && b.rows_invalid > 0 && (
            <Checkbox checked={accept} onChange={(e) => setAccept(e.target.checked)} label={`Import the ${b.rows_valid} valid customers; the ${b.rows_invalid} rows with errors stay listed here and are not imported`} />
          )}
          {error && <Alert>{error}</Alert>}
          {!!b.errors?.length && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">Rows to fix</p>
                <a href={`/api/v1/imports/${b.id}/errors.xlsx`} className="inline-flex items-center gap-1 text-[13px] text-accent-strong hover:underline">
                  <Download className="size-4" /> Download as Excel
                </a>
              </div>
              <div className="max-h-80 overflow-auto rounded-lg border border-line">
                <Table>
                  <thead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Column</Th>
                      <Th>Problem</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.errors.slice(0, 300).map((e, i) => (
                      <tr key={i}>
                        <Td className="tabular-nums">{e.row}</Td>
                        <Td className="font-mono text-[12px]">{e.field ?? '—'}</Td>
                        <Td>{e.message}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
