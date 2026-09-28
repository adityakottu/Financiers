# 15 — Implementation Roadmap

## 1. One change to the proposed phase order

The brief puts Accounting (Phase 5) after Collections (Phase 4). But a payment
must create its journal entry **atomically** (doc 02 §6) — if payments ship
before the ledger exists, early payments would have no journals and would need
back-posting, which is exactly the kind of reconstructed history we want to
avoid. So:

- **Ledger core** (chart of accounts, posting engine, journal tables & DB
  guards) moves into **Phase 3**, alongside disbursement.
- Phase 5 still delivers the accountant-facing features (expenses, cash/bank
  management, ledger UI, books, trial balance, P&L).

Nothing is removed; the dependency is just made explicit.

## 2. Phases

Each phase ends with: what was built · tests run & results · what changed ·
remaining work · demo on staging. No phase starts until the previous one is accepted.

### Phase 1 — Architecture ✅ (this pack)
Exit: decisions D1–D10 answered; documents approved.

### Phase 2 — Core platform
- Monorepo, CI (lint/typecheck/tests/security scans), docker-compose dev stack,
  Terraform skeleton, staging environment.
- `packages/money`, `packages/contracts`, design system (`packages/ui`):
  typography, colour tokens, data table (sticky header, column chooser,
  server pagination, export button slot), forms, status badges, dialogs,
  drawers, desktop sidebar + mobile bottom nav.
- Auth (login, argon2id, sessions, lockout, TOTP, reset, logout-all, login history).
- Users, roles, permissions, overrides, branches, employees, scope guard, RLS.
- Audit log (hash chain) + viewer; numbering service; settings (company, numbering).
- Customers (profile, KYC with encryption/masking, references, documents with
  scanning), customer timeline shell.
- Global search (trigram + blind index).
- Dashboard shell with real counts available so far.
- **Exit tests:** auth suite, permission matrix for built modules, audit coverage,
  encryption/masking, search performance on 1M synthetic customers.

### Phase 3 — Lending + ledger core
- `packages/loan-engine` (FLAT, REDUCING_EMI, SIMPLE, APR) with golden fixtures.
- Loan products (versioned), allocation rules, fee/penalty rules, GL mapping.
- Loan creation wizard (category-adaptive asset forms), schedule preview,
  approval, disbursement.
- Assets register + documents + status lifecycle.
- **Ledger core:** chart of accounts seed, posting engine, journal tables,
  balance/immutability/period triggers; postings E1, E2, E3, E15.
- Installment status roll, interest accrual, penalty assessment jobs.
- Loan statement (screen + PDF + Excel); schedule export.
- Import: customers, assets, existing loans with opening balances (validate → preview → confirm → log).
- **Exit tests:** calculation matrix (doc 12 §2), ledger integrity, import validation.

### Phase 4 — Collections
- Assignments, targets, collector mobile UI (`/m`): home totals, customer cards,
  Collect (<30 s), Call, WhatsApp, visits, PTP, day totals.
- `packages/allocation`; payment API with idempotency, locks, UTR uniqueness;
  posting E4/E5; receipts (numbering, PDF, verify page).
- Reversal workflow (E10) with two-person approval.
- Messaging: adapters (MSG91 SMS w/ DLT, Meta WhatsApp Cloud API), templates,
  outbox relay, delivery webhooks, logs, manual send from profile/loan/payment/collection pages.
- Reminder rules engine (−3/−1/0/+1/+7/+15/+30) with quiet hours.
- Customer timeline complete; collection dashboard; notification centre v1.
- Loan closure + closure letter + asset release checklist.
- **Exit tests:** payment & reversal suites, concurrency/duplicate suite, E2E J2/J4, mobile performance budget.

### Phase 5 — Accounting (accountant features)
- Cash & bank accounts UI, account summaries (opening + receipts − payments = closing).
- Expenses with categories, attachments, approval chain (Employee → Manager → Accountant); E9.
- Deposits (E6); cheque lifecycle (E8).
- Manual journals with approval; ledger viewer with filters; day book, cash book,
  bank book, trial balance, P&L, balance sheet; periods & locks.
- **Exit tests:** randomised ledger simulation, period lock tests, report tie-outs.

### Phase 6 — Reconciliation
- Employee settlement (submit/verify/approve), cash reconciliation, differences
  with reasons & resolutions (E11).
- Bank/UPI statement import (parsers + generic mapper), matching passes, unmatched inbox, E7.
- Day closing workflow + reopen approvals; reconciliation board 🟢🟠🔴 with drill-down.
- **Exit tests:** reconciliation suite (doc 09 §10, doc 12 §5), E2E J3.

### Phase 7 — Reporting & exports
- All reports in doc 10 (loan, collection, accounting, reconciliation) with
  global filters (remembered per user), Excel (company header, report name,
  filters, date range, generated timestamp, frozen header, number formats) and
  PDF (print-ready, page numbers, totals).
- Async export jobs for large reports; accountant templates for external CAs.
- Dashboards completed (company, branch, collector, employee performance).
- Recovery module (DPD buckets, cases, configurable stages, repossession/sale postings E13/E14).
- **Exit tests:** report totals tie to ledger; export format tests; performance.

### Phase 8 — Security & hardening
- Full permission-matrix, auth, CSRF, XSS, SQLi, IDOR, upload, rate-limit, audit tests.
- ZAP full scan; third-party penetration test ⚖; fix findings.
- Load test at 5× expected volume; DR drill; backup restore verification.
- Runbooks: incident, DR, day-close support, user onboarding.
- Go-live checklist incl. professional sign-offs (⚖ items).

### Pilot & rollout (after Phase 8)
One branch in parallel run with existing process for 2–4 weeks; daily comparison
of collections and cash; then branch-by-branch rollout.

## 3. Open questions for you (in addition to D1–D10)

1. How many branches, collectors, active loans today? (sizing, migration effort)
2. Current records — Excel? another software? (import mapping)
3. Which banks do you use? (statement parsers)
4. Do collectors collect UPI to a company VPA/QR or personal? (should be company only)
5. Is GST registration in place, and are fees charged with GST?
6. Preferred languages for SMS/WhatsApp/receipts (English, Telugu, Hindi)?
7. Collection-day calendar: do daily loans skip Sundays/holidays?
8. Approval thresholds: loan amount, waiver limit, difference limit needing Management.
