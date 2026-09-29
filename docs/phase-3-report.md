# Phase 3 Report — Lending & Ledger Core

Status: **complete, awaiting your review.** Accounting follows decision D1
(interest recognised on the due date). **D1 and D10 still need confirmation
from your CA / legal adviser before real money is booked.** ⚖

## 1. What was built

### Loan engine (`packages/loan-engine`)
A pure calculation library with no database access. The API and the browser
use the same library, so the on-screen preview is identical to what gets saved.

| Capability | Notes |
|---|---|
| Interest methods | **Flat**, **reducing-balance EMI** (with broken-period interest when the first due date is not one period away), **simple** (interest on the original principal, spread per installment). |
| Frequencies | Daily (optionally skipping Sundays), weekly, fortnightly, monthly (anchored to the day of month, e.g. 31 Jan → 28 Feb → 31 Mar), custom every N days. |
| Rounding | Installments rounded to a configurable unit (₹1, ₹5, ₹10, …), with the **last installment absorbing the residual** so totals are exact to the paisa. |
| APR | True annualised cost via decimal XIRR, including fees (Newton's method with a bisection fallback). Shown next to the nominal rate, e.g. "24% flat → 60.81% APR". |
| Fees | Processing, documentation and other fees, as a fixed amount or a percentage (with min/max), with GST, either **deducted from disbursement** or **added to installment 1**. |
| Penal charges | Flat per overdue installment, % of overdue per day, or % p.a. on overdue, with grace days and a cap. **Never compounded**: the penalty is calculated on the overdue principal, interest and fees only. ⚖ |
| Money | Decimal arithmetic only (no floating point), HALF_UP rounding. |

### Loans
| Capability | Notes |
|---|---|
| Loan products | Category, interest method, amount/rate/tenure limits, allowed frequencies, max LTV, fees, penal rule, approval limit. **Versioned**: editing creates a new version and existing loans keep the terms they were issued under. Products can be retired and reactivated. |
| Calculator | Free-form or per product; schedule, totals and APR; printable. |
| New loan wizard | Customer → Product → Asset → Terms → Review. The review step shows the exact schedule, and the server rejects the loan if the terms changed after preview (preview hash). Creation is idempotent: a double-tap creates one loan. |
| Workflow | Draft → Awaiting approval → Approved → Active, plus Rejected / Cancelled. **Maker-checker**: the approver can never be the creator (enforced by a database CHECK constraint as well as the API). Loans above the product's approval limit need Management (`loan.approve_high`). KYC must be Verified before approval. |
| Disbursement | Mode (cash, bank transfer, NEFT/RTGS/IMPS, UPI, cheque), source account (must match the mode), and a reference (required unless cash). Posts the accounting entry and activates the asset in a single transaction. Idempotent, and safe against two people disbursing at once (tested concurrently). |
| Loan page | Timeline, outstanding / overdue / next installment / charges, then tabs: schedule, asset, fees & charges, accounting entries, statement. |
| Statements | Built **from the ledger**, not the schedule. Available on screen, as **PDF** and as **Excel**. |

### Assets
| Capability | Notes |
|---|---|
| Category-specific fields | Electronics (product, brand, serial) through 2W/3W/4W, bus and lorry (registration, chassis, engine, insurance, permit, fitness, hypothecation). Required fields depend on the category. |
| Duplicate protection | A vehicle whose registration or chassis number is already financed on a live loan **cannot be financed again**. The E2E run hit this (409 `ASSET_ALREADY_FINANCED`) when reusing a chassis number. |
| Registration numbers | Normalised and validated (standard `AP05AB1234` and Bharat series `22BH1234AA`). |
| Documents & history | Invoice/RC/insurance uploads (same content checks as KYC files), and an asset event history. Identifiers are locked once the loan leaves the pending stages. |
| Search | The global search box now also finds loan numbers, registration, chassis, engine and serial numbers. |

### Accounting core (double entry)
| Capability | Notes |
|---|---|
| Chart of accounts | Seeded Indian NBFC-style chart (1000–5900), with per-branch cash and cheques-in-hand accounts and bank accounts (account numbers encrypted, only the last 4 shown). |
| Journal | **One writer** (`LedgerService.post`). The database rejects unbalanced entries (checked at commit), postings to group accounts, postings into locked periods, and any UPDATE or DELETE of posted entries. Corrections will be reversals. |
| Entries posted in Phase 3 | **E1 Disbursement**: Dr Loan principal receivable / Cr bank or cash, Cr fee income + GST output. **E2 Interest accrual** on the due date (D1). **E3 Penal charges**. |
| Accounts screen | Account tree with rolled-up balances, a trial-balance check ("Debits = credits"), the ledger for each account, and bank account setup. |
| End-of-day job | After midnight IST: rolls installment status, accrues interest falling due, assesses penal charges and refreshes loan balances. Runs **once per business date** (advisory lock + run log) and catches up any missed days. It can also be run manually from Settings. |

### Dashboard
Loan KPIs are now real: outstanding principal, total receivable, overdue,
pipeline, disbursed today, due today, and a split by category. Collections and
reconciliation are still shown as "Phase 4 / 6", never as fake zeros.

## 2. How it was tested

| Suite | Count | What it proves |
|---|---|---|
| `packages/loan-engine` | 19 (+200 random cases) | Four golden examples checked independently in Python (flat, weekly, daily-simple, EMI with broken period); APR; rounding; month-end anchoring; Sunday skipping; fees + GST; penal rules and caps. Property test: for any valid input, principal repaid = principal, no negative rows, last row absorbs rounding. |
| `packages/money`, `packages/contracts` | 15 | As in Phase 2, plus asset/registration validation and category requirements. |
| API unit + integration (real PostgreSQL 16) | 111 | Everything in Phase 2 plus 33 lending/ledger tests: product versioning, limit checks, preview hash, maker-checker (API and DB), approval limit, KYC gate, disbursement postings, fee modes, account/mode mismatch, concurrent disbursement, duplicate assets, journal immutability, unbalanced/locked-period rejection, end-of-day accrual and penalty (idempotent, catch-up), statement PDF/Excel, branch/role scoping, and **ledger vs. loan reconciliation** (the ledger receivable equals the loan's outstanding balance). |
| Browser end-to-end (Playwright, desktop + iPhone 13) | 15 steps | Branch manager builds a 2-wheeler loan through the wizard (including validation on an empty asset form). The maker cannot approve. A new admin completes first sign-in (password change + 2FA), approves and disburses by bank transfer. The accounting tab shows the balanced entry. The statement downloads as a real PDF and Excel file. Also checked: trial balance, products, assets, loans list, settings, search by chassis, and mobile pages. No console errors and no horizontal overflow. |

**Total: 145 automated tests, all passing**, plus the browser run.

### Defects found and fixed during Phase 3
1. **APR solver**: the bisection fallback moved in the wrong direction. It was
   found while cross-checking the golden examples in Python, fixed, and is now
   covered by tests.
2. **Two simultaneous disbursements with the same idempotency key** could return
   an error to the second request instead of the first one's result. The
   idempotency service now claims the key before doing the work.
3. The nightly scheduler could fire once after the API shut down; it is now
   cancelled on shutdown.
4. Loan page showed a stray "—" next to the status for loans with no overdue days.
5. Web production build fails if `NODE_ENV` is set to `development` in the
   shell (a Next.js limitation). The build and CI run without it; noted in the
   README.

## 3. Deviations from the architecture pack

| Planned | Built | Reason |
|---|---|---|
| Server PDF with the ₹ symbol | PDF statements print **"Rs."** | The built-in PDF fonts have no ₹ glyph. Embedding a font (e.g. Noto Sans) fixes this; planned with receipts in Phase 4. Screen and Excel use ₹. |
| Loan import from CSV/Excel | Not built yet | It needs the same validation and "never silently import bad data" rules as payment imports. It will be built with them in Phase 5. |
| Fee collected upfront in cash (UPFRONT mode) | Deducted or added-to-installment only | Upfront collection needs a receipt, so it moves to Phase 4. |
| ESLint | Still not configured | Carried to Phase 8 hardening. TypeScript strict mode and tests remain the gate. |

## 4. Remaining work carried forward

- **Collector assignment** of loans, plus collections, receipts and the payment
  allocation engine (Phase 4). The statement already has a place for payments.
- Repossession / seizure workflow (Phase 7).
- RLS and separate DB roles, S3 + malware scanning, Redis rate limiting (Phase 8).
- Links in a few places wrap a button element (valid in browsers but not
  strictly valid HTML); tidy-up with the accessibility pass.
- ⚖ Confirm with your CA: interest recognised on the due date (D1), GST on
  processing and documentation fees at 18%, and income recognition on NPAs.
  ⚖ Confirm with legal: penal-charge wording and caps, and the RBI
  fair-practices disclosures (key fact statement, APR display).

## 5. What to review

1. Run `pnpm --filter @fin/api db:seed:demo` (see README) and open a few demo
   loans in different states.
2. Try the calculator with your real product terms. Do the installments match
   what your staff calculate today?
3. Products: the limits, fees and penal rules you actually use.
4. The disbursement accounting entry and the chart of accounts, with your accountant.

Next: **Phase 4 — Collections** (collector assignment, the mobile collection
screen, payment allocation, receipts, SMS/WhatsApp through official APIs, and
employee cash settlement).
