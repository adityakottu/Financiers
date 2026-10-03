import { z } from 'zod';
import { ROLE_CODES } from './permissions';
import {
  aadhaarLast4Schema,
  isoDateSchema,
  mobileSchema,
  moneySchema,
  panSchema,
  passwordSchema,
  pincodeSchema,
} from './validators';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const optional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

/* ---------------- Auth ---------------- */

export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export const mfaCodeSchema = z
  .object({ code: z.string().trim().regex(/^(\d{6}|[a-z0-9]{5}-[a-z0-9]{5})$/i, 'Enter the 6-digit code') })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();

export const forgotPasswordSchema = z.object({ identifier: z.string().trim().min(1).max(254) }).strict();

export const resetPasswordSchema = z
  .object({ token: z.string().min(20).max(200), newPassword: passwordSchema })
  .strict();

export const reauthSchema = z
  .object({ password: z.string().min(1).max(128), code: optional(z.string().trim().max(20)) })
  .strict();

/* ---------------- Admin ---------------- */

export const branchCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,8}$/, '2–8 letters/numbers'),
    name: z.string().trim().min(2).max(120),
    address: optionalText(500),
    phone: optional(mobileSchema),
  })
  .strict();
export const branchUpdateSchema = branchCreateSchema
  .omit({ code: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .strict();

export const userCreateSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,40}$/, '3–40 chars: letters, numbers, . _ -'),
    fullName: z.string().trim().min(2).max(120),
    email: optional(z.string().trim().toLowerCase().email().max(254)),
    mobile: optional(mobileSchema),
    temporaryPassword: passwordSchema,
    roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
    branchIds: z.array(z.string().uuid()).default([]),
  })
  .strict();

export const userUpdateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    email: optional(z.string().trim().toLowerCase().email().max(254)),
    mobile: optional(mobileSchema),
  })
  .strict();

export const userAccessSchema = z
  .object({
    roleCodes: z.array(z.enum(ROLE_CODES)).min(1),
    branchIds: z.array(z.string().uuid()),
  })
  .strict();

export const employeeCreateSchema = z
  .object({
    branchId: z.string().uuid(),
    employeeCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/),
    fullName: z.string().trim().min(2).max(120),
    designation: optionalText(80),
    mobile: optional(mobileSchema),
    joinedOn: optional(isoDateSchema),
    isCollector: z.boolean().default(false),
    userId: optional(z.string().uuid()),
  })
  .strict();
export const employeeUpdateSchema = employeeCreateSchema
  .omit({ employeeCode: true })
  .partial()
  .extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() })
  .strict();

export const companySettingsSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    tradeName: optionalText(200),
    address: optionalText(500),
    phone: optionalText(20),
    email: optional(z.string().trim().email()),
    gstin: optional(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN'),
    ),
    receiptFooter: optionalText(500),
  })
  .strict();

export const NUMBERING_TYPES = ['CUSTOMER', 'LOAN', 'ASSET', 'RECEIPT', 'PAYMENT', 'JOURNAL', 'EXPENSE', 'DEPOSIT'] as const;
export const numberingFormatSchema = z
  .object({
    seqType: z.enum(NUMBERING_TYPES),
    format: z
      .string()
      .trim()
      .max(60)
      .refine((f) => /\{SEQ(:\d)?\}/.test(f), 'Format must contain {SEQ} or {SEQ:n}')
      .refine((f) => /^[A-Za-z0-9{}:\-/_]+$/.test(f), 'Only letters, numbers, - / _ and tokens'),
  })
  .strict();

/* ---------------- Customers ---------------- */

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const RELATION_TYPES = ['S/O', 'D/O', 'W/O', 'C/O'] as const;

export const referenceSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    relationship: z.string().trim().min(2).max(60),
    mobile: mobileSchema,
    address: optionalText(300),
  })
  .strict();

export const kycInputSchema = z
  .object({
    pan: optional(panSchema),
    aadhaarLast4: optional(aadhaarLast4Schema),
    drivingLicence: optional(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9 -]{8,20}$/, 'Invalid driving licence number'),
    ),
    voterId: optional(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9/]{6,20}$/, 'Invalid voter ID'),
    ),
  })
  .strict();

/** Update semantics: undefined = keep, null or "" = clear. */
const clearable = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (v === '' ? null : v), s.nullable().optional());

export const customerCreateSchema = z
  .object({
    branchId: z.string().uuid(),
    fullName: z.string().trim().min(2).max(120),
    mobile: mobileSchema,
    relationType: optional(z.enum(RELATION_TYPES)),
    relationName: optional(z.string().trim().max(120)),
    dob: optional(isoDateSchema),
    gender: optional(z.enum(GENDERS)),
    altMobile: optional(mobileSchema),
    email: optional(z.string().trim().toLowerCase().email().max(254)),
    addressLine1: optional(z.string().trim().max(200)),
    addressLine2: optional(z.string().trim().max(200)),
    villageTown: optional(z.string().trim().max(100)),
    mandal: optional(z.string().trim().max(100)),
    district: optional(z.string().trim().max(100)),
    state: optional(z.string().trim().max(100)),
    pincode: optional(pincodeSchema),
    occupation: optional(z.string().trim().max(100)),
    employerBusinessName: optional(z.string().trim().max(150)),
    businessType: optional(z.string().trim().max(100)),
    monthlyIncome: optional(moneySchema),
    workAddress: optional(z.string().trim().max(300)),
    whatsappOptIn: z.boolean().default(false),
    references: z.array(referenceSchema).max(5).default([]),
    kyc: kycInputSchema.default({}),
  })
  .strict();

export const customerUpdateSchema = z
  .object({
    branchId: z.string().uuid().optional(),
    fullName: z.string().trim().min(2).max(120).optional(),
    mobile: mobileSchema.optional(),
    relationType: clearable(z.enum(RELATION_TYPES)),
    relationName: clearable(z.string().trim().max(120)),
    dob: clearable(isoDateSchema),
    gender: clearable(z.enum(GENDERS)),
    altMobile: clearable(mobileSchema),
    email: clearable(z.string().trim().toLowerCase().email().max(254)),
    addressLine1: clearable(z.string().trim().max(200)),
    addressLine2: clearable(z.string().trim().max(200)),
    villageTown: clearable(z.string().trim().max(100)),
    mandal: clearable(z.string().trim().max(100)),
    district: clearable(z.string().trim().max(100)),
    state: clearable(z.string().trim().max(100)),
    pincode: clearable(pincodeSchema),
    occupation: clearable(z.string().trim().max(100)),
    employerBusinessName: clearable(z.string().trim().max(150)),
    businessType: clearable(z.string().trim().max(100)),
    monthlyIncome: clearable(moneySchema),
    workAddress: clearable(z.string().trim().max(300)),
    whatsappOptIn: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE', 'BLACKLISTED']).optional(),
  })
  .strict();

export const KYC_DOC_TYPES = ['PAN', 'AADHAAR', 'DRIVING_LICENCE', 'VOTER_ID'] as const;

export const kycVerifySchema = z
  .object({ docType: z.enum(KYC_DOC_TYPES), method: z.string().trim().min(2).max(60) })
  .strict();

/* ---------------- Queries ---------------- */

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export const customerListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  branchId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLACKLISTED']).optional(),
  kycStatus: z.enum(['PENDING', 'PARTIAL', 'VERIFIED', 'REJECTED']).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const auditQuerySchema = paginationSchema.extend({
  userId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(80).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type BranchCreateInput = z.infer<typeof branchCreateSchema>;
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type EmployeeCreateInput = z.infer<typeof employeeCreateSchema>;
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
