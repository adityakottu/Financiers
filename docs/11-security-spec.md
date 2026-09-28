# 11 — Security Specification

The system holds KYC data, financial records and cash-handling evidence. Treat
every component as a target. Security controls are **acceptance criteria** for
each phase, not a Phase 8 afterthought; Phase 8 verifies them.

## 1. Threat model (summary)

| Threat | Example | Primary controls |
|---|---|---|
| Insider fraud — collector | Records ₹500, collects ₹1,000; pockets cash; fake UPI screenshot | Receipts auto-sent to customer by SMS/WhatsApp; UPI only reconciled on bank match; daily cash settlement; no payment edit/delete |
| Insider fraud — staff | Reverses a payment and keeps the cash; edits loan terms | Two-person approval on reversals; terms immutable after disbursal; hash-chained audit; reversal report to Management |
| Account takeover | Phished manager password | argon2id, lockout, TOTP mandatory for privileged roles, new-device alerts, session revocation |
| Data leak | KYC export, bulk customer scrape | masking, scoped queries, export audit, rate limits, no PII in logs, encrypted columns |
| Web attacks | XSS, CSRF, SQLi, IDOR | CSP, React escaping, SameSite+CSRF token, parameterised queries only, scope guard + RLS |
| File attacks | Malicious PDF/image upload | type sniffing, size limits, AV scan, re-encode images, private bucket, no inline HTML |
| Replay/duplicates | Double submit, network retry | idempotency keys, unique references, row locks |
| Provider abuse | Webhook spoofing, SMS pumping | signed webhooks, allow-listed templates only, per-customer message caps |
| Infra compromise | Stolen DB snapshot | encryption at rest (KMS), app-level encryption for KYC, least-privilege IAM, separate backup account |

## 2. Authentication

- Identifiers: username, email or mobile (all unique).
- **Passwords:** argon2id (m=64 MiB, t=3, p=1; tuned to ~250 ms), min 10 chars,
  zxcvbn score ≥ 3, check against a local breached-password list (k-anonymity
  HIBP range file), no forced periodic rotation (NIST 800-63B) but forced change
  on reset/first login.
- **MFA:** TOTP (RFC 6238) with 10 single-use recovery codes (hashed). Mandatory for
  Super Admin, Management, Accountant; optional for others (setting can make
  mandatory). Architecture allows WebAuthn/passkeys later.
- **Lockout:** 5 failures → 15-min lock, doubling to 24 h; generic error messages
  ("Invalid credentials"); constant-time comparison; timing-equalised unknown-user path.
- **Sessions:** 256-bit random ID in `__Host-sid` cookie (HttpOnly, Secure,
  SameSite=Strict, Path=/). Stored hashed server-side. Idle timeout 30 min
  (collectors: 8 h idle on their mobile flow, configurable), absolute 12 h.
  Rotated on login and privilege change. Logout-all revokes every row.
- **Step-up:** recent auth (≤ 5 min) required for role changes, reversal approval,
  period unlock, provider credential changes, KYC reveal.
- **Password reset:** single-use token (hashed, 30 min), sent to registered
  email/mobile; all sessions revoked on reset.
- **Login monitoring:** every attempt in `login_events`; alerts for impossible
  travel/new device for privileged roles; admin view of active sessions.

## 3. Authorization

See doc 05. Deny by default; every route declares a permission (CI lint); scope
filtering in repositories; PostgreSQL RLS as backstop; 404 for out-of-scope rows.

## 4. Data protection & privacy

### 4.1 Classification

| Class | Examples | Handling |
|---|---|---|
| **Restricted** | PAN, DL, voter ID numbers, bank account numbers, KYC images, provider API keys, TOTP secrets | App-level AES-256-GCM (envelope keys from AWS KMS), masked in UI, reveal permission + audit, never in logs |
| **Aadhaar** | Aadhaar number | **Not stored.** Only last 4 digits + masked image (first 8 digits redacted) ⚖. Optional Aadhaar Data Vault token if licensed |
| **Confidential** | Name, mobile, address, loan details, payments | DB encryption at rest; scoped access; masked mobile for roles without `customer.view_contact` |
| **Internal** | Settings, templates | Normal controls |

