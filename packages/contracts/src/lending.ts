import { FEE_BASES, FEE_MODES, FREQUENCIES, INTEREST_METHODS, PENALTY_TYPES, ROUNDING_UNITS } from '@fin/loan-engine';
import { z } from 'zod';
import { isoDateSchema, moneySchema } from './validators';

export const LOAN_CATEGORIES = ['ELECTRONICS', 'TWO_WHEELER', 'THREE_WHEELER', 'FOUR_WHEELER', 'BUS', 'LORRY_TRUCK', 'OTHER'] as const;
export type LoanCategory = (typeof LOAN_CATEGORIES)[number];
export const VEHICLE_CATEGORIES: LoanCategory[] = ['TWO_WHEELER', 'THREE_WHEELER', 'FOUR_WHEELER', 'BUS', 'LORRY_TRUCK'];
export const COMMERCIAL_CATEGORIES: LoanCategory[] = ['THREE_WHEELER', 'BUS', 'LORRY_TRUCK'];

export const CATEGORY_LABELS: Record<LoanCategory, string> = {
  ELECTRONICS: 'Electronics',
  TWO_WHEELER: '2 Wheeler',
  THREE_WHEELER: '3 Wheeler',
  FOUR_WHEELER: '4 Wheeler',
  BUS: 'Bus',
  LORRY_TRUCK: 'Lorry / Truck',
  OTHER: 'Other',
};

export const ALLOCATION_COMPONENTS = ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'] as const;

const rate = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage like 24 or 18.5')
  .refine((v) => Number(v) <= 100, 'At most 100%');
const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

export const feeRuleSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,30}$/),
    label: z.string().trim().min(2).max(60),
    basis: z.enum(FEE_BASES),
    value: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Enter an amount or percentage'),
    gstRatePct: rate.default('0'),
    mode: z.enum(FEE_MODES),
  })
  .strict();

export const penaltyRuleSchema = z
  .object({
    type: z.enum(PENALTY_TYPES),
    value: z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/).default('0'),
    graceDays: z.coerce.number().int().min(0).max(90).default(0),
    cap: optional(moneySchema).nullable().default(null),
  })
  .strict();

export const allocationRuleSchema = z
  .object({
    mode: z.enum(['INSTALLMENT_WISE', 'COMPONENT_WISE']),
    order: z
      .array(z.enum(ALLOCATION_COMPONENTS))
      .length(4)
      .refine((o) => new Set(o).size === 4, 'Each component exactly once'),
    excessHandling: z.enum(['ADVANCE', 'REJECT']),
  })
  .strict();

export const productSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, '2–20 letters, numbers, - or _'),
    name: z.string().trim().min(3).max(80),
    description: optional(z.string().trim().max(500)),
    category: z.enum(LOAN_CATEGORIES),
    interestMethod: z.enum(INTEREST_METHODS),
    rateMin: rate,
    rateDefault: rate,
    rateMax: rate,
    amountMin: moneySchema,
    amountMax: moneySchema,
    tenureMin: z.coerce.number().int().min(1).max(1000),
    tenureMax: z.coerce.number().int().min(1).max(1000),
    allowedFrequencies: z.array(z.enum(FREQUENCIES)).min(1),
    roundingUnit: z.enum(ROUNDING_UNITS).default('1'),
    skipSundays: z.boolean().default(false),
    feeRules: z.array(feeRuleSchema).max(10).default([]),
    penaltyRule: penaltyRuleSchema,
    allocationRule: allocationRuleSchema.default({
      mode: 'INSTALLMENT_WISE',
      order: ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL'],
      excessHandling: 'ADVANCE',
    }),
    maxLtvPct: optional(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/)),
    approvalLimit: optional(moneySchema),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (!(Number(p.rateMin) <= Number(p.rateDefault) && Number(p.rateDefault) <= Number(p.rateMax))) issue('rateDefault', 'Default rate must be between minimum and maximum');
    if (Number(p.amountMin) <= 0 || Number(p.amountMin) > Number(p.amountMax)) issue('amountMax', 'Maximum amount must be at least the minimum');
    if (p.tenureMin > p.tenureMax) issue('tenureMax', 'Maximum tenure must be at least the minimum');
    if (new Set(p.feeRules.map((f) => f.code)).size !== p.feeRules.length) issue('feeRules', 'Fee codes must be unique');
  });

/* ---------------- Assets ---------------- */

/** Indian registration numbers, normalised: AP05AB1234, AP051234, 22BH1234AA (BH series). */
export function normaliseRegistration(v: string): string {
  return v.toUpperCase().replace(/[\s-]/g, '');
}
export const REGISTRATION_RE = /^([A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}|\d{2}BH\d{4}[A-Z]{1,2})$/;

const text = (max: number) => optional(z.string().trim().max(max));
const upperId = (max: number) =>
  optional(
    z
      .string()
      .trim()
      .transform((v) => v.toUpperCase().replace(/\s/g, ''))
      .pipe(z.string().regex(/^[A-Z0-9-/]{3,40}$/, 'Letters and numbers only').max(max)),
  );

