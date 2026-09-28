import { z } from 'zod';

/** Indian mobile: 10 digits starting 6–9. Accepts +91/0 prefixes and spaces; normalises to 10 digits. */
export const mobileSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a valid 10-digit Indian mobile number');

export const panSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((s) => /^[A-Z]{5}\d{4}[A-Z]$/.test(s), 'PAN must look like ABCDE1234F');

export const aadhaarLast4Schema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, 'Enter only the last 4 digits of Aadhaar');

export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'PIN code must be 6 digits');

export const ifscSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC');

/** Money on the wire is always a string with at most 2 decimals. */
export const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'Enter an amount like 1250 or 1250.50');

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Invalid date');

const COMMON_PASSWORDS = new Set([
  'password1234',
  'password@123',
  'welcome@123',
  'admin@12345',
  'qwerty123456',
  '1234567890',
  'india@12345',
  'financiers1',
]);

export const PASSWORD_RULES =
  'At least 10 characters, with letters and numbers, not a common password and not containing your username.';

export function passwordProblems(password: string, username?: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Password must be at least 10 characters');
  if (password.length > 128) problems.push('Password must be at most 128 characters');
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password))
    problems.push('Password must contain letters and numbers');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('Password is too common');
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase()))
    problems.push('Password must not contain your username');
  return problems;
}

export const passwordSchema = z
  .string()
  .superRefine((pw, ctx) => {
    for (const message of passwordProblems(pw)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

/** Masking helpers — used by the API before data leaves the server. */
export const mask = {
  mobile: (m: string | null | undefined) =>
    m && m.length >= 10 ? `${m.slice(0, 2)}XXXXX${m.slice(-3)}` : m ?? null,
  pan: (last4: string | null | undefined) => (last4 ? `XXXXXX${last4}` : null),
  aadhaar: (last4: string | null | undefined) => (last4 ? `XXXX XXXX ${last4}` : null),
  generic: (last4: string | null | undefined) => (last4 ? `XXXX${last4}` : null),
};