### 4.2 Encryption
- In transit: TLS 1.2+ (1.3 preferred) everywhere incl. DB (`sslmode=verify-full`) and Redis.
- At rest: RDS/S3/EBS encrypted with KMS CMKs; backups encrypted.
- Application-level: `_enc` columns — per-record data key wrapped by KMS key;
  `key_version` stored to support rotation.
- Searchable restricted fields: HMAC-SHA256 blind index with a separate KMS-held
  key (exact-match only; no partial search on restricted fields).

### 4.3 Masking rules
PAN `ABCDE1234F` → `XXXXX1234X`; Aadhaar `XXXX XXXX 1234`; mobile `98XXXXX210`;
bank a/c `XXXXXX4321`.

### 4.4 DPDP Act readiness ⚖
Consent capture (version, timestamp, channel) per customer; purpose-limited
use; data principal requests (access/correction) handled via admin workflow;
retention schedule (financial ≥ 8 yrs, KYC per PMLA); breach runbook with
notification steps; data processing agreements with SMS/WhatsApp/cloud providers.

## 5. Application security controls

| Control | Implementation |
|---|---|
| Input validation | Zod on every request body/query/params; strict (unknown keys rejected); length limits; Indian formats (PAN regex, IFSC, PIN, mobile) |
| SQL injection | Prisma/Kysely parameterisation only; raw SQL via tagged templates; lint bans string-concatenated SQL |
| XSS | React auto-escaping; no `dangerouslySetInnerHTML` (lint); CSP `default-src 'self'; script-src 'self' 'nonce-…'; object-src 'none'; frame-ancestors 'none'`; templates for SMS/PDF escape variables |
| CSRF | SameSite=Strict + double-submit token + Origin/Referer check |
| Security headers | HSTS (preload), X-Content-Type-Options, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy (camera only on upload pages), COOP/CORP |
| CORS | Same-origin only; no wildcard |
| Rate limiting | Redis sliding window (doc 10 §4); WAF managed rules at edge |
| File uploads | allow-list (PDF, JPEG, PNG, HEIC); magic-byte sniffing; ≤ 10 MB; images re-encoded (strips EXIF/scripts); PDFs scanned with ClamAV in isolated worker; stored with random keys in private bucket; served via 5-min presigned URL with `Content-Disposition: attachment` for non-images |
| Secrets | AWS Secrets Manager / SSM; env vars injected at runtime; never in Git (gitleaks pre-commit + CI); provider credentials write-only in UI |
| Dependencies | Lockfile, Renovate, `pnpm audit` + OSV scan in CI, SBOM |
| Logging | Structured JSON; request-id; PII redaction middleware; no bodies of auth/KYC routes |
| Errors | No stack traces to clients; generic 500 with requestId |
| Webhooks | HMAC signature verification + timestamp tolerance + replay cache |
| Public receipt page | random 128-bit token; shows receipt no, masked name, amount, date, status; noindex; rate-limited |

## 6. Audit logging

- Captured by interceptor for every mutating request + explicit calls for
  sensitive reads (KYC reveal, exports, statement downloads, document views).
- Fields: user, roles, branch, timestamp, IP, user agent, session, action,
  entity, old/new values (restricted fields masked), reason, request id.
- Append-only table; DB role cannot UPDATE/DELETE; hash chain verified nightly;
  daily chain head exported to a write-once S3 bucket (Object Lock, compliance mode).
- Audit viewer with filters; only Super Admin/Management see all.

## 7. Infrastructure security

- Private subnets for app, DB, Redis; only ALB public. No public DB endpoint.
- IAM least privilege; separate AWS accounts for prod / non-prod / backups.
- Bastion-less admin access via SSM Session Manager, logged.
- Production data never copied to non-prod; non-prod uses synthetic data.
- DB roles: `fin_migrator` (DDL, CI only), `fin_app` (DML limited per doc 03 §10),
  `fin_readonly` (reports/BI), `fin_audit` (audit read).
- GuardDuty, CloudTrail, Config enabled; alerts to on-call.

## 8. Security testing (Phase 8, and continuously)

Automated: SAST (Semgrep), dependency & secret scanning, DAST (OWASP ZAP baseline
in CI against staging), permission matrix tests (doc 12). Manual: pre-go-live
third-party penetration test (recommended CERT-In empanelled auditor ⚖).
Incident response runbook incl. CERT-In 6-hour reporting obligation for
reportable incidents ⚖.
