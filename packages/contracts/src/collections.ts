import { z } from 'zod';
import { moneySchema } from './validators';

export const PAYMENT_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };

export const REVERSAL_REASONS = ['WRONG_AMOUNT', 'WRONG_LOAN', 'DUPLICATE', 'CHEQUE_BOUNCED', 'CUSTOMER_REFUND', 'OTHER'] as const;
export const REVERSAL_REASON_LABELS: Record<(typeof REVERSAL_REASONS)[number], string> = {
  WRONG_AMOUNT: 'Wrong amount entered',
  WRONG_LOAN: 'Recorded on the wrong loan',
  DUPLICATE: 'Recorded twice',
  CHEQUE_BOUNCED: 'Cheque bounced',
  CUSTOMER_REFUND: 'Refunded to customer',
  OTHER: 'Other',
};

export const VISIT_OUTCOMES = ['PAID', 'PARTIAL', 'PROMISED', 'NOT_AVAILABLE', 'REFUSED', 'SHIFTED', 'OTHER'] as const;
export const VISIT_OUTCOME_LABELS: Record<(typeof VISIT_OUTCOMES)[number], string> = {
  PAID: 'Paid',
  PARTIAL: 'Paid part',
  PROMISED: 'Promised to pay',
  NOT_AVAILABLE: 'Not available',
  REFUSED: 'Refused to pay',
  SHIFTED: 'Shifted / not at address',
  OTHER: 'Other',
};

export const MESSAGE_CHANNELS = ['SMS', 'WHATSAPP'] as const;
export const MESSAGE_EVENTS = ['PAYMENT_RECEIVED', 'DUE_REMINDER', 'OVERDUE', 'LOAN_DISBURSED', 'LOAN_CLOSED', 'PAYMENT_REVERSED'] as const;
export const MESSAGE_EVENT_LABELS: Record<(typeof MESSAGE_EVENTS)[number], string> = {
  PAYMENT_RECEIVED: 'Payment received',
  DUE_REMINDER: 'Installment due reminder',
  OVERDUE: 'Overdue notice',
  LOAN_DISBURSED: 'Loan disbursed',
  LOAN_CLOSED: 'Loan closed',
  PAYMENT_REVERSED: 'Receipt cancelled',
};

const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());
const coord = (max: number) => z.coerce.number().min(-max).max(max);

export const paymentCreateSchema = z
  .object({
    amount: moneySchema.refine((v) => Number(v) > 0, 'Amount must be more than zero'),
    method: z.enum(PAYMENT_METHODS),
    /** UTR / UPI transaction id / cheque number. Required unless cash. */
    reference: optional(z.string().trim().toUpperCase().regex(/^[A-Z0-9/-]{4,40}$/, 'Letters and numbers only (4–40)')),
    /** Bank account the transfer went into (BANK_TRANSFER only). */
    accountId: optional(z.string().uuid()),
    chequeBank: optional(z.string().trim().max(80)),
    chequeDate: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Collected at the branch counter (branch cash) rather than in the field. */
    atCounter: z.boolean().default(false),
    notes: optional(z.string().trim().max(500)),
    location: optional(z.string().trim().max(200)),
    lat: optional(coord(90)),
    lng: optional(coord(180)),
    /** Set after the user has seen and accepted a "possible duplicate" warning. */
    confirmDuplicate: z.boolean().default(false),
    /** Send the payment confirmation by SMS / WhatsApp. */
    notify: z.boolean().default(true),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (p.method !== 'CASH' && !p.reference) issue('reference', p.method === 'CHEQUE' ? 'Cheque number is required' : 'UTR / transaction ID is required');
    if (p.method === 'BANK_TRANSFER' && !p.accountId) issue('accountId', 'Choose the bank account the money came into');
    if (p.method === 'CHEQUE' && !p.chequeBank) issue('chequeBank', 'Bank name is required');
    if (p.method === 'CHEQUE' && !p.chequeDate) issue('chequeDate', 'Cheque date is required');
  });
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const paymentPreviewSchema = z.object({ amount: moneySchema }).strict();

export const reversalRequestSchema = z
  .object({
    reasonCode: z.enum(REVERSAL_REASONS).refine((r) => r !== 'CHEQUE_BOUNCED', 'Use the cheque bounce action for bounced cheques'),
    reasonText: z.string().trim().min(5, 'Explain what happened (at least 5 characters)').max(500),
  })
  .strict();
export const reversalDecisionSchema = z.object({ note: optional(z.string().trim().max(500)) }).strict();
export const reversalRejectSchema = z.object({ note: z.string().trim().min(3, 'Give a reason').max(500) }).strict();

export const paymentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
  loanId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  collectorId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(['POSTED', 'REVERSAL_PENDING', 'REVERSED']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(60).optional(),
});

export const assignSchema = z
  .object({
    loanIds: z.array(z.string().uuid()).min(1).max(500),
    /** null removes the assignment. */
    employeeId: z.string().uuid().nullable(),
    reason: optional(z.string().trim().max(200)),
  })
  .strict();

export const visitSchema = z
  .object({
    outcome: z.enum(VISIT_OUTCOMES),
    notes: optional(z.string().trim().max(500)),
    promisedAmount: optional(moneySchema),
    promisedDate: optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    lat: optional(coord(90)),
    lng: optional(coord(180)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.outcome === 'PROMISED') {
      if (!v.promisedAmount || Number(v.promisedAmount) <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promisedAmount'], message: 'Promised amount is required' });
      if (!v.promisedDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['promisedDate'], message: 'Promised date is required' });
    }
  });

export const templateUpdateSchema = z
  .object({
    body: z.string().trim().min(10).max(1000),
    dltTemplateId: optional(z.string().trim().regex(/^\d{10,25}$/, 'DLT template IDs are 10–25 digits')).nullable(),
    waTemplateName: optional(z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Lowercase letters, numbers and _')).nullable(),
    waLanguage: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('en'),
    isActive: z.boolean(),
  })
  .strict();

export const reminderRuleUpdateSchema = z.object({ isActive: z.boolean(), minAmount: moneySchema.default('1') }).strict();

export const messageSendSchema = z
  .object({
    channel: z.enum(MESSAGE_CHANNELS),
    eventCode: z.enum(['DUE_REMINDER', 'OVERDUE', 'PAYMENT_RECEIVED']),
    loanId: z.string().uuid(),
    /** For PAYMENT_RECEIVED: resend the confirmation of this payment. */
    paymentId: optional(z.string().uuid()),
  })
  .strict();

/** `{{name}}`-style placeholders in a template body. */
export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]!))];
}
