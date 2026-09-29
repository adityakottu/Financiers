'use client';

import { AssetInput, assetProblems, COMMERCIAL_CATEGORIES, LoanCategory, VEHICLE_CATEGORIES } from '@fin/contracts';
import { Checkbox, Field, Input } from './ui';

/** Asset fields that adapt to the loan category (doc 01 §9 step 3). */
export function AssetFields({
  category,
  v,
  set,
  errors,
  hypothecation,
  setHypothecation,
}: {
  category: LoanCategory;
  v: Record<string, string>;
  set: (v: Record<string, string>) => void;
  errors: Record<string, string>;
  hypothecation: boolean;
  setHypothecation: (b: boolean) => void;
}) {
  const vehicle = VEHICLE_CATEGORIES.includes(category);
  const commercial = COMMERCIAL_CATEGORIES.includes(category);
  const req = assetProblems(category, {} as AssetInput);
  const f = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Field label={label} required={k in req} error={errors[k]}>
      <Input value={v[k] ?? ''} onChange={(e) => set({ ...v, [k]: e.target.value })} {...props} />
    </Field>
  );
  return (
    <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      {!vehicle && f('description', category === 'ELECTRONICS' ? 'Product (e.g. LED TV 43")' : 'Description')}
      {f('make', vehicle ? 'Make' : 'Brand')}
      {f('model', 'Model')}
      {vehicle && f('variant', 'Variant')}
      {vehicle && f('manufactureYear', 'Manufacturing year', { inputMode: 'numeric', maxLength: 4 })}
      {vehicle && f('colour', 'Colour')}
      {!vehicle && f('serialNo', 'Serial number', { className: 'uppercase' })}
      {vehicle && f('registrationNo', 'Registration number', { placeholder: 'AP05AB1234 (blank if new)', className: 'uppercase' })}
      {vehicle && f('chassisNo', 'Chassis number', { className: 'uppercase' })}
      {vehicle && f('engineNo', 'Engine number', { className: 'uppercase' })}
      {commercial && f('vehicleType', category === 'LORRY_TRUCK' ? 'Vehicle type (e.g. 10-wheel tipper)' : 'Vehicle type')}
      {f('assetValue', 'Asset value (₹)', { inputMode: 'decimal', className: 'num' })}
      {f('purchasePrice', 'Purchase price (₹)', { inputMode: 'decimal', className: 'num' })}
      {f('dealerName', 'Dealer')}
      {f('invoiceNo', 'Invoice number')}
      {vehicle && f('insurer', 'Insurer')}
      {vehicle && f('insurancePolicyNo', 'Insurance policy no.')}
      {vehicle && f('insuranceExpiry', 'Insurance expiry', { type: 'date' })}
      {commercial && f('permitNo', 'Permit number')}
      {commercial && f('permitExpiry', 'Permit expiry', { type: 'date' })}
      {commercial && f('fitnessExpiry', 'Fitness certificate expiry', { type: 'date' })}
      {vehicle && (
        <div className="flex items-end pb-2">
          <Checkbox label="Hypothecation marked on RC" checked={hypothecation} onChange={(e) => setHypothecation(e.target.checked)} />
        </div>
      )}
    </div>
  );
}

