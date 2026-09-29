'use client';

import { CATEGORY_LABELS, LOAN_CATEGORIES } from '@fin/contracts';
import { FREQUENCIES, INTEREST_METHODS, PENALTY_TYPES } from '@fin/loan-engine';
import { Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FREQUENCY_LABELS, METHOD_LABELS } from '@/components/lending';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, Td, Textarea, Th } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface FeeRule {
  code: string;
  label: string;
  basis: 'FLAT' | 'PCT_OF_PRINCIPAL';
  value: string;
  gstRatePct: string;
  mode: 'DEDUCT_FROM_DISBURSAL' | 'ADD_TO_FIRST_INSTALLMENT';
}
interface Product {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string | null;
  category: string;
  interest_method: string;
  rate_min: string;
  rate_default: string;
  rate_max: string;
  amount_min: string;
  amount_max: string;
  tenure_min: number;
  tenure_max: number;
  allowed_frequencies: string[];
  rounding_unit: string;
  skip_sundays: boolean;
  fee_rules: FeeRule[];
  penalty_rule: { type: string; value: string; graceDays: number; cap: string | null };
  allocation_rule: { mode: string; order: string[]; excessHandling: string };
  max_ltv_pct: string | null;
  approval_limit: string | null;
  status: string;
}

const PENALTY_LABELS: Record<string, string> = {
  NONE: 'No penal charge',
  FLAT_PER_INSTALLMENT: 'Flat ₹ once per late installment',
  PCT_OF_OVERDUE_PER_DAY: '% of overdue amount per day',
  PCT_PA_ON_OVERDUE: '% per annum on overdue amount',
};

