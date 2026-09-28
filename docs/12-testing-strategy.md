# 12 — Testing Strategy

Financial correctness is tested first and hardest. A phase is not "done" until
its tests pass in CI against a real PostgreSQL (Testcontainers), not mocks.

## 1. Test layers

| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit (pure) | Vitest | `money`, `loan-engine`, `allocation`, posting rules, validators | 100% branch coverage on engine packages |
| Property-based | fast-check | invariants of calc/allocation/ledger | 10k runs per property in CI |
| Golden fixtures | Vitest snapshots (JSON) | reference schedules signed off by the business/CA | any diff fails CI |
| Integration | Vitest + Supertest + Testcontainers PG + Redis | API → DB, transactions, triggers, RLS, permissions | all green |
| Concurrency | integration + parallel clients | row locks, idempotency, numbering | all green |
| E2E | Playwright (desktop + Pixel 5 viewport) | critical journeys J1–J5 | all green on staging |
| Security | Semgrep, ZAP, custom auth tests | OWASP Top 10, permission matrix | no high/critical |
| Performance | k6 | payment p95, search p95, export | meets NFRs (doc 01 §6) |
| Restore drill | scripted | backup → restore → integrity checks | weekly |

## 2. Loan calculation tests

Matrix over principal ₹1,00,000 (plus edge amounts ₹1, ₹999.99, ₹5,00,00,000):

| Dimension | Values |
|---|---|
| Method | FLAT, REDUCING_EMI, SIMPLE |
| Rate % p.a. | 0, 12, 18, 24, 36 |
| Frequency | DAILY, WEEKLY, FORTNIGHTLY, MONTHLY, CUSTOM(10) |
| Tenure (installments) | 1, 12, 52, 100, 365 |
| Rounding unit | 0.01, 1, 10 |
| First-due edge | 31 Jan monthly, 29 Feb leap, first period > 1 frequency |

Assertions for every combination: Σprincipal = P; Σinterest = total interest;
closing balance 0; no negative components; installment count = N; due dates
strictly increasing; APR ≥ 0 and IRR reproduces cashflows within ₹0.01;
engine is deterministic (run twice → identical).

Golden fixtures (hand-verified, doc 06): Examples A (flat monthly), B (flat
weekly), C (flat daily), D (reducing monthly), plus a SIMPLE daily case.

## 3. Payment & allocation tests

| Case | Expectation |
|---|---|
| Full installment payment | installment PAID; journal E4 balanced; receipt issued; loan balances updated; employee total +amount |
| Partial payment | PARTIALLY_PAID; order Penalty → Fee → Interest → Principal respected |
| Overpayment | excess → Customer Advance (2200); applied on next due date |
| Overpayment with `REJECT` rule | 422, no rows written |
| Late payment | penalty assessed after grace; allocated first |
| Payment within grace | no penalty |
| Backdated payment | penalties assessed after value date reversed |
| Multiple installments | oldest first; each status correct |
| Component-wise mode | all penalties before any interest |
| Final payment | loan → CLOSED; closure record; closure SMS/WA enqueued |
| UPI duplicate UTR | 409, nothing written |
| Atomicity | inject failure at each step (allocation, receipt number, journal, outbox) → **zero rows** in all tables, sequence not consumed |

## 4. Reversal tests

| Case | Expectation |
|---|---|
| Payment reversal | mirror journal; installments reopened; receipt CANCELLED; loan reactivated if closed |
| Accounting reversal | Σ(original + reversal) = 0 for every account |
| Receipt reversal | receipt number retained, never reused; PDF watermarked |
| Reversal after day close | original day untouched; reversal dated today; today's settlement reflects it |
| Self-approval | 403 |
| Double reversal | 409 |
| Reversal of advance already applied | cascade reverses application first |

## 5. Reconciliation tests

Exact match; shortage; excess; pending deposit carry-forward; UPI not in
statement; statement credit without payment; duplicate statement import;
settlement cannot close with unexplained difference; day close blocks later
postings with that value date; reopen requires two approvers; Employee A worked
example (doc 09 §2) as golden test.

## 6. Ledger integrity tests

- Unbalanced entry insert → rejected by DB trigger (tested with raw SQL, bypassing app).
- UPDATE/DELETE on `journal_lines`, `audit_logs`, `payment_allocations` as `fin_app` → permission denied.
- Posting into locked period → rejected.
- Trial balance balances after randomised 10k-event simulation (disbursals,
  payments, reversals, deposits, expenses, differences) — plus control-account
  = Σ sub-ledger for loans, employees and advances.

## 7. Concurrency & duplicate protection

- 20 parallel identical requests with same Idempotency-Key → 1 payment, 19 replays.
- Same key, different body → 409.
- Two collectors paying same loan simultaneously → serialised; allocations correct; no over-allocation.
- 1,000 parallel receipt-number allocations → no gaps, no duplicates.
- Double-click in E2E (Playwright rapid clicks) → one payment.
- Simulated network drop after server commit, client retry → replayed response, not new payment.

## 8. Security tests

Permission matrix (doc 05) generated as a table-driven test: for every
role × permission × scope, assert allowed or `403/404` **and no side effects and
no success audit entry**. Explicitly:

- Collector tries to modify payment, change loan principal/interest, view
  unassigned customer, access admin settings, export.
- Accountant tries to change loan interest or user permissions.
- Manager approves own reversal; any user changes own roles.
- Anyone attempts payment DELETE (route doesn't exist → 404/405) or raw DB delete as `fin_app` (denied).

Plus: auth (lockout, timing, session fixation, logout-all, idle/absolute
timeout, MFA bypass attempts), CSRF (missing/wrong token, cross-origin),
XSS payloads in every text field rendered in UI/PDF/SMS preview, SQLi payloads in
search/filter/sort params, IDOR by UUID swapping, file upload (polyglot,
oversized, wrong extension, EICAR test file), rate limits, audit log (every
sensitive action produces exactly one entry; chain verification detects tampering).

## 9. Test data

Synthetic generator (`pnpm seed:demo`) creates branches, ~200 customers with
Indian names/addresses (fake), loans across all categories and methods, 90 days
of payment history, deposits, differences — used for E2E, demos and performance.
No production data in any non-production environment.

## 10. Definition of done (every phase)

1. Tests for the phase written and green in CI.
2. No regression in earlier phases' suites.
3. Lint, typecheck, Semgrep, dependency & secret scans clean.
4. Migrations reversible or with documented forward-fix.
5. Change summary + remaining work documented in the phase report.
