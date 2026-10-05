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
  /** clamd address for malware scanning, host:port (doc 11 §5). Required in production. */
  CLAMAV_ADDRESS: z.string().regex(/^[\w.-]+:\d+$/).optional(),
  /** Forces maintenance mode on (refuse all changes) regardless of the in-app switch. */
  // Requests per client IP per minute (default limiter; auth routes are tighter). Raise only for load tests.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(300),
  MAINTENANCE_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Public URL of the web app, printed on receipts (QR code for verification). */
  PUBLIC_WEB_URL: z.string().url().optional(),
  /** SMS: 'msg91' (DLT-registered templates) or 'log' (nothing is sent; messages are marked SIMULATED). */
  SMS_PROVIDER: z.enum(['log', 'msg91']).default('log'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().regex(/^[A-Z]{6}$/).optional(),
  /** Shared secret MSG91 must send (?token=) on delivery-report webhooks. */
  MSG91_WEBHOOK_TOKEN: z.string().min(24).optional(),
  /** WhatsApp: 'meta' (official WhatsApp Business Cloud API) or 'log'. Unofficial automation is never supported. */
  WHATSAPP_PROVIDER: z.enum(['log', 'meta']).default('log'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** Meta app secret: verifies X-Hub-Signature-256 on webhooks. */
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).optional(),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  /** Background workers (message relay, nightly job). Off in tests, which drive them directly. */
  WORKERS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
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
  if (production && !c.CLAMAV_ADDRESS) throw new Error('CLAMAV_ADDRESS (clamd host:port) is required in production: uploads must be virus-scanned');
  const cookieSecure = c.COOKIE_SECURE ?? production;
  if (c.SMS_PROVIDER === 'msg91' && !(c.MSG91_AUTH_KEY && c.MSG91_SENDER_ID)) {
    throw new Error('SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_SENDER_ID');
  }
  if (c.WHATSAPP_PROVIDER === 'meta' && !(c.WHATSAPP_PHONE_NUMBER_ID && c.WHATSAPP_ACCESS_TOKEN && c.WHATSAPP_APP_SECRET)) {
    throw new Error('WHATSAPP_PROVIDER=meta needs WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_APP_SECRET');
  }
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
    maintenanceMode: c.MAINTENANCE_MODE,
    rateLimitPerMinute: c.RATE_LIMIT_PER_MINUTE,
    clamav: c.CLAMAV_ADDRESS ? { host: c.CLAMAV_ADDRESS.split(':')[0]!, port: Number(c.CLAMAV_ADDRESS.split(':')[1]) } : null,
    publicWebUrl: (c.PUBLIC_WEB_URL ?? c.APP_ORIGIN.split(',')[0]!.trim()).replace(/\/$/, ''),
    workers: c.WORKERS ?? c.NODE_ENV !== 'test',
    sms: { provider: c.SMS_PROVIDER, authKey: c.MSG91_AUTH_KEY ?? null, senderId: c.MSG91_SENDER_ID ?? null, webhookToken: c.MSG91_WEBHOOK_TOKEN ?? null },
    whatsapp: {
      provider: c.WHATSAPP_PROVIDER,
      phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID ?? null,
      accessToken: c.WHATSAPP_ACCESS_TOKEN ?? null,
      appSecret: c.WHATSAPP_APP_SECRET ?? null,
      verifyToken: c.WHATSAPP_VERIFY_TOKEN ?? null,
      apiVersion: c.WHATSAPP_API_VERSION,
    },
  };
}

export const CONFIG = Symbol('CONFIG');