export default function ProductsPage() {
  const { can } = useSession();
  const { data, loading, reload } = useApi<{ data: Product[] }>('/loan-products?includeRetired=true');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const toast = useToast();
  const manage = can('product.manage');

  async function toggle(p: Product) {
    try {
      await api('POST', `/loan-products/${p.id}/${p.status === 'ACTIVE' ? 'retire' : 'reactivate'}`);
      toast('ok', p.status === 'ACTIVE' ? 'Product retired — no new loans can use it' : 'Product reactivated');
      reload();
    } catch (e) {
      toast('bad', (e as ApiError).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Loan products"
        subtitle="Interest method, limits, fees and penal charges. Changing a product creates a new version; existing loans keep their terms."
        actions={
          manage && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" /> New product
            </Button>
          )
        }
      />
      <Card>
        {loading || !data ? (
          <Spinner />
        ) : data.data.length === 0 ? (
          <EmptyState icon={<Package className="size-8" />} title="No loan products yet" body="Create one to start writing loans." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Method</Th>
                <Th>Rate</Th>
                <Th>Amount</Th>
                <Th>Tenure</Th>
                <Th>Fees</Th>
                <Th>Penal</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <tr key={p.id} className="hover:bg-canvas/60">
                  <Td>
                    <p className="font-medium text-ink-950">{p.name}</p>
                    <p className="text-[12px] text-muted">
                      {p.code} v{p.version} · {CATEGORY_LABELS[p.category as keyof typeof CATEGORY_LABELS]}
                    </p>
                  </Td>
                  <Td className="text-[13px]">{METHOD_LABELS[p.interest_method]}</Td>
                  <Td className="num whitespace-nowrap">
                    {Number(p.rate_default)}% <span className="text-[12px] text-subtle">({Number(p.rate_min)}–{Number(p.rate_max)})</span>
                  </Td>
                  <Td className="num whitespace-nowrap text-[13px]">
                    {inr(p.amount_min, { decimals: false })} – {inr(p.amount_max, { decimals: false })}
                  </Td>
                  <Td className="text-[13px]">
                    {p.tenure_min}–{p.tenure_max} · {p.allowed_frequencies.map((f) => FREQUENCY_LABELS[f]).join('/')}
                  </Td>
                  <Td className="text-[12px] text-muted">{p.fee_rules.length ? p.fee_rules.map((f) => f.label).join(', ') : '—'}</Td>
                  <Td className="text-[12px] text-muted">{p.penalty_rule.type === 'NONE' ? '—' : `${p.penalty_rule.type === 'FLAT_PER_INSTALLMENT' ? `₹${p.penalty_rule.value}` : `${p.penalty_rule.value}%`} after ${p.penalty_rule.graceDays}d`}</Td>
                  <Td>
                    <StatusBadge status={p.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE'} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {manage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggle(p)}>
                          {p.status === 'ACTIVE' ? 'Retire' : 'Reactivate'}
                        </Button>
                      </>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {editing && <ProductDialog product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

function ProductDialog({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({
    code: product?.code ?? '',
    name: product?.name ?? '',
    description: product?.description ?? '',
    category: product?.category ?? 'TWO_WHEELER',
    interestMethod: product?.interest_method ?? 'FLAT',
    rateMin: product ? String(Number(product.rate_min)) : '12',
    rateDefault: product ? String(Number(product.rate_default)) : '24',
    rateMax: product ? String(Number(product.rate_max)) : '30',
    amountMin: product ? String(Number(product.amount_min)) : '10000',
    amountMax: product ? String(Number(product.amount_max)) : '300000',
    tenureMin: String(product?.tenure_min ?? 3),
    tenureMax: String(product?.tenure_max ?? 36),
    allowedFrequencies: product?.allowed_frequencies ?? ['MONTHLY'],
    roundingUnit: product?.rounding_unit ?? '1',
    skipSundays: product?.skip_sundays ?? false,
    maxLtvPct: product?.max_ltv_pct ? String(Number(product.max_ltv_pct)) : '',
    approvalLimit: product?.approval_limit ? String(Number(product.approval_limit)) : '',
    penaltyType: product?.penalty_rule.type ?? 'FLAT_PER_INSTALLMENT',
    penaltyValue: product?.penalty_rule.value ?? '100',
    penaltyGrace: String(product?.penalty_rule.graceDays ?? 3),
    penaltyCap: product?.penalty_rule.cap ?? '',
    allocationMode: product?.allocation_rule.mode ?? 'INSTALLMENT_WISE',
  });
  const [fees, setFees] = useState<FeeRule[]>(product?.fee_rules ?? []);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = error?.fieldErrors() ?? {};
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });

  const [save, saving] = useSubmit(async () => {
    setError(null);
    const body = {
      code: v.code,
      name: v.name,
      description: v.description || undefined,
      category: v.category,
      interestMethod: v.interestMethod,
      rateMin: v.rateMin,
      rateDefault: v.rateDefault,
      rateMax: v.rateMax,
      amountMin: v.amountMin,
      amountMax: v.amountMax,
      tenureMin: v.tenureMin,
      tenureMax: v.tenureMax,
      allowedFrequencies: v.allowedFrequencies,
      roundingUnit: v.roundingUnit,
      skipSundays: v.skipSundays,
      feeRules: fees,
      penaltyRule: { type: v.penaltyType, value: v.penaltyType === 'NONE' ? '0' : v.penaltyValue, graceDays: v.penaltyGrace, cap: v.penaltyCap || null },
      allocationRule: { mode: v.allocationMode, order: ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'], excessHandling: 'ADVANCE' },
      maxLtvPct: v.maxLtvPct || undefined,
      approvalLimit: v.approvalLimit || undefined,
    };
    try {
      if (product) await api('PUT', `/loan-products/${product.id}`, { body });
      else await api('POST', '/loan-products', { body });
      toast('ok', product ? `Saved as version ${product.version + 1}` : 'Product created');
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    }
  });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={product ? `Edit ${product.name}` : 'New loan product'}
      description={product ? `Saving creates version ${product.version + 1}. Loans already created keep version ${product.version}.` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save()} loading={saving}>
            {product ? 'Save new version' : 'Create product'}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {error && <Alert>{error.message}</Alert>}
        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required error={fe.code} hint="Cannot change later">
            <Input value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} disabled={!!product} className="num font-mono uppercase" />
          </Field>
          <Field label="Name" required error={fe.name}>
            <Input value={v.name} onChange={set('name')} />
          </Field>
          <Field label="Category" required>
            <Select value={v.category} onChange={set('category')}>
              {LOAN_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Interest method" required>
            <Select value={v.interestMethod} onChange={set('interestMethod')}>
              {INTEREST_METHODS.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea value={v.description} onChange={set('description')} rows={2} />
          </Field>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink-950">Limits</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Min rate %" error={fe.rateMin}>
              <Input value={v.rateMin} onChange={set('rateMin')} className="num" />
            </Field>
            <Field label="Default rate %" error={fe.rateDefault}>
              <Input value={v.rateDefault} onChange={set('rateDefault')} className="num" />
            </Field>
            <Field label="Max rate %" error={fe.rateMax}>
              <Input value={v.rateMax} onChange={set('rateMax')} className="num" />
            </Field>
            <Field label="Min amount ₹" error={fe.amountMin}>
              <Input value={v.amountMin} onChange={set('amountMin')} className="num" />
            </Field>
            <Field label="Max amount ₹" error={fe.amountMax}>
              <Input value={v.amountMax} onChange={set('amountMax')} className="num" />
            </Field>
            <Field label="Max loan-to-value %" hint="Blank = no limit" error={fe.maxLtvPct}>
              <Input value={v.maxLtvPct} onChange={set('maxLtvPct')} className="num" />
            </Field>
            <Field label="Min installments" error={fe.tenureMin}>
              <Input value={v.tenureMin} onChange={set('tenureMin')} className="num" />
            </Field>
            <Field label="Max installments" error={fe.tenureMax}>
              <Input value={v.tenureMax} onChange={set('tenureMax')} className="num" />
            </Field>
            <Field label="Management approval above ₹" hint="Blank = branch manager approves any amount" error={fe.approvalLimit}>
              <Input value={v.approvalLimit} onChange={set('approvalLimit')} className="num" />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap gap-4">
            {FREQUENCIES.map((f) => (
              <Checkbox
                key={f}
                label={FREQUENCY_LABELS[f]}
                checked={v.allowedFrequencies.includes(f)}
                onChange={() => setV({ ...v, allowedFrequencies: v.allowedFrequencies.includes(f) ? v.allowedFrequencies.filter((x) => x !== f) : [...v.allowedFrequencies, f] })}
              />
            ))}
          </div>
          {fe.allowedFrequencies && <p className="mt-1 text-[12px] text-bad">{fe.allowedFrequencies}</p>}
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Round installment to">
              <Select value={v.roundingUnit} onChange={set('roundingUnit')}>
                <option value="0.01">Paise</option>
                <option value="1">₹1</option>
                <option value="10">₹10</option>
              </Select>
            </Field>
            <div className="flex items-end pb-2 sm:col-span-2">
              <Checkbox label="Daily loans: no collection on Sundays" checked={v.skipSundays} onChange={(e) => setV({ ...v, skipSundays: e.target.checked })} />
            </div>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-950">Fees</h3>
            <Button size="sm" variant="secondary" onClick={() => setFees([...fees, { code: 'PROCESSING', label: 'Processing fee', basis: 'PCT_OF_PRINCIPAL', value: '2', gstRatePct: '18', mode: 'DEDUCT_FROM_DISBURSAL' }])}>
              <Plus className="size-3.5" /> Add fee
            </Button>
          </div>
          {fees.length === 0 && <p className="text-[13px] text-muted">No fees.</p>}
          <div className="space-y-2">
            {fees.map((f, i) => {
              const upd = (p: Partial<FeeRule>) => setFees(fees.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_1.4fr_1fr_0.8fr_0.7fr_1.4fr_auto]">
                  <Input value={f.code} onChange={(e) => upd({ code: e.target.value.toUpperCase() })} aria-label="Fee code" placeholder="CODE" className="uppercase" />
                  <Input value={f.label} onChange={(e) => upd({ label: e.target.value })} aria-label="Fee label" />
                  <Select value={f.basis} onChange={(e) => upd({ basis: e.target.value as FeeRule['basis'] })} aria-label="Basis">
                    <option value="FLAT">Flat ₹</option>
                    <option value="PCT_OF_PRINCIPAL">% of loan</option>
                  </Select>
                  <Input value={f.value} onChange={(e) => upd({ value: e.target.value })} aria-label="Value" className="num" />
                  <Input value={f.gstRatePct} onChange={(e) => upd({ gstRatePct: e.target.value })} aria-label="GST %" className="num" />
                  <Select value={f.mode} onChange={(e) => upd({ mode: e.target.value as FeeRule['mode'] })} aria-label="Collected">
                    <option value="DEDUCT_FROM_DISBURSAL">Deduct at disbursal</option>
                    <option value="ADD_TO_FIRST_INSTALLMENT">With 1st installment</option>
                  </Select>
                  <Button size="sm" variant="ghost" onClick={() => setFees(fees.filter((_, j) => j !== i))} aria-label="Remove fee">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          {fees.length > 0 && <p className="mt-1 text-[12px] text-subtle">Code · label · basis · value · GST % · when collected. Codes PROCESSING and DOCUMENTATION post to their own income accounts.</p>}
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold text-ink-950">Penal charges ⚖</h3>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Type" className="sm:col-span-2">
              <Select value={v.penaltyType} onChange={set('penaltyType')}>
                {PENALTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PENALTY_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            {v.penaltyType !== 'NONE' && (
              <>
                <Field label={v.penaltyType === 'FLAT_PER_INSTALLMENT' ? 'Amount ₹' : 'Rate %'} error={fe['penaltyRule.value']}>
                  <Input value={v.penaltyValue} onChange={set('penaltyValue')} className="num" />
                </Field>
                <Field label="Grace days">
                  <Input value={v.penaltyGrace} onChange={set('penaltyGrace')} className="num" />
                </Field>
                <Field label="Cap per installment ₹" hint="Optional">
                  <Input value={v.penaltyCap} onChange={set('penaltyCap')} className="num" />
                </Field>
              </>
            )}
          </div>
          <p className="mt-2 text-[12px] text-subtle">Penal charges are a separate charge — never added to principal or compounded.</p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="How payments are applied" hint="Used from Phase 4 (collections)">
            <Select value={v.allocationMode} onChange={set('allocationMode')}>
              <option value="INSTALLMENT_WISE">Oldest installment first (penal → fees → interest → principal)</option>
              <option value="COMPONENT_WISE">All penal charges first, then fees, interest, principal</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Badge>Extra payment is held as customer advance</Badge>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
