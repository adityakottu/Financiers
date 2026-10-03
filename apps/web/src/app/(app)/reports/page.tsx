'use client';

import { CATEGORY_LABELS } from '@fin/contracts';
import { BookCheck, Download, FileSpreadsheet, FileText, RefreshCw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, cx, EmptyState, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { ApiError, get } from '@/lib/api';
import { date, dateTime, inr, titleCase } from '@/lib/format';
import { useApi } from '@/lib/hooks';

type FilterKey = 'from' | 'to' | 'asOf' | 'branchId' | 'employeeId' | 'accountId' | 'category' | 'method' | 'status' | 'bucket' | 'range';
type Filters = Partial<Record<FilterKey, string>>;
interface ReportMeta { name: string; title: string; group: string; description: string; filters: FilterKey[]; required: FilterKey[]; defaults: Filters; saved: Filters | null }
interface Catalogue { canExport: boolean; canCaPack: boolean; reports: ReportMeta[] }
interface Options { branches: { id: string; code: string; name: string }[]; employees: { id: string; full_name: string; employee_code: string; is_collector: boolean }[]; accounts: { id: string; code: string; name: string }[] }
interface Column { key: string; label: string; type: 'text' | 'money' | 'int' | 'date' | 'pct' }
type Row = Record<string, string | number | boolean | null | undefined>;
interface Result { report: { title: string; description: string }; filters: Filters; columns: Column[]; rows: Row[]; totals: Row | null; notes?: string[] }
interface Job { id: string; report: string; format: string; status: string; requested_at: string; row_count: number | null; file_name: string | null; error: string | null }

const GROUPS = ['Loans', 'Collections', 'Accounting', 'Reconciliation', 'Recovery'];
const STATUS: Record<string, string[]> = {
  'payments-register': ['POSTED', 'REVERSAL_PENDING', 'REVERSED'],
  'recon-employee': ['OPEN', 'SUBMITTED', 'MATCHED', 'SHORT', 'EXCESS', 'APPROVED'],
  'recon-adjustments': ['PENDING', 'APPROVED', 'REJECTED'],
  'recon-upi': ['UNRECONCILED', 'MATCHED'],
  'expense-register': ['SUBMITTED', 'APPROVED', 'POSTED', 'REJECTED', 'REVERSED'],
  'asset-register': ['ACTIVE', 'REPOSSESSED', 'SOLD', 'CLOSED', 'WRITTEN_OFF'],
  'recovery-cases': ['OPEN', 'CLOSED'],
};
const LABEL: Record<FilterKey, string> = { from: 'From', to: 'To', asOf: 'As of', branchId: 'Branch', employeeId: 'Employee', accountId: 'Account', category: 'Category', method: 'Method', status: 'Status', bucket: 'Days past due', range: 'Due' };

const qs = (f: Filters) => new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();

function cell(c: Column, v: Row[string]) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return inr(String(v));
  if (c.type === 'pct') return `${Number(v).toFixed(2)}%`;
  if (c.type === 'date') return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? date(String(v)) : String(v);
  if (c.type === 'int') return Number(v).toLocaleString('en-IN');
  return String(v);
}

/** Downloads a report file; a large report comes back 202 and is prepared in the background. */
async function fetchFile(url: string): Promise<{ queued: true; message: string } | { queued: false }> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 202) return { queued: true, message: (await res.json()).message };
  if (!res.ok) {
    const e = (await res.json().catch(() => ({})))?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Download failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report';
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return { queued: false };
}

function FilterBar({ meta, value, onChange, options }: { meta: ReportMeta; value: Filters; onChange: (f: Filters) => void; options: Options | null }) {
  const set = (k: FilterKey, v: string) => onChange({ ...value, [k]: v || undefined });
  return (
    <div className="flex flex-wrap items-end gap-3">
      {meta.filters.map((k) => (
        <Field key={k} label={meta.name === 'day-book' && k === 'asOf' ? 'Date' : LABEL[k]} required={meta.required.includes(k)}>
          {k === 'from' || k === 'to' || k === 'asOf' ? (
            <Input type="date" value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          ) : k === 'branchId' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">All my branches</option>
              {options?.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </Select>
          ) : k === 'employeeId' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">Everyone</option>
              {options?.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name} ({e.employee_code})
                </option>
              ))}
            </Select>
          ) : k === 'accountId' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">{meta.required.includes(k) ? 'Choose an account…' : 'All accounts'}</option>
              {options?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          ) : k === 'category' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">All</option>
              {Object.entries(CATEGORY_LABELS).map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
            </Select>
          ) : k === 'method' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">All</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CHEQUE">Cheque</option>
            </Select>
          ) : k === 'bucket' ? (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">All overdue</option>
              <option value="DPD_1_30">1–30 days</option>
              <option value="DPD_31_60">31–60 days</option>
              <option value="DPD_61_90">61–90 days</option>
              <option value="DPD_90_PLUS">90+ days</option>
            </Select>
          ) : k === 'range' ? (
            <Select value={value[k] ?? 'today'} onChange={(e) => set(k, e.target.value)}>
              <option value="today">Today</option>
              <option value="tomorrow">Tomorrow</option>
              <option value="week">Next 7 days</option>
            </Select>
          ) : (
            <Select value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">All</option>
              {(STATUS[meta.name] ?? []).map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ))}
    </div>
  );
}

