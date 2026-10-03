import { z } from 'zod';
import { moneySchema } from './validators';

const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const positive = moneySchema.refine((v) => Number(v) > 0, 'Amount must be more than zero');

export const EXPENSE_PAID_FROM = ['EMPLOYEE_CASH', 'BRANCH_CASH', 'BANK'] as const;
export const EXPENSE_PAID_FROM_LABELS: Record<(typeof EXPENSE_PAID_FROM)[number], string> = {
  EMPLOYEE_CASH: 'My cash in hand',
  BRANCH_CASH: 'Branch cash',
  BANK: 'Bank account',
};

export const expenseCreateSchema = z
  .object({
    branchId: z.string().uuid(),
    categoryId: z.string().uuid(),
    amount: positive,
    expenseDate: isoDate,
    paidFrom: z.enum(EXPENSE_PAID_FROM),
    /** Required when paid from a bank account. */
    accountId: optional(z.string().uuid()),
    vendor: optional(z.string().trim().max(120)),
    billNo: optional(z.string().trim().max(60)),
    description: z.string().trim().min(3, 'Say what it was for').max(500),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.paidFrom === 'BANK' && !e.accountId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accountId'], message: 'Choose the bank account' });
  });

export const expenseRejectSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }).strict();

export const depositCreateSchema = z
  .object({
    fromAccountId: z.string().uuid(),
    toAccountId: z.string().uuid(),
    amount: positive,
    depositedOn: isoDate,
    slipNo: optional(z.string().trim().max(60)),
    notes: optional(z.string().trim().max(300)),
  })
  .strict()
  .refine((d) => d.fromAccountId !== d.toAccountId, { path: ['toAccountId'], message: 'From and to must differ' });

export const reverseReasonSchema = z.object({ reason: z.string().trim().min(5, 'Explain why (at least 5 characters)').max(500) }).strict();

export const chequeDepositSchema = z.object({ accountId: z.string().uuid(), depositedOn: isoDate }).strict();
export const chequeClearSchema = z.object({ clearedOn: isoDate }).strict();
export const chequeBounceSchema = z
  .object({
    bouncedOn: isoDate,
    reason: z.string().trim().min(3).max(300),
    /** Bounce charge to add to the loan, per the product terms ⚖. */
    charge: optional(moneySchema),
  })
  .strict();

export const journalLineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: moneySchema.default('0'),
    credit: moneySchema.default('0'),
    memo: optional(z.string().trim().max(200)),
  })
  .strict()
  .refine((l) => (Number(l.debit) > 0) !== (Number(l.credit) > 0), 'Each line is either a debit or a credit');

export const manualJournalSchema = z
  .object({
    valueDate: isoDate,
    branchId: optional(z.string().uuid()),
    narration: z.string().trim().min(5).max(500),
    lines: z.array(journalLineSchema).min(2).max(30),
  })
  .strict();

export const journalListQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.string().regex(/^[A-Z_]+$/).optional(),
  branchId: z.string().uuid().optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().uuid().optional(),
});

export const periodQuerySchema = z.object({ from: isoDate, to: isoDate, branchId: z.string().uuid().optional() });
export const asOfQuerySchema = z.object({ asOf: isoDate, branchId: z.string().uuid().optional() });
export const unlockSchema = z.object({ reason: z.string().trim().min(10, 'Explain why the month must be reopened').max(500) }).strict();
