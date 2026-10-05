# Phase 8 Report — Security & hardening

Status: **complete, awaiting your review.** Items marked ⚖ need your CA's or legal advisor's confirmation.

## 1. What was built

| Area | What it does |
|---|---|
| **Least-privilege database roles** (`db:roles`) | The API now connects as **`fin_app`**. It can read, insert and update, but it **cannot delete, truncate or change the schema**. It **cannot update** the journal, audit log, allocations, recovery actions, asset/customer events, sign-in history, statement imports or integrity runs. It may delete only housekeeping rows (used 2FA recovery codes, rate counters, role links, idempotency keys). `fin_readonly` is for reports, BI and restore checks; `fin_audit` can read only the audit trail and sign-in history. These are the database's own rules, on top of the append-only triggers, so they hold even if a trigger were dropped. **The whole test suite now runs as `fin_app`.** |
| **Shared rate limits** | The request counters are kept in PostgreSQL, so limits hold across several API servers instead of per server (doc 13 runs two or more). The default is 300 requests per minute per IP (`RATE_LIMIT_PER_MINUTE`). Sign-in, 2FA and public receipt checks keep their tighter limits. |
| **Malware scanning** | Every upload (KYC, photos, documents) is scanned by **ClamAV** before it is stored. Infected files are refused and never written. If the scanner is down, files are stored as *pending* and re-scanned automatically. **Production refuses to start without `CLAMAV_ADDRESS`.** |
| **Maintenance mode** | *System health → Maintenance* (step-up required), or `MAINTENANCE_MODE=true`. Reads keep working; every change is refused with a clear message, and a banner appears for everyone. It is used during restores and risky upgrades. |
| **Integrity checks** | **Nightly, after the end-of-day job, and on demand** (*System health → Run now*, or `pnpm --filter @fin/api db:verify` on any copy of the database). They prove that: every journal entry balances; the trial balance balances; **each loan's balances equal the ledger** (1310–1340 and 2200, per loan); the receivable control accounts equal the loan book; every payment is journaled, fully allocated and receipted; every reversal has its mirror entry; no cash account is negative; and **the audit-log hash chain is unbroken**. Results are kept, cannot be deleted, and a failure appears in *Waiting for you*. |
| **Backup → restore → verify** (`scripts/restore-drill.sh`) | Takes a backup, restores it into a scratch database, runs the integrity checks on the copy, compares row counts table by table, then drops the copy. It ends with "RESTORE VERIFIED ✓" or an error. Phase 10 schedules it weekly against the production backups (doc 14 §5). |
| **Code-level security gate** (`pnpm lint`, in CI) | The build fails on raw SQL string building (`sql.raw`, interpolated `query()`), `dangerouslySetInnerHTML`, `eval`, and `console` logging in the API (which could leak personal data). |
| **Search at volume** | Load testing at 10 lakh customers found global name search far too slow (p95 5.4 s). A trigram GiST index now returns the nearest names straight from the index: **p95 216 ms**. |
| **System health page** (`/admin/system`) | Maintenance switch, integrity-run history with each check's result, and a *Run now* button. |
| **Runbooks** (`docs/runbooks/`) | Incident response, including **CERT-In 6-hour reporting** ⚖ and DPDP breach steps; disaster recovery (RPO 5 min / RTO 4 h); day-close support for branches; user onboarding and offboarding. |
| **Go-live checklist** ([go-live-checklist.md](go-live-checklist.md)) | Every sign-off needed before a branch goes live: professional ⚖, security, operations, data migration, people and pilot exit. |

## 2. How it was tested

### Security test suite (`src/security/*.int.test.ts`, doc 12 §7)
- **Route × role matrix.** Every API route is read from the application itself, so a new route is covered automatically. For each of the 7 roles, every route the role lacks permission for returns **403 with no side effects** (no audit rows), every route it has is not refused by the guard, and every route without a session returns **401**. Public routes are listed explicitly.
- **IDOR.** A Rajahmundry manager and an unassigned collector cannot read Kakinada customers, loans, schedules, statements, payments or receipts, or pay into those loans, even with the exact IDs.
- **SQL injection.** Classic payloads (`' OR '1'='1`, `; DROP TABLE`, `UNION SELECT password_hash`, `pg_sleep`) in ten search and filter parameters never cause an error, never leak a password hash, never delay the response, and the tables are intact afterwards.
- **XSS and headers.** Script tags in names and addresses are stored as text and returned as JSON with `nosniff` and a `default-src 'none'` content security policy. Download file names cannot carry injected characters.
- **Mass assignment.** Extra fields (e.g. `kycStatus`, `id`) in request bodies are refused (strict schemas). There is no route to edit or delete a payment.
- **Money abuse.** Negative, zero, 3-decimal, exponent (`1e5`), `NaN` and absurdly large amounts are refused.
- **Audit completeness.** Each sensitive action writes exactly one audit entry; a failed sign-in writes one sign-in event.
- **Database roles.** As `fin_app`: `DELETE`, `TRUNCATE`, `UPDATE` on append-only tables and DDL are all refused, and lending, collection, reversal, reports and recovery still work.
- **Controls.** The rate limit is shared by two API instances. Maintenance mode blocks writes and lets reads and sign-in through. An infected file is refused by a (test) clamd and never written; a scanner outage leads to *pending* and then a clean re-scan. HTML disguised as a `.jpg`, empty and oversized files are refused. Spreadsheet text such as `=HYPERLINK(...)` stays text in exports.
- **Integrity.** Tampering inside a rolled-back transaction — an unbalanced journal line, a loan balance changed directly, an edited audit row, cash pushed below zero — makes the matching check fail and name the record.