function ResultTable({ r }: { r: Result }) {
  const right = (c: Column) => c.type === 'money' || c.type === 'int' || c.type === 'pct';
  if (!r.rows.length) return <EmptyState title="No rows for these filters" body="Try a wider date range or another branch." />;
  return (
    <div className="max-h-[70vh] overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-canvas">
          <tr>
            {r.columns.map((c) => (
              <th key={c.key} scope="col" className={cx('whitespace-nowrap border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted', right(c) ? 'text-right' : 'text-left')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) =>
            row._section ? (
              <tr key={i}>
                <th colSpan={r.columns.length} scope="colgroup" className="border-b border-line bg-canvas/60 px-3 py-1.5 text-left font-semibold text-ink-900">
                  {String(row._section)}
                </th>
              </tr>
            ) : (
              <tr key={i} className={cx('border-b border-line hover:bg-canvas/60', row._bold ? 'font-semibold' : '')}>
                {r.columns.map((c) => (
                  <td key={c.key} className={cx('px-3 py-1.5', right(c) ? 'num whitespace-nowrap text-right' : c.type === 'date' ? 'num whitespace-nowrap' : '')}>
                    {cell(c, row[c.key])}
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
        {r.totals && (
          <tfoot className="sticky bottom-0 bg-surface">
            <tr className="border-t-2 border-ink-900 font-semibold">
              {r.columns.map((c) => (
                <td key={c.key} className={cx('px-3 py-2', right(c) ? 'num whitespace-nowrap text-right' : '')}>
                  {cell(c, r.totals![c.key])}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Exports({ jobs, reload }: { jobs: Job[]; reload: () => void }) {
  const toast = useToast();
  if (!jobs.length) return null;
  return (
    <Card>
      <CardHeader
        title="Large exports"
        description="Prepared in the background; kept for 7 days, only for you."
        actions={
          <Button size="sm" variant="ghost" onClick={reload}>
            <RefreshCw className="size-3.5" /> Refresh
          </Button>
        }
      />
      <ul className="divide-y divide-line text-[13px]">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3 px-5 py-2">
            <span>
              <span className="font-medium">{j.file_name ?? j.report}</span> <span className="text-[12px] text-subtle">· {dateTime(j.requested_at)}</span>
              {j.row_count !== null && <span className="text-[12px] text-subtle"> · {j.row_count.toLocaleString('en-IN')} rows</span>}
            </span>
            {j.status === 'DONE' ? (
              <Button size="sm" variant="secondary" onClick={() => fetchFile(`/api/v1/exports/${j.id}/download`).catch((e) => toast('bad', (e as Error).message))}>
                <Download className="size-3.5" /> Download
              </Button>
            ) : (
              <Badge tone={j.status === 'FAILED' ? 'bad' : 'info'}>{j.status === 'FAILED' ? j.error ?? 'Failed' : 'Preparing…'}</Badge>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CaPack({ options }: { options: Options | null }) {
  const toast = useToast();
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const [f, setF] = useState<Filters>({ from: `${today.slice(0, 8)}01`, to: today });
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader title="CA pack" description="One Excel workbook for your external accountant: trial balance, P&L, balance sheet, cash & bank book, receivables, expenses, write-offs and cash differences." />
      <div className="flex flex-wrap items-end gap-3 px-5 pb-5">
        <Field label="From">
          <Input type="date" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
        <Field label="To">
          <Input type="date" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </Field>
        <Field label="Branch">
          <Select value={f.branchId ?? ''} onChange={(e) => setF({ ...f, branchId: e.target.value || undefined })}>
            <option value="">All my branches</option>
            {options?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await fetchFile(`/api/v1/reports/ca-pack?${qs(f)}`);
              toast('ok', 'CA pack downloaded');
            } catch (e) {
              toast('bad', (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <BookCheck className="size-4" /> Download CA pack
        </Button>
      </div>
    </Card>
  );
}

function Reports() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const { data: cat } = useApi<Catalogue>('/reports');
  const [options, setOptions] = useState<Options | null>(null);
  const { data: jobs, reload: reloadJobs } = useApi<Job[]>('/exports');
  useEffect(() => {
    get<Options>('/reports/options').then(setOptions).catch(() => undefined);
  }, []);
  const name = params.get('r') ?? cat?.reports[0]?.name ?? null;
  const meta = useMemo(() => cat?.reports.find((r) => r.name === name) ?? null, [cat, name]);
  const [filters, setFilters] = useState<Filters>({});
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => {
    if (meta) setFilters({ ...meta.defaults, ...(meta.saved ?? {}) });
    setResult(null);
  }, [meta]);

  const missing = meta ? meta.required.filter((k) => !filters[k]) : [];
  useEffect(() => {
    if (!meta || missing.length) return;
    let live = true;
    setLoading(true);
    setError(null);
    get<Result>(`/reports/${meta.name}?${qs(filters)}`)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError(e as ApiError))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, JSON.stringify(filters)]);

  const doExport = async (format: 'xlsx' | 'pdf') => {
    if (!meta) return;
    setExporting(format);
    try {
      const r = await fetchFile(`/api/v1/reports/${meta.name}?${qs(filters)}&format=${format}`);
      if (r.queued) {
        toast('ok', r.message);
        reloadJobs();
      }
    } catch (e) {
      toast('bad', (e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  if (!cat) return <Spinner />;
  if (!cat.reports.length) return <EmptyState title="No reports for your role" />;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
      <nav aria-label="Reports" className="space-y-5">
        {GROUPS.filter((g) => cat.reports.some((r) => r.group === g)).map((g) => (
          <div key={g}>
            <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g}</p>
            <ul>
              {cat.reports
                .filter((r) => r.group === g)
                .map((r) => (
                  <li key={r.name}>
                    <button
                      type="button"
                      onClick={() => router.replace(`/reports?r=${r.name}`)}
                      aria-current={r.name === name ? 'page' : undefined}
                      className={cx('w-full rounded-md px-2 py-1.5 text-left text-[13px]', r.name === name ? 'bg-ink-900 text-white' : 'text-ink-800 hover:bg-canvas')}
                    >
                      {r.title}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0 space-y-6">
        {meta && (
          <Card>
            <CardHeader
              title={meta.title}
              description={meta.description}
              actions={
                cat.canExport && (
                  <>
                    <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} disabled={!!missing.length} onClick={() => doExport('xlsx')}>
                      <FileSpreadsheet className="size-3.5" /> Excel
                    </Button>
                    <Button size="sm" variant="secondary" loading={exporting === 'pdf'} disabled={!!missing.length} onClick={() => doExport('pdf')}>
                      <FileText className="size-3.5" /> PDF
                    </Button>
                  </>
                )
              }
            />
            <div className="border-b border-line px-5 pb-4">
              <FilterBar meta={meta} value={filters} onChange={setFilters} options={options} />
              {meta.saved && <p className="mt-2 text-[12px] text-subtle">Your last filters for this report are remembered.</p>}
            </div>
            {error && (
              <div className="p-5">
                <Alert>{error.message}</Alert>
              </div>
            )}
            {missing.length > 0 ? (
              <EmptyState title={`Choose ${missing.map((k) => LABEL[k].toLowerCase()).join(', ')}`} />
            ) : loading && !result ? (
              <Spinner />
            ) : result ? (
              <>
                {result.notes?.map((n) => (
                  <p key={n} className="px-5 pt-3 text-[12px] italic text-muted">
                    {n}
                  </p>
                ))}
                <p className="px-5 pt-2 text-[12px] text-subtle">{result.rows.filter((r) => !r._section).length.toLocaleString('en-IN')} rows</p>
                <ResultTable r={result} />
              </>
            ) : null}
          </Card>
        )}
        <Exports jobs={jobs ?? []} reload={reloadJobs} />
        {cat.canCaPack && <CaPack options={options} />}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" subtitle="Every figure comes from the same books; Excel and PDF downloads are recorded in the audit log" />
      <Suspense fallback={<Spinner />}>
        <Reports />
      </Suspense>
    </>
  );
}
