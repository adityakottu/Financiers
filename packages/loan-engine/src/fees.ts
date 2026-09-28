import { Money } from '@fin/money';
import type { FeeInput, FeeMode } from './types';

export const FEE_BASES = ['FLAT', 'PCT_OF_PRINCIPAL'] as const;
export type FeeBasis = (typeof FEE_BASES)[number];

/** A product's fee definition; turned into concrete amounts for a given loan amount. */
export interface FeeRule {
  code: string;
  label: string;
  basis: FeeBasis;
  /** Rupees for FLAT, percent of principal for PCT_OF_PRINCIPAL. */
  value: string;
  /** GST percent on the fee, e.g. "18" (0 when not applicable ⚖). */
  gstRatePct: string;
  mode: FeeMode;
}

export function computeFees(rules: FeeRule[], principal: string): FeeInput[] {
  const P = Money.of(principal);
  return rules
    .map((r) => {
      const amount = r.basis === 'FLAT' ? Money.of(r.value) : P.times(Money.of(r.value).toDecimal().dividedBy(100));
      const gst = amount.times(Money.of(r.gstRatePct).toDecimal().dividedBy(100));
      return { code: r.code, label: r.label, amount: amount.toString(), gstAmount: gst.toString(), mode: r.mode };
    })
    .filter((f) => Money.of(f.amount).isPositive());
}
