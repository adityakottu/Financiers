import { z } from 'zod';
import { moneySchema } from './validators';

const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const positive = moneySchema.refine((v) => Number(v) > 0, 'Amount must be more than zero');

export const RECOVERY_ACTION_LABELS: Record<string, string> = {
  OPENED: 'Case opened',
  NOTE: 'Note',
  CALL: 'Call',
  VISIT: 'Visit',
  STAGE_CHANGED: 'Stage changed',
  STAGE_REQUESTED: 'Stage change requested',
  STAGE_REJECTED: 'Stage change rejected',
  REPOSSESSED: 'Asset repossessed',
  RELEASED: 'Asset released',
  SALE_REQUESTED: 'Sale requested',
  SALE_APPROVED: 'Sale approved',
  SALE_REJECTED: 'Sale rejected',
  WRITE_OFF_REQUESTED: 'Write-off requested',
  WRITTEN_OFF: 'Written off',
  WRITE_OFF_REJECTED: 'Write-off rejected',
  CLOSED: 'Case closed',
  REOPENED: 'Case reopened',
};

/** DPD buckets used by recovery and the receivables ageing report. */
export const DPD_BUCKETS = [
  { code: 'CURRENT', label: 'Current', min: 0, max: 0 },
  { code: 'DPD_1_30', label: '1–30', min: 1, max: 30 },
  { code: 'DPD_31_60', label: '31–60', min: 31, max: 60 },
  { code: 'DPD_61_90', label: '61–90', min: 61, max: 90 },
  { code: 'DPD_90_PLUS', label: '90+', min: 91, max: null },
] as const;

export const recoveryOpenSchema = z
  .object({ loanId: z.string().uuid(), ownerEmployeeId: optional(z.string().uuid()), note: z.string().trim().min(5, 'Say why the case is opened').max(1000) })
  .strict();

export const recoveryActionSchema = z
  .object({ type: z.enum(['NOTE', 'CALL', 'VISIT']), summary: z.string().trim().min(3, 'Write what happened').max(1000) })
  .strict();

export const recoveryStageSchema = z.object({ stage: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/), note: z.string().trim().min(5, 'Explain the move').max(1000) }).strict();
export const recoveryCloseSchema = z.object({ reason: z.string().trim().min(5, 'Explain why the case is closed').max(1000) }).strict();
export const recoveryOwnerSchema = z.object({ ownerEmployeeId: z.string().uuid() }).strict();
export const decisionSchema = z.object({ note: optional(z.string().trim().max(500)) }).strict();
export const rejectSchema = z.object({ note: z.string().trim().min(5, 'Say why').max(500) }).strict();

export const repossessSchema = z
  .object({
    assetId: z.string().uuid(),
    repossessedOn: isoDate,
    location: z.string().trim().min(3, 'Where is the asset kept?').max(200),
    conditionNotes: z.string().trim().min(5, 'Describe the condition (odometer, damage, keys, papers)').max(2000),
    valuation: optional(positive),
  })
  .strict();
export const releaseSchema = z.object({ reason: z.string().trim().min(10, 'Explain why the asset is released').max(1000) }).strict();

export const saleRequestSchema = z
  .object({
    assetId: z.string().uuid(),
    salePrice: positive,
    soldOn: isoDate,
    buyerName: z.string().trim().min(2).max(200),
    buyerReference: optional(z.string().trim().max(100)),
    accountId: z.string().uuid(),
    notes: optional(z.string().trim().max(1000)),
  })
  .strict();

export const writeOffRequestSchema = z.object({ reason: z.string().trim().min(20, 'Explain why the dues cannot be recovered (at least 20 characters)').max(2000) }).strict();

export const stageDefinitionSchema = z
  .object({
    code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use capitals, digits and _'),
    name: z.string().trim().min(2).max(80),
    description: optional(z.string().trim().max(300)),
    sortOrder: z.coerce.number().int().min(0).max(999),
    requiresApproval: z.boolean(),
    isTerminal: z.boolean(),
    allowedNext: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/)).max(20),
    active: z.boolean(),
  })
  .strict();

export const recoverySettingsSchema = z.object({ autoOpenDpd: z.coerce.number().int().min(0).max(365) }).strict();
