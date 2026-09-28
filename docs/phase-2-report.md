# Phase 2 Report — Core Platform

Status: **complete, awaiting your review.** Decisions D1–D10 were accepted with
the recommended defaults. D1 (interest recognition) and D10 (regulatory status)
still need confirmation from your CA / legal adviser before Phase 3's
accounting postings go live.

## 1. What was built

### Security & access
| Capability | Notes |
|---|---|
| Sign-in | Username, email or mobile (+91/0 prefixes accepted). argon2id password hashing. Same error for unknown user and wrong password. |
| Password policy | ≥ 10 characters, letters + numbers, common-password list, must not contain username. Enforced on server and shown live in the UI. |
| Lockout | 5 failures → 15 min lock, doubling up to 24 h; unknown usernames lock the same way (no account discovery); 20 failures per IP in 15 min → IP throttled. |
| Sessions | Server-side sessions (token stored hashed), HttpOnly + SameSite=Strict cookies, 30 min idle (8 h for collectors), 12 h absolute. Device list, sign out one device, sign out everywhere. Sessions end immediately when a user is disabled or their access changes. |
| Two-step verification | TOTP (RFC 6238, verified against the RFC test vectors), QR enrolment, 10 single-use recovery codes, replay protection. **Mandatory** for Super Admin, Management and Accountant. Admin can reset a lost authenticator. |
| First sign-in | Forced password change, then forced 2FA enrolment for privileged roles. Nothing else works until both are done. |
| Step-up | Role changes, KYC reveal, reset links, 2FA reset and recovery codes require the password (+ code) within the last 5 minutes. |
| Password reset | Self-service request (always answers the same way) and admin-issued single-use 30-minute links. |
| CSRF / origin | Per-session CSRF token checked on every state-changing request, plus Origin allow-list (including on sign-in). |
| Headers | Nonce-based Content-Security-Policy on every page, HSTS in production, nosniff, frame-deny, referrer policy. |
| Authorization | One global guard, **deny-by-default**: a route that doesn't declare a permission is closed (and a test fails the build). Roles → permissions, per-user ALLOW/DENY overrides (DENY wins), branch scoping. You cannot change your own roles or status; the last active Super Admin cannot be removed. |
| Audit log | Every sensitive action with user, roles, IP, device, request id, old and new values. **Append-only, enforced by the database**, and **SHA-256 hash-chained**; the "Verify integrity" button detects any edit made by bypassing the application. Passwords, secrets and encrypted values are never written to it. |

### Organisation & customers
| Capability | Notes |
|---|---|
| Branches, users, employees | Create, edit, activate/deactivate; employees can be linked to sign-in accounts and marked as collectors. |
| Settings | Company details (printed later on receipts), document numbering formats with live preview. |
| Numbering | `CUST-2026-000001`, `REC-KKD-2026-000001`, etc. Indian financial year (April–March, in IST). **Unique and gapless**, including under concurrency and rolled-back requests (tested). |
| Customers | Full profile per the brief: personal, contact, address (village/town, mandal, district, state, PIN), work & income, references, WhatsApp consent, status. Optimistic locking: two people editing at once can't silently overwrite each other. |
| KYC | PAN, driving licence and voter ID **encrypted** (AES-256-GCM, bound to their column); exact-match searchable through keyed blind indexes. **Aadhaar: only the last 4 digits are ever stored.** Masked by default; full reveal needs `kyc.reveal` + step-up and is audited. Duplicate PAN across customers is blocked. Verification per document; KYC status derived automatically (2+ verified documents = Verified ⚖). |
| Documents | Upload PDF/JPEG/PNG up to 10 MB, checked by **file content** (not name), sanitised file names, downloads audited, KYC copies restricted to `document.view_kyc`. |
| Timeline | Customer history (created, updated, KYC changes, documents, consent). Later phases add loans, payments, receipts, messages and visits. |
| Search | One box: name (typo-tolerant and partial), mobile, customer ID, PAN, Aadhaar last 4, driving licence / voter ID. Branch-scoped. Keyboard shortcut `/`. |
| Idempotency | Customer creation is exactly-once: double-taps and retries with the same key create one record (tested with 10 concurrent submits and a real browser double-tap). This is the mechanism payments will use in Phase 4. |
| Dashboard | Real figures only (customers, KYC backlog, new today, branches, staff). Loan/collection/reconciliation KPIs are shown as **"Not yet available · Phase N"** — never fake zeros. |