### Load test at volume (`perf:seed` + `perf:load`)
Volume: **10,00,036 customers and 5,018 loans**, created through the real services so the ledger is real, plus 952 payments. Measured on the development container (4 vCPU, single PostgreSQL) with 20 concurrent clients for 15 s per scenario:

| Scenario | Requests | Errors | p50 ms | p95 ms | p99 ms | Target (doc 01 §6) |
|---|---:|---:|---:|---:|---:|---|
| Global search (names) | 3,394 | 0 | 70 | **216** | 260 | p95 < 300 ✓ |
| Global search (mobile) | 11,546 | 0 | 25 | **35** | 40 | p95 < 300 ✓ |
| Loan list (active, page of 50) | 6,795 | 0 | 43 | 55 | 65 | |
| Loan detail | 5,738 | 0 | 52 | 63 | 69 | |
| Payment, one branch, 5 at once | 982 | 0 | 62 | **170** | 275 | p95 < 500 ✓ |
| Payment, one branch, 20 at once (stress) | 897 | 0 | 278 | 682 | 1001 | — |
| Branch dashboard | 1,318 | 0 | 56 | 75 | 91 | |
| Report: outstanding by loan (JSON) | 556 | 0 | 80 | 113 | 123 | |
| Report: active loans (Excel) | 41 | 0 | 481 | 566 | 670 | |

All integrity checks then passed on the volume database (34,667 entries, 5,011 loans × 5 accounts, 4,088 payments, 24,282 audit records).

Payments in one branch are processed one after another: they share the gapless receipt and journal numbering and the audit chain. This is deliberate, because receipt numbers must have no gaps. At 20 simultaneous counter payments in **one** branch the p95 is 0.68 s and throughput is about 58 payments a second. That is far above a real branch's peak, and different branches do not wait for each other. **Re-run the load test on the staging hardware before go-live (checklist C5).**

### Totals
| Suite | Count |
|---|---|
| Money, contracts, loan engine | 46 |
| API integration (real PostgreSQL, as `fin_app`) | **208** (18 new security, control, role and integrity tests) |

**Total: 254 automated tests, all passing.** `pnpm lint` (security rules) is clean, and the web app builds.

### Defects found and fixed during Phase 8
1. **Reconciliation day for a branch that doesn't exist returned a server error (500)**; now 404. Found by the route matrix.
2. **Global name search took 5.4 s at 10 lakh customers.** Fixed with a GiST trigram index and nearest-first ordering; now 216 ms. Found by the load test.
3. A report test read whichever export record came first; with more tests exporting it could pick the wrong one. It now reads the newest.
4. The integrity-run recorder updated its own row, which `fin_app` may not do; it now writes the finished result once. Found by running the suite as `fin_app`.

## 3. Deviations and deferrals

| Planned | Status | Why |
|---|---|---|
| Third-party penetration test ⚖ | **Not done — needs a CERT-In empanelled auditor** on the staging environment (Phase 10) | The automated suite covers the OWASP checks we can run ourselves; an independent test is still required before go-live (checklist B1). |
| OWASP ZAP scan | Added to CI in Phase 10, against staging | Needs a deployed environment. |
| Field-level encryption key rotation | The key is versioned; a rotation tool is not built | Not needed in year one; procedure noted in the DR runbook. |
| WAF rules | Defined in Terraform (Phase 10) | Infrastructure. |

## 4. ⚖ For your CA / legal advisor
- CERT-In: who reports incidents within 6 hours, and the contacts in [runbooks/incident-response.md](runbooks/incident-response.md).
- DPDP: the breach-notification wording, and who notifies the Data Protection Board and affected customers.
- Retention (financial ≥ 8 years; KYC per PMLA): backups and archives follow it, so confirm the periods.

## 5. How to try it
- `pnpm demo`, sign in as the admin → **System health**: run the integrity checks and switch maintenance mode on and off (2FA step-up).
- `bash scripts/restore-drill.sh` (needs `pg_dump` / `pg_restore`) prints RESTORE VERIFIED.
- Load test: `PERF_CUSTOMERS=1000000 pnpm --filter @fin/api perf:seed` on a **copy** of the demo database, start the API, then run `pnpm --filter @fin/api perf:load` (see the header of `src/perf/load-test.ts`).

Next: **Phase 9 — Data migration & pilot readiness**.