export const assetSchema = z
  .object({
    description: text(200),
    make: text(60),
    model: text(80),
    variant: text(80),
    manufactureYear: optional(z.coerce.number().int().min(1980).max(2100)),
    colour: text(40),
    serialNo: upperId(40),
    registrationNo: optional(
      z
        .string()
        .trim()
        .transform(normaliseRegistration)
        .pipe(z.string().regex(REGISTRATION_RE, 'Registration like AP05AB1234')),
    ),
    chassisNo: upperId(30),
    engineNo: upperId(30),
    vehicleType: text(60),
    assetValue: optional(moneySchema),
    purchasePrice: optional(moneySchema),
    purchaseDate: optional(isoDateSchema),
    dealerName: text(120),
    invoiceNo: text(60),
    hypothecationMarked: z.boolean().default(false),
    insurer: text(80),
    insurancePolicyNo: text(60),
    insuranceExpiry: optional(isoDateSchema),
    permitNo: text(60),
    permitExpiry: optional(isoDateSchema),
    fitnessExpiry: optional(isoDateSchema),
    taxValidTill: optional(isoDateSchema),
  })
  .strict();
export type AssetInput = z.infer<typeof assetSchema>;

/** Category-specific required fields (doc 01 §9 step 3). Returns field → message. */
export function assetProblems(category: LoanCategory, a: AssetInput): Record<string, string> {
  const out: Record<string, string> = {};
  const need = (k: keyof AssetInput, label: string) => {
    if (a[k] === undefined || a[k] === '') out[k] = `${label} is required`;
  };
  if (category === 'ELECTRONICS') {
    need('description', 'Product');
    need('make', 'Brand');
    need('model', 'Model');
    need('serialNo', 'Serial number');
  } else if (VEHICLE_CATEGORIES.includes(category)) {
    need('make', 'Make');
    need('model', 'Model');
    need('manufactureYear', 'Manufacturing year');
    need('chassisNo', 'Chassis number');
    need('engineNo', 'Engine number');
    if (COMMERCIAL_CATEGORIES.includes(category)) need('vehicleType', 'Vehicle type');
  } else {
    need('description', 'Description');
  }
  return out;
}

/* ---------------- Loans ---------------- */

const termsFields = {
  principal: moneySchema,
  annualRate: rate,
  frequency: z.enum(FREQUENCIES),
  customIntervalDays: optional(z.coerce.number().int().min(1).max(365)),
  numInstallments: z.coerce.number().int().min(1).max(1000),
  disbursementDate: isoDateSchema,
  firstDueDate: isoDateSchema,
};

/** Preview for a product (fees and rounding come from the product). */
export const loanCalculateSchema = z.object({ productId: z.string().uuid(), ...termsFields }).strict();

/** Stand-alone calculator (no product): every setting supplied. */
export const freeCalculateSchema = z
  .object({
    ...termsFields,
    method: z.enum(INTEREST_METHODS),
    roundingUnit: z.enum(ROUNDING_UNITS).default('1'),
    skipSundays: z.boolean().default(false),
    feeRules: z.array(feeRuleSchema).max(10).default([]),
  })
  .strict();

export const loanCreateSchema = z
  .object({
    customerId: z.string().uuid(),
    productId: z.string().uuid(),
    ...termsFields,
    downPayment: optional(moneySchema),
    asset: assetSchema,
    /** Hash of the preview the user saw; the server refuses if its own calculation differs. */
    previewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
export type LoanCreateInput = z.infer<typeof loanCreateSchema>;

export const loanDecisionSchema = z.object({ note: optional(z.string().trim().max(500)) }).strict();
export const loanRejectSchema = z.object({ note: z.string().trim().min(5, 'Give a reason').max(500) }).strict();
export const loanCancelSchema = z.object({ reason: z.string().trim().min(5, 'Give a reason').max(500) }).strict();

export const DISBURSEMENT_MODES = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'] as const;
export const loanDisburseSchema = z
  .object({
    accountId: z.string().uuid(),
    mode: z.enum(DISBURSEMENT_MODES),
    reference: optional(z.string().trim().max(60)),
    disbursedOn: isoDateSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.mode !== 'CASH' && !d.reference) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reference'], message: 'Enter the transaction / cheque reference' });
  });

export const LOAN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const;
export const loanListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
  q: z.string().trim().max(60).optional(),
  status: z.enum(LOAN_STATUSES).optional(),
  category: z.enum(LOAN_CATEGORIES).optional(),
  branchId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  overdueOnly: z.enum(['true', 'false']).optional(),
});

export const bankAccountCreateSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    bankName: z.string().trim().min(2).max(80),
    branchName: optional(z.string().trim().max(80)),
    accountNumber: optional(z.string().trim().regex(/^\d{6,18}$/, '6–18 digits')),
    ifsc: optional(z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC')),
    upiVpa: optional(z.string().trim().regex(/^[\w.-]{2,}@[\w]{2,}$/, 'Invalid UPI ID')),
    kind: z.enum(['CURRENT', 'SAVINGS', 'UPI_SETTLEMENT', 'WALLET']),
  })
  .strict();