### User interface
Desktop sidebar + top search bar; mobile header, bottom navigation and card lists.
Planned modules appear in the navigation dimmed with their phase number so the
roadmap is visible. Screens: sign-in, 2FA, forced password change, 2FA setup,
forgot/reset password, dashboard, customers (list, new, profile with
Overview/KYC/Documents/Loans/History tabs, edit), users & access, branches,
employees, settings, audit log (filters, diffs, integrity check), profile &
security (devices, sign-in history, password, recovery codes).

## 2. How it was tested

| Suite | Count | What it proves |
|---|---|---|
| `packages/money` | 8 | Exact decimal arithmetic, HALF_UP rounding (e.g. 84,938.88 × 2% = 1,698.78), Indian grouping (₹1,24,000.00) |
| `packages/contracts` | 7 | Indian formats, password rules, masking, role definitions |
| API unit | 16 | TOTP against RFC 4226/6238 vectors, encryption tamper detection and column binding, file sniffing, numbering/FY rules |
| API integration (real PostgreSQL 16) | 62 | Auth, lockout, CSRF/origin, sessions/timeouts, MFA incl. replay, step-up, permission matrix incl. "no side effects on denial", branch scoping, last-admin rule, audit chain + tamper detection + concurrency, KYC encryption at rest, idempotency under concurrency, gapless numbering, optimistic locking, search, uploads, DB failover resilience |
| Browser end-to-end (Playwright, desktop + Pixel 7) | 16 steps | Real first sign-in → password change → 2FA enrolment → dashboard → search → KYC reveal with step-up → create customer with validation and double-tap → audit integrity → mobile manager and collector views; no console errors; no horizontal overflow on mobile |

The same pipeline runs in GitHub Actions (`.github/workflows/ci.yml`) on every
push: install, build, typecheck, all tests against a PostgreSQL 16 service,
production builds, dependency audit and a secret scan.

### Defects found and fixed during testing
1. **API crashed if PostgreSQL dropped an idle connection** (as happens during
   a database restart or failover). Fixed, with a regression test.
2. **Form labels included hint/error text**, so screen readers announced
   "New password At least 10 characters…". Fields now use proper
   `label`/`aria-describedby`.
3. **Mobile pages could scroll sideways** when a wide table was present.
   Fixed; the browser test now fails on any horizontal overflow.
4. Search now also matches **partial names** ("chandrasekhar red").
5. Reference fields had the same "Mobile" label as the customer's own mobile;
   they are now "Reference 1 mobile", etc.

## 3. Deviations from the architecture pack (and why)

| Planned | Built | Reason |
|---|---|---|
| Prisma + Kysely | **Kysely only**, SQL-first migrations | Ledger guards, append-only triggers and the audit hash chain are SQL anyway; one data-access tool with generated types is simpler and gives full control of locking. |
| Redis for sessions, rate limits, queues | **PostgreSQL** sessions; in-process rate limiter; outbox table ready | Nothing in Phase 2 needs a queue. Redis arrives with messaging (Phase 4), when the rate limiter also moves there so limits hold across multiple API instances. |
| PostgreSQL row-level security as a backstop | **Not yet** — scoping is enforced in the guard and the data-access layer (and tested) | RLS needs per-transaction session variables on every query; scheduled for Phase 8 hardening together with separate database roles. |
| S3 storage + ClamAV scanning | **Local private directory**; files have a scan status and cannot be downloaded unless CLEAN. Outside production they are marked clean automatically; **in production they stay PENDING** until the scanner is added | Keeps Phase 2 self-contained without letting unscanned files through in production. |
| ESLint | Not configured yet | TypeScript strict mode and tests are the gate for now; lint rules (incl. banning raw SQL string-building) will be added with Phase 3. |

## 4. Remaining work carried forward

- **Collectors see no customers yet:** their scope is "assigned loans", which
  exist from Phase 4. This is intentional and tested.
- Password-reset **delivery by SMS/email** (requests are recorded in the outbox;
  admins can issue links today).
- Branch-manager dashboards with loan/collection figures (Phases 3–4).
- Customer document categories for assets (Phase 3).
- Excel/PDF exports of these lists (Phase 7).
- RLS, separate DB roles, S3 + malware scanning, Redis-backed rate limiting,
  ESLint (as above).
- Deploying staging on AWS Mumbai requires your AWS account; the app is ready
  to containerise.

## 5. What to review

1. Sign-in and first-login flow for each role (demo data script included).
2. Customer profile fields and required fields — anything missing for your forms?
3. KYC rule ⚖: is "2 verified documents = KYC Verified" right for you?
4. Numbering formats (Settings → Document numbering).
5. Role permissions (docs/05) — e.g. should Accountants see unmasked mobiles?

Next: **Phase 3 — Lending** (loan products, calculator, loan creation, assets,
schedules, statements, and the ledger core).
