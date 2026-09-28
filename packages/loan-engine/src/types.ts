export const INTEREST_METHODS = ['FLAT', 'REDUCING_EMI', 'SIMPLE'] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FEE_MODES = ['DEDUCT_FROM_DISBURSAL', 'ADD_TO_FIRST_INSTALLMENT'] as const;
export type FeeMode = (typeof FEE_MODES)[number];

export const ROUNDING_UNITS = ['0.01', '1', '10'] as const;
export type RoundingUnit = (typeof ROUNDING_UNITS)[number];

export interface FeeInput {
  code: string;
  label?: string;
  /** Fee before GST. */
  amount: string;
  /** GST on the fee (0 when not applicable). */
  gstAmount?: string;
  mode: FeeMode;
}

/** Everything the engine needs. Money and rates are decimal strings — never JS floats. */
export interface LoanTerms {
  principal: string;
  /** Percent per annum, e.g. "24" or "18.5". */
  annualRate: string;
  method: InterestMethod;
  frequency: Frequency;
  /** Required for CUSTOM frequency. */
  customIntervalDays?: number;
  numInstallments: number;
  disbursementDate: string;
  firstDueDate: string;
  roundingUnit: RoundingUnit;
  fees?: FeeInput[];
  /** DAILY only: no collection on Sundays. */
  skipSundays?: boolean;
}

export interface ScheduleRow {
  no: number;
  dueDate: string;
  openingPrincipal: string;
  principal: string;
  interest: string;
  fees: string;
  total: string;
  closingPrincipal: string;
}

export interface ScheduleTotals {
  principal: string;
  interest: string;
  /** Fees excluding GST. */
  fees: string;
  gst: string;
  /** Fees + GST taken out of the disbursed amount. */
  feesDeducted: string;
  /** Fees + GST collected with installment 1. */
  feesInInstallments: string;
  /** What the customer repays over the schedule. */
  totalPayable: string;
  /** Regular installment amount (the last may differ). */
  installmentAmount: string;
  lastInstallmentAmount: string;
  /** Cash the customer actually receives. */
  netDisbursed: string;
}

export interface Schedule {
  engineVersion: string;
  terms: LoanTerms;
  rows: ScheduleRow[];
  totals: ScheduleTotals;
  /** Annualised effective cost from actual cash flows (XIRR), percent with 4 decimals. ⚖ disclosure basis to confirm */
  apr: string;
  maturityDate: string;
}

export class EngineError extends Error {
  override name = 'EngineError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
