import { z } from 'zod';

const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  /** Browser origin(s) allowed to make state-changing requests, comma separated. */
  APP_ORIGIN: z.string().default('http://localhost:3000'),
  /** AES-256-GCM key for restricted columns (KYC numbers, TOTP secrets). */
  DATA_ENCRYPTION_KEY: base64Key,
  /** HMAC key for blind indexes (exact-match search on encrypted values). Must differ from the data key. */
  BLIND_INDEX_KEY: base64Key,
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Require TOTP for roles flagged mfa_required. Only switch off for local development. */
  ENFORCE_MFA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  SESSION_IDLE_MINUTES_COLLECTOR: z.coerce.number().int().min(5).default(480),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(12),
  FILE_STORAGE_DIR: z.string().default('./storage'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const c = parsed.data;
  if (c.DATA_ENCRYPTION_KEY === c.BLIND_INDEX_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY and BLIND_INDEX_KEY must be different keys');
  }
  const production = c.NODE_ENV === 'production';
  if (production && !c.ENFORCE_MFA) throw new Error('ENFORCE_MFA cannot be disabled in production');
  const cookieSecure = c.COOKIE_SECURE ?? production;
  return {
    env: c.NODE_ENV,
    production,
    port: c.PORT,
    databaseUrl: c.DATABASE_URL,
    allowedOrigins: c.APP_ORIGIN.split(',').map((s) => s.trim()),
    dataKey: Buffer.from(c.DATA_ENCRYPTION_KEY, 'base64'),
    blindIndexKey: Buffer.from(c.BLIND_INDEX_KEY, 'base64'),
    cookieSecure,
    // The __Host- prefix makes browsers refuse the cookie unless Secure, host-only and Path=/.
    sessionCookie: cookieSecure ? '__Host-fin_sid' : 'fin_sid',
    csrfCookie: cookieSecure ? '__Host-fin_csrf' : 'fin_csrf',
    enforceMfa: c.ENFORCE_MFA,
    sessionIdleMs: c.SESSION_IDLE_MINUTES * 60_000,
    sessionIdleCollectorMs: c.SESSION_IDLE_MINUTES_COLLECTOR * 60_000,
    sessionAbsoluteMs: c.SESSION_ABSOLUTE_HOURS * 3_600_000,
    fileStorageDir: c.FILE_STORAGE_DIR,
    trustProxy: c.TRUST_PROXY,
  };
}

export const CONFIG = Symbol('CONFIG');
