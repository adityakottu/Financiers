'use client';

import { customerCreateSchema, customerUpdateSchema, GENDERS, RELATION_TYPES } from '@fin/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useToast } from './toast';
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea } from './ui';

type Values = Record<string, string>;
type Ref = { name: string; relationship: string; mobile: string };

const FIELDS = [
  'branchId', 'fullName', 'relationType', 'relationName', 'dob', 'gender', 'mobile', 'altMobile', 'email',
  'addressLine1', 'addressLine2', 'villageTown', 'mandal', 'district', 'state', 'pincode',
  'occupation', 'employerBusinessName', 'businessType', 'monthlyIncome', 'workAddress',
] as const;

export interface CustomerInitial extends Partial<Record<(typeof FIELDS)[number], string | null>> {
  id?: string;
  version?: number;
  whatsappOptIn?: boolean;
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="grid gap-6 p-5 md:grid-cols-[220px_1fr] md:p-6">
        <div>
          <h2 className="text-[15px] font-semibold text-ink-950">{title}</h2>
          {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">{children}</div>
      </div>
    </Card>
  );
}

export function CustomerForm({ initial }: { initial?: CustomerInitial }) {
  const editing = !!initial?.id;
  const router = useRouter();
  const toast = useToast();
  const { me } = useSession();
  // One key per form instance: a double submit or network retry can't create two customers.
  const idemKey = useMemo(() => newIdempotencyKey(), []);

  const [v, setV] = useState<Values>(() => {
    const out: Values = {};
    for (const f of FIELDS) out[f] = (initial?.[f] as string | null | undefined) ?? '';
    if (!out.branchId && me?.branches.length === 1) out.branchId = me.branches[0]!.id;
    if (!out.state) out.state = 'Andhra Pradesh';
    return out;
  });
  const [whatsapp, setWhatsapp] = useState(initial?.whatsappOptIn ?? false);
  const [kyc, setKyc] = useState({ pan: '', aadhaarLast4: '', drivingLicence: '', voterId: '' });
  const [refs, setRefs] = useState<Ref[]>([{ name: '', relationship: '', mobile: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((prev) => ({ ...prev, [k]: e.target.value }));
  const err = (k: string) => errors[k];
  const input = (k: (typeof FIELDS)[number], props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Input value={v[k]} onChange={set(k)} aria-invalid={!!err(k)} {...props} />
  );

  const [submit, pending] = useSubmit(async () => {
    setFormError(null);
    let payload: Record<string, unknown>;
    if (editing) {
      // Only changed fields; "" clears a value.
      payload = {};
      for (const f of FIELDS) if ((initial?.[f] ?? '') !== v[f]) payload[f] = v[f] === '' ? null : v[f];
      if (whatsapp !== initial?.whatsappOptIn) payload.whatsappOptIn = whatsapp;
      if (Object.keys(payload).length === 0) return router.push(`/customers/${initial!.id}`);
    } else {
      payload = { ...Object.fromEntries(FIELDS.map((f) => [f, v[f]])), whatsappOptIn: whatsapp, kyc, references: refs.filter((r) => r.name || r.mobile) };
    }

    const parsed = (editing ? customerUpdateSchema : customerCreateSchema).safeParse(payload);
    if (!parsed.success) {
      const fe: Record<string, string> = {};
      for (const i of parsed.error.issues) fe[i.path.join('.')] ??= i.message;
      setErrors(fe);
      setFormError('Please correct the highlighted fields.');
      document.querySelector('[aria-invalid="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setErrors({});
    try {
      if (editing) {
        await api('PATCH', `/customers/${initial!.id}`, { body: payload, ifMatch: initial!.version });
        toast('ok', 'Customer updated');
        router.push(`/customers/${initial!.id}`);
      } else {
        const r = await api<{ id: string; customerNo: string }>('POST', '/customers', { body: payload, idempotencyKey: idemKey });
        toast('ok', `Customer ${r.customerNo} created`);
        router.push(`/customers/${r.id}`);
      }
    } catch (e) {
      const ae = e as ApiError;
      setErrors(ae.fieldErrors());
      setFormError(ae.code === 'VERSION_CONFLICT' ? 'Someone else changed this customer while you were editing. Reload to see their changes.' : ae.message);
    }
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-5"
      noValidate
    >
      {formError && <Alert>{formError}</Alert>}

      <Section title="Personal details" description="As on the customer’s ID documents.">
        <Field label="Branch" required error={err('branchId')}>
          <Select value={v.branchId} onChange={set('branchId')} aria-invalid={!!err('branchId')}>
            <option value="">Select branch</option>
            {me?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Full name" required error={err('fullName')}>
          {input('fullName', { autoComplete: 'off' })}
        </Field>
        <Field label="Relation" error={err('relationType')}>
          <Select value={v.relationType} onChange={set('relationType')}>
            <option value="">—</option>
            {RELATION_TYPES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Field label="Father’s / spouse’s name" error={err('relationName')}>
          {input('relationName')}
        </Field>
        <Field label="Date of birth" error={err('dob')}>
          {input('dob', { type: 'date', max: new Date().toISOString().slice(0, 10) })}
        </Field>
        <Field label="Gender" error={err('gender')}>
          <Select value={v.gender} onChange={set('gender')}>
            <option value="">—</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>
                {g.charAt(0) + g.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </Section>

      <Section title="Contact" description="Mobile is used for receipts and reminders.">
        <Field label="Mobile" required error={err('mobile')}>
          {input('mobile', { inputMode: 'tel', placeholder: '98765 43210' })}
        </Field>
        <Field label="Alternate mobile" error={err('altMobile')}>
          {input('altMobile', { inputMode: 'tel' })}
        </Field>
        <Field label="Email" error={err('email')}>
          {input('email', { type: 'email' })}
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} label="Customer agreed to receive WhatsApp messages" />
        </div>
      </Section>

      <Section title="Address">
        <Field label="House / street" error={err('addressLine1')} className="sm:col-span-2">
          {input('addressLine1')}
        </Field>
        <Field label="Landmark / area" error={err('addressLine2')} className="sm:col-span-2">
          {input('addressLine2')}
        </Field>
        <Field label="Village / town" error={err('villageTown')}>
          {input('villageTown')}
        </Field>
        <Field label="Mandal" error={err('mandal')}>
          {input('mandal')}
        </Field>
        <Field label="District" error={err('district')}>
          {input('district')}
        </Field>
        <Field label="State" error={err('state')}>
          {input('state')}
        </Field>
        <Field label="PIN code" error={err('pincode')}>
          {input('pincode', { inputMode: 'numeric', maxLength: 6 })}
        </Field>
      </Section>

      <Section title="Work & income">
        <Field label="Occupation" error={err('occupation')}>
          {input('occupation')}
        </Field>
        <Field label="Employer / business name" error={err('employerBusinessName')}>
          {input('employerBusinessName')}
        </Field>
        <Field label="Business type" error={err('businessType')}>
          {input('businessType')}
        </Field>
        <Field label="Monthly income (₹)" error={err('monthlyIncome')}>
          {input('monthlyIncome', { inputMode: 'decimal', className: 'num' })}
        </Field>
        <Field label="Work address" error={err('workAddress')} className="sm:col-span-2">
          <Textarea value={v.workAddress} onChange={set('workAddress')} rows={2} />
        </Field>
      </Section>

      {!editing && (
        <>
          <Section title="KYC" description="Numbers are encrypted and shown masked. Only the last 4 digits of Aadhaar are ever stored.">
            <Field label="PAN" error={err('kyc.pan')}>
              <Input value={kyc.pan} onChange={(e) => setKyc({ ...kyc, pan: e.target.value.toUpperCase() })} placeholder="ABCDE1234F" maxLength={10} className="num uppercase" aria-invalid={!!err('kyc.pan')} />
            </Field>
            <Field label="Aadhaar — last 4 digits only" error={err('kyc.aadhaarLast4')}>
              <Input value={kyc.aadhaarLast4} onChange={(e) => setKyc({ ...kyc, aadhaarLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" maxLength={4} placeholder="1234" className="num" aria-invalid={!!err('kyc.aadhaarLast4')} />
            </Field>
            <Field label="Driving licence" error={err('kyc.drivingLicence')}>
              <Input value={kyc.drivingLicence} onChange={(e) => setKyc({ ...kyc, drivingLicence: e.target.value.toUpperCase() })} className="uppercase" aria-invalid={!!err('kyc.drivingLicence')} />
            </Field>
            <Field label="Voter ID" error={err('kyc.voterId')}>
              <Input value={kyc.voterId} onChange={(e) => setKyc({ ...kyc, voterId: e.target.value.toUpperCase() })} className="uppercase" aria-invalid={!!err('kyc.voterId')} />
            </Field>
          </Section>

          <Section title="References" description="People who can vouch for the customer.">
            {refs.map((r, i) => (
              <div key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label={`Reference ${i + 1} name`} error={err(`references.${i}.name`)}>
                  <Input value={r.name} onChange={(e) => setRefs(refs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </Field>
                <Field label={`Reference ${i + 1} relationship`} error={err(`references.${i}.relationship`)}>
                  <Input value={r.relationship} onChange={(e) => setRefs(refs.map((x, j) => (j === i ? { ...x, relationship: e.target.value } : x)))} />
                </Field>
                <Field label={`Reference ${i + 1} mobile`} error={err(`references.${i}.mobile`)}>
                  <Input value={r.mobile} inputMode="tel" onChange={(e) => setRefs(refs.map((x, j) => (j === i ? { ...x, mobile: e.target.value } : x)))} />
                </Field>
                <div className="flex items-end">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRefs(refs.filter((_, j) => j !== i))} aria-label="Remove reference">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            {refs.length < 5 && (
              <div className="sm:col-span-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setRefs([...refs, { name: '', relationship: '', mobile: '' }])}>
                  <Plus className="size-4" /> Add reference
                </Button>
              </div>
            )}
          </Section>
        </>
      )}

      <div className="sticky bottom-16 z-10 -mx-4 flex justify-end gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:rounded-lg md:border md:px-5">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? 'Save changes' : 'Create customer'}
        </Button>
      </div>
    </form>
  );
}
