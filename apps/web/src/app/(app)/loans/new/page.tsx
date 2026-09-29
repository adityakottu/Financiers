'use client';

import { AssetInput, assetProblems, CATEGORY_LABELS, LoanCategory } from '@fin/contracts';
import type { Schedule } from '@fin/loan-engine';
import { AlertTriangle, Bike, Box, Bus, Car, Check, ChevronLeft, ChevronRight, Search, Truck, Tv } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { AssetFields } from '@/components/asset-fields';
import { defaultFirstDue, FREQUENCY_LABELS, METHOD_LABELS, ScheduleTable, ScheduleTotals, todayIST } from '@/components/lending';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, cx, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge } from '@/components/ui';
import { api, ApiError, get, newIdempotencyKey, qs } from '@/lib/api';
import { inr } from '@/lib/format';
import { useDebounced, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface CustomerHit {
  id: string;
  customer_no?: string;
  customerNo?: string;
  full_name?: string;
  fullName?: string;
  mobile: string;
  village_town?: string | null;
  kyc_status?: string;
  kycStatus?: string;
  branch_code?: string;
  branchCode?: string;
}
interface Product {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string | null;
  category: LoanCategory;
  interest_method: string;
  rate_min: string;
  rate_default: string;
  rate_max: string;
  amount_min: string;
  amount_max: string;
  tenure_min: number;
  tenure_max: number;
  allowed_frequencies: string[];
  fee_rules: { label: string; basis: string; value: string; gstRatePct: string; mode: string }[];
  penalty_rule: { type: string; value: string; graceDays: number };
  max_ltv_pct: string | null;
  approval_limit: string | null;
}
interface Preview {
  schedule: Schedule;
  previewHash: string;
  violations: { path: string; message: string }[];
}

const STEPS = ['Customer', 'Product', 'Asset', 'Terms', 'Review'] as const;
const CATEGORY_ICON: Record<LoanCategory, React.ComponentType<{ className?: string }>> = {
  ELECTRONICS: Tv,
  TWO_WHEELER: Bike,
  THREE_WHEELER: Car,
  FOUR_WHEELER: Car,
  BUS: Bus,
  LORRY_TRUCK: Truck,
  OTHER: Box,
};

const norm = (c: CustomerHit) => ({
  id: c.id,
  customerNo: c.customerNo ?? c.customer_no ?? '',
  fullName: c.fullName ?? c.full_name ?? '',
  mobile: c.mobile,
  village: c.village_town ?? null,
  kyc: c.kycStatus ?? c.kyc_status ?? 'PENDING',
  branch: c.branchCode ?? c.branch_code ?? '',
});
type Customer = ReturnType<typeof norm>;

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-1 overflow-x-auto">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-1">
          <span
            className={cx(
              'flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium',
              i === step ? 'bg-ink-900 text-white' : i < step ? 'bg-accent-soft text-accent-strong' : 'bg-surface text-subtle ring-1 ring-line',
            )}
          >
            <span className="grid size-5 place-items-center rounded-full bg-white/15 text-[11px]">{i < step ? <Check className="size-3" /> : i + 1}</span>
            {s}
          </span>
          {i < STEPS.length - 1 && <ChevronRight className="size-4 text-subtle" />}
        </li>
      ))}
    </ol>
  );
}

function Wizard() {
  const { can } = useSession();
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const today = todayIST();
  const idemKey = useMemo(() => newIdempotencyKey(), []);

  const [step, setStep] = useState(0);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [asset, setAsset] = useState<Record<string, string>>({});
  const [hypothecation, setHypothecation] = useState(false);
  const [terms, setTerms] = useState({ principal: '', annualRate: '', frequency: 'MONTHLY', numInstallments: '', customIntervalDays: '10', disbursementDate: today, firstDueDate: defaultFirstDue(today, 'MONTHLY'), downPayment: '' });
  const [assetErrors, setAssetErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);

  // Customer preselected from the customer page.
  useEffect(() => {
    const id = params.get('customerId');
    if (id) get<CustomerHit>(`/customers/${id}`).then((c) => { setCustomer(norm(c)); setStep(1); }).catch(() => undefined);
  }, [params]);

  function chooseProduct(p: Product) {
    setProduct(p);
    const freq = p.allowed_frequencies.includes('MONTHLY') ? 'MONTHLY' : p.allowed_frequencies[0]!;
    setTerms((t) => ({
      ...t,
      annualRate: String(Number(p.rate_default)),
      frequency: freq,
      numInstallments: String(Math.min(Math.max(12, p.tenure_min), p.tenure_max)),
      firstDueDate: defaultFirstDue(t.disbursementDate, freq),
    }));
    setStep(2);
  }

  const assetPayload = (): AssetInput => {
    const out: Record<string, unknown> = { hypothecationMarked: hypothecation };
    for (const [k, v] of Object.entries(asset)) if (v.trim()) out[k] = k === 'manufactureYear' ? Number(v) : v.trim();
    return out as AssetInput;
  };

  function nextFromAsset() {
    const problems = assetProblems(product!.category, assetPayload());
    setAssetErrors(problems);
    if (Object.keys(problems).length === 0) {
      if (!terms.principal && asset.assetValue && product!.max_ltv_pct) {
        const suggested = Math.floor((Number(asset.assetValue) * Number(product!.max_ltv_pct)) / 100 / 1000) * 1000;
        setTerms((t) => ({ ...t, principal: String(Math.min(suggested, Number(product!.amount_max))) }));
      }
      setStep(3);
    }
  }

  const [submit, submitting] = useSubmit(async (andSubmit: boolean) => {
    setError(null);
    try {
      const body = {
        customerId: customer!.id,
        productId: product!.id,
        principal: terms.principal,
        annualRate: terms.annualRate,
        frequency: terms.frequency,
        customIntervalDays: terms.frequency === 'CUSTOM' ? terms.customIntervalDays : undefined,
        numInstallments: terms.numInstallments,
        disbursementDate: terms.disbursementDate,
        firstDueDate: terms.firstDueDate,
        downPayment: terms.downPayment || undefined,
        asset: assetPayload(),
        previewHash: preview?.previewHash,
      };
      const r = await api<{ id: string; loanNo: string }>('POST', '/loans', { body, idempotencyKey: idemKey });
      if (andSubmit) await api('POST', `/loans/${r.id}/submit`);
      toast('ok', andSubmit ? `Loan ${r.loanNo} created and sent for approval` : `Loan ${r.loanNo} saved as draft`);
      router.push(`/loans/${r.id}`);
    } catch (e) {
      setError(e as ApiError);
    }
  });

  // Live preview for the terms step.
  const t = useDebounced(terms, 300);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    if (!product || step < 3 || !t.principal || !t.numInstallments || !t.annualRate) return;
    const ctrl = new AbortController();
    setPreviewing(true);
    api<Preview>('POST', '/loans/calculate', {
      signal: ctrl.signal,
      body: {
        productId: product.id,
        principal: t.principal,
        annualRate: t.annualRate,
        frequency: t.frequency,
        numInstallments: t.numInstallments,
        customIntervalDays: t.frequency === 'CUSTOM' ? t.customIntervalDays : undefined,
        disbursementDate: t.disbursementDate,
        firstDueDate: t.firstDueDate,
        assetValue: asset.assetValue || undefined,
      },
    })
      .then((p) => {
        setPreview(p);
        setPreviewError(null);
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return;
        setPreview(null);
        setPreviewError(e as ApiError);
      })
      .finally(() => !ctrl.signal.aborted && setPreviewing(false));
    return () => ctrl.abort();
  }, [t, product, step, asset.assetValue]);

  const violations = Object.fromEntries((preview?.violations ?? []).map((v) => [v.path, v.message]));
  const previewFieldErrors = previewError?.fieldErrors() ?? {};
  const termError = (k: string) => violations[k] ?? previewFieldErrors[k];
  const termsOk = !!preview && preview.violations.length === 0;

  if (!can('loan.create')) return <EmptyState title="You don’t have permission to create loans" />;

  return (
    <>
      <PageHeader
        title="New loan"
        breadcrumb={
          <Link href="/loans" className="hover:underline">
            Loans
          </Link>
        }
      />
      <Stepper step={step} />

      {step === 0 && <CustomerStep onPick={(c) => { setCustomer(c); setStep(1); }} />}

      {step >= 1 && customer && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <span className="font-medium text-ink-950">{customer.fullName}</span>
          <span className="num text-muted">{customer.customerNo}</span>
          <StatusBadge status={customer.kyc} />
          {customer.kyc !== 'VERIFIED' && <span className="text-[12px] text-warn">KYC must be verified before approval</span>}
          {product && (
            <>
              <span className="text-subtle">·</span>
              <span className="text-ink-800">{product.name}</span>
            </>
          )}
          <button className="ml-auto text-[13px] text-ink-700 hover:underline" onClick={() => setStep(0)}>
            Change
          </button>
        </div>
      )}

      {step === 1 && <ProductStep onPick={chooseProduct} onBack={() => setStep(0)} />}

      {step === 2 && product && (
        <Card>
          <CardHeader title={`${CATEGORY_LABELS[product.category]} details`} description="What is being financed. Required fields depend on the category." />
          <AssetFields category={product.category} v={asset} set={setAsset} errors={assetErrors} hypothecation={hypothecation} setHypothecation={setHypothecation} />
          <div className="flex justify-between border-t border-line px-5 py-3">
            <Button variant="secondary" onClick={() => setStep(1)}>
              <ChevronLeft className="size-4" /> Back
            </Button>
            <Button onClick={nextFromAsset}>
              Continue <ChevronRight className="size-4" />
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && product && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[380px_1fr]">
          <Card className="h-fit">
            <CardHeader title="Loan terms" description={`${METHOD_LABELS[product.interest_method]} · limits from ${product.name} v${product.version}`} />
            <div className="grid gap-4 p-5">
              <Field label="Loan amount (₹)" required error={termError('principal')} hint={`₹${Number(product.amount_min).toLocaleString('en-IN')} – ₹${Number(product.amount_max).toLocaleString('en-IN')}${product.max_ltv_pct ? ` · up to ${Number(product.max_ltv_pct)}% of asset value` : ''}`}>
                <Input value={terms.principal} onChange={(e) => setTerms({ ...terms, principal: e.target.value })} inputMode="decimal" className="num" />
              </Field>
              <Field label="Interest rate (% p.a.)" required error={termError('annualRate')} hint={`${Number(product.rate_min)}% – ${Number(product.rate_max)}%`}>
                <Input value={terms.annualRate} onChange={(e) => setTerms({ ...terms, annualRate: e.target.value })} inputMode="decimal" className="num" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Frequency" error={termError('frequency')}>
                  <Select value={terms.frequency} onChange={(e) => setTerms({ ...terms, frequency: e.target.value, firstDueDate: defaultFirstDue(terms.disbursementDate, e.target.value, Number(terms.customIntervalDays)) })}>
                    {product.allowed_frequencies.map((f) => (
                      <option key={f} value={f}>
                        {FREQUENCY_LABELS[f]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Installments" required error={termError('numInstallments')} hint={`${product.tenure_min}–${product.tenure_max}`}>
                  <Input value={terms.numInstallments} onChange={(e) => setTerms({ ...terms, numInstallments: e.target.value })} inputMode="numeric" className="num" />
                </Field>
              </div>
              {terms.frequency === 'CUSTOM' && (
                <Field label="Days between installments">
                  <Input value={terms.customIntervalDays} onChange={(e) => setTerms({ ...terms, customIntervalDays: e.target.value })} inputMode="numeric" />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Disbursement date" error={termError('disbursementDate')}>
                  <Input type="date" value={terms.disbursementDate} onChange={(e) => setTerms({ ...terms, disbursementDate: e.target.value, firstDueDate: defaultFirstDue(e.target.value, terms.frequency, Number(terms.customIntervalDays)) })} />
                </Field>
                <Field label="First installment" error={termError('firstDueDate')}>
                  <Input type="date" value={terms.firstDueDate} onChange={(e) => setTerms({ ...terms, firstDueDate: e.target.value })} />
                </Field>
              </div>
              <Field label="Down payment by customer (₹)" hint="For the record; not financed">
                <Input value={terms.downPayment} onChange={(e) => setTerms({ ...terms, downPayment: e.target.value })} inputMode="decimal" className="num" />
              </Field>
              {product.fee_rules.length > 0 && (
                <div className="rounded-md bg-canvas px-3 py-2 text-[12px] text-muted">
                  <p className="font-medium text-ink-800">Fees from the product</p>
                  {product.fee_rules.map((f) => (
                    <p key={f.label}>
                      {f.label}: {f.basis === 'FLAT' ? `₹${f.value}` : `${f.value}%`}
                      {Number(f.gstRatePct) > 0 && ` + ${f.gstRatePct}% GST`} — {f.mode === 'DEDUCT_FROM_DISBURSAL' ? 'deducted at disbursal' : 'with 1st installment'}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-between border-t border-line px-5 py-3">
              <Button variant="secondary" onClick={() => setStep(2)}>
                <ChevronLeft className="size-4" /> Back
              </Button>
              <Button onClick={() => setStep(4)} disabled={!termsOk || previewing}>
                Review <ChevronRight className="size-4" />
              </Button>
            </div>
          </Card>
          <div className="min-w-0 space-y-4">
            {previewError && !Object.keys(previewFieldErrors).length && <Alert>{previewError.message}</Alert>}
            {preview?.violations.length ? (
              <Alert tone="warn">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-4" /> Outside this product’s limits:
                </span>
                <ul className="mt-1 list-inside list-disc">
                  {preview.violations.map((v) => (
                    <li key={v.path + v.message}>{v.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {preview ? (
              <div className={previewing ? 'opacity-60 transition-opacity' : undefined}>
                <ScheduleTotals s={preview.schedule} />
                <Card className="mt-4">
                  <CardHeader title="Repayment schedule preview" description="This is exactly what will be saved." />
                  <ScheduleTable rows={preview.schedule.rows} />
                </Card>
              </div>
            ) : previewing ? (
              <Spinner label="Calculating" />
            ) : (
              <EmptyState title="Enter the terms to preview the schedule" />
            )}
          </div>
        </div>
      )}

      {step === 4 && product && customer && preview && (
        <div className="space-y-5">
          {error && <Alert>{error.code === 'PREVIEW_CHANGED' ? `${error.message} Go back to Terms to see it.` : error.message}</Alert>}
          <Card>
            <CardHeader title="Review" description="Check everything with the customer before saving." />
            <dl className="grid gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['Customer', `${customer.fullName} (${customer.customerNo})`],
                ['Product', `${product.name} v${product.version}`],
                ['Asset', [asset.make, asset.model, asset.description, asset.registrationNo].filter(Boolean).join(' · ') || '—'],
                ['Amount', inr(terms.principal)],
                ['Rate', `${terms.annualRate}% p.a. ${METHOD_LABELS[product.interest_method]?.toLowerCase()}`],
                ['Installments', `${terms.numInstallments} × ${inr(preview.schedule.totals.installmentAmount)} ${FREQUENCY_LABELS[terms.frequency]?.toLowerCase()}`],
                ['Penal charges', product.penalty_rule.type === 'NONE' ? 'None' : `${product.penalty_rule.type === 'FLAT_PER_INSTALLMENT' ? `₹${product.penalty_rule.value} per late installment` : `${product.penalty_rule.value}% ${product.penalty_rule.type === 'PCT_PA_ON_OVERDUE' ? 'p.a.' : 'per day'} on overdue`}, after ${product.penalty_rule.graceDays} days’ grace`],
                ['Approval', product.approval_limit && Number(terms.principal) > Number(product.approval_limit) ? 'Needs Management approval' : 'Branch manager (not the creator)'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[12px] text-muted">{k}</dt>
                  <dd className="text-ink-950">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <ScheduleTotals s={preview.schedule} />
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={() => setStep(3)}>
              <ChevronLeft className="size-4" /> Back
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => submit(false)} loading={submitting}>
                Save as draft
              </Button>
              <Button onClick={() => submit(true)} loading={submitting}>
                Create and send for approval
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CustomerStep({ onPick }: { onPick: (c: Customer) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 250);
  const [rows, setRows] = useState<Customer[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const path = term.length >= 2 ? `/search${qs({ q: term, limit: 10 })}` : `/customers${qs({ limit: 8, status: 'ACTIVE' })}`;
    get<{ data: CustomerHit[] }>(path, ctrl.signal)
      .then((r) => setRows(r.data.filter((x) => (x as { type?: string }).type !== 'loan').map(norm)))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [term]);
  return (
    <Card>
      <CardHeader title="Who is the loan for?" description="Search an existing customer, or add a new one first." actions={<Link href="/customers/new"><Button size="sm" variant="secondary">New customer</Button></Link>} />
      <div className="p-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile, customer ID or PAN" className="pl-9" autoFocus aria-label="Find customer" />
        </div>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No customers found.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {rows.map((c) => (
              <li key={c.id}>
                <button onClick={() => onPick(c)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-canvas">
                  <span>
                    <span className="block font-medium text-ink-950">{c.fullName}</span>
                    <span className="num block text-[12px] text-muted">
                      {c.customerNo} · {c.mobile} · {c.village ?? c.branch}
                    </span>
                  </span>
                  <StatusBadge status={c.kyc} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ProductStep({ onPick, onBack }: { onPick: (p: Product) => void; onBack: () => void }) {
  const { data } = useApiList<Product>('/loan-products');
  return (
    <Card>
      <CardHeader title="Choose a loan product" description="Products set the interest method, limits, fees and penal charges." />
      {!data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <EmptyState title="No active loan products" body="An administrator must create one under Organisation → Loan products." />
      ) : (
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => {
            const Icon = CATEGORY_ICON[p.category];
            return (
              <button key={p.id} onClick={() => onPick(p)} className="rounded-lg border border-line p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft/40">
                <div className="flex items-center gap-2">
                  <span className="grid size-9 place-items-center rounded-md bg-canvas text-ink-700">
                    <Icon className="size-5" />
                  </span>
                  <span>
                    <span className="block font-medium text-ink-950">{p.name}</span>
                    <span className="block text-[12px] text-muted">{CATEGORY_LABELS[p.category]}</span>
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
                  <Badge>{METHOD_LABELS[p.interest_method]}</Badge>
                  <Badge>
                    {Number(p.rate_min)}–{Number(p.rate_max)}%
                  </Badge>
                  <Badge>
                    ₹{(Number(p.amount_min) / 1000).toFixed(0)}k–₹{(Number(p.amount_max) / 100000).toFixed(1)}L
                  </Badge>
                  <Badge>{p.allowed_frequencies.map((f) => FREQUENCY_LABELS[f]).join(' / ')}</Badge>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="border-t border-line px-5 py-3">
        <Button variant="secondary" onClick={onBack}>
          <ChevronLeft className="size-4" /> Back
        </Button>
      </div>
    </Card>
  );
}

function useApiList<T>(path: string) {
  const [data, setData] = useState<T[] | null>(null);
  useEffect(() => {
    get<{ data: T[] }>(path).then((r) => setData(r.data)).catch(() => setData([]));
  }, [path]);
  return { data };
}

export default function NewLoanPage() {
  return (
    <Suspense>
      <Wizard />
    </Suspense>
  );
}
