# 01 — Product Requirements Document

## 1. Problem

The business lends against electronics and vehicles across several branches.
Today loans, collections, cash with field staff, bank/UPI receipts and books are
tracked in separate places. The result: no single view of what a customer owes,
no reliable answer to "how much cash should employee X be holding tonight", and
month-end books that are reconstructed rather than recorded.

## 2. Goal

One web application where:

1. A loan, once created, produces a schedule, and every rupee collected against
   it is allocated, receipted, posted to the ledger and reconciled the same day.
2. A collection employee can record a payment on a phone in **under 30 seconds**.
3. An accountant can produce a cash book, bank book, trial balance and P&L
   **without re-keying anything**.
4. Management can see, every evening, which employees and branches are
   🟢 reconciled, 🟠 pending or 🔴 in difference — and drill down to the rupee.
5. No financial record is ever deleted; every correction is a reversal with an
   approver and an audit trail.

## 3. Personas

| Persona | Device | Primary jobs |
|---|---|---|
| **Collection Employee** | Android phone, patchy 4G | See today's dues, collect, receipt, send WhatsApp/SMS, log visits & promises, submit day's collection |
| **Branch Manager** | Laptop + phone | Onboard customers, create loans, assign customers, verify & approve day close, approve adjustments |
| **Accountant** | Desktop | Expenses, cash/bank accounts, bank statement import & matching, ledger, reports, exports |
| **Management / Main Head** | Laptop + phone | Cross-branch dashboards, approvals, exception review, performance |
| **Super Admin** | Desktop | Users, branches, products, templates, providers, settings, audit |

## 4. Scope

### 4.1 V1 (Phases 2–7) — in scope

| Area | Capabilities |
|---|---|
| Access | Login (username/email/mobile), argon2id passwords, sessions, lockout, TOTP 2FA (optional per user, mandatory for Admin/Management/Accountant), login history, logout-all |
| Org | Branches, users, roles, employee profiles, branch scoping |
| Customers | Full profile, KYC (masked/encrypted), references, documents, timeline |
| Search | Global search across customer/loan/vehicle identifiers, trigram-indexed, paginated |
| Products | Configurable loan products: interest method, rate bounds, tenure, frequency, fees, penalty, grace, allocation order, reminder rules, GL mapping |
| Loans | Guided creation wizard, asset capture by category, schedule preview, approval, disbursement, statement, closure, closure letter |
| Calculator | Flat, reducing balance (EMI), simple interest; pluggable engine; APR computation for disclosure |
| Schedules | Daily/weekly/fortnightly/monthly/custom; installment status lifecycle |
| Collections | Assignments, today's list, collect payment (cash/UPI/bank/cheque/other), visits, promises-to-pay, notes |
| Allocation | Configurable waterfall, persisted allocations, overpayment to customer advance |
| Receipts | Gapless numbering, PDF + public verification page (tokenised link) |
| Messaging | SMS (DLT-compliant) and WhatsApp Business (official API) via adapters; templates; logs; automated reminder rules |
| Accounting | Chart of accounts, double-entry journals, automatic posting rules, expenses with approval, cash & bank accounts, ledger, trial balance, P&L, balance sheet |
| Reconciliation | Employee settlement, cash reconciliation, UPI/bank statement import & matching, cheque tracking, daily closing, adjustment approvals, period locks |
| Reversal | Payment reversal with approval; mirrored journal; receipt marked cancelled |
| Reports | Loan, collection, accounting, reconciliation reports; Excel (ExcelJS) and PDF exports with headers/filters/timestamp |
| Import | CSV/Excel import for customers, loans (with opening balances), installments, employees, assets — validate → preview → confirm → log |
| Notifications | In-app notification centre for dues, differences, failed messages, approvals, pending deposits/cheques |
| Audit | Append-only, hash-chained audit log for every sensitive action and sensitive read |
| Assets | Asset register, status lifecycle, documents, release checklist |
| Recovery | Overdue buckets (DPD), recovery notes, field visits, PTPs, configurable recovery workflow states (no hard-coded legal steps) |
| Targets | Daily/weekly/monthly employee targets (management metric only) |

### 4.2 Architected for, not built in V1

- Offline-first collection with sync (V1: fast load, retry, idempotency; no offline posting).
- Route planning & geo-tagging (V1: optional lat/long on visits, never mandatory).
- Bank APIs / payment gateway / UPI collect & auto-reconciliation webhooks.
- OpenSearch for search at >5M rows.
- Customer self-service portal.
- Ind AS 109 EIR amortisation of fees ⚖ (schema allows it; posting rule not enabled by default).
- Repossession sale accounting beyond basic posting templates.

### 4.3 Explicit non-goals

- Unofficial WhatsApp automation (web scraping, unofficial libraries). Official API only.
- Storing full Aadhaar numbers. Only last 4 digits + optional reference/vault token.
- Automated legal recovery actions. Recovery steps are configurable workflow states
  that humans move through; the system never assumes a step is legally permitted.
- Credit bureau integration in V1 (schema leaves room).

## 5. Key user journeys

### J1 — Create a loan (Branch Manager, desktop, ~5 min)
Select/create customer → choose category → asset details (form adapts to
category) → loan terms (defaults from product, bounded by product limits) →
**preview schedule + totals + APR** → submit → (approval if above threshold) →
disburse (choose cash/bank account) → system posts journal, generates loan
number, sends "loan disbursed" SMS/WhatsApp.

### J2 — Collect a payment (Collection Employee, phone, <30 s)
Home shows today's dues → tap customer card → **Collect** → amount pre-filled
with due (editable) → method chips (Cash / UPI / Bank / Cheque) → reference if
non-cash → **Confirm** (one tap, idempotent) → receipt screen with
**Send WhatsApp / SMS / Share PDF**. Allocation, receipt, journal, balances,
employee totals all happen in one DB transaction.

### J3 — End of day (Employee → Accountant → Manager)
Employee taps **Submit day**: sees expected cash-in-hand, enters counted cash
and deposit slips → Accountant verifies deposits and matches UPI/bank lines
from imported statement → differences need a reason → Manager approves → day
closes for that employee/branch; transactions for that date become immutable.

### J4 — Reverse a wrong payment
Manager/Accountant opens payment → **Request reversal** with reason → second
approver (different user) approves → system posts mirror journal, reopens
installment balances, cancels receipt (number retained, marked CANCELLED),
notifies customer if configured, writes audit record.

### J5 — Month end (Accountant)
Check all days closed → review suspense & clearing accounts are zero or explained
→ run trial balance → export P&L / balance sheet / ledgers to Excel for the
external CA → lock month.

## 6. Non-functional requirements

| Attribute | Target |
|---|---|
| Collection screen load (4G, mid-range Android) | < 2 s to interactive; JS bundle for collector app < 200 KB gz |
| Payment API p95 | < 500 ms |
| Global search p95 | < 300 ms at 1M customers |
| Availability | 99.5% business hours (07:00–22:00 IST) V1 |
| RPO / RTO | ≤ 5 min / ≤ 4 h (see doc 14) |
| Data residency | All primary and backup data in India ⚖ |
| Money | `NUMERIC`, never float; deterministic rounding |
| Audit | 100% of financial writes and sensitive reads logged |
| Retention | Financial records ≥ 8 years; KYC per PMLA (≥ 5 years after relationship ends) ⚖ |
| Localisation | ₹ with Indian grouping (1,00,000.00), DD/MM/YYYY, IST, English UI V1 with i18n-ready strings (Telugu/Hindi later) |
| Accessibility | WCAG 2.1 AA for core flows |

## 7. Compliance considerations ⚖ REVIEW

The system is designed to *support* the following; applicability depends on the
company's regulatory status (D10) and must be confirmed professionally.

- **RBI (if NBFC / regulated entity):** Fair Practices Code, Key Facts Statement
  with APR for retail loans, penal charges guidance (no capitalisation of penal
  charges), recovery agent conduct, grievance redressal, digital lending
  directions if any part is digital.
- **State Money Lenders Acts** (e.g. Andhra Pradesh / Telangana) if not an NBFC —
  interest caps and licence display.
- **DPDP Act 2023:** consent, purpose limitation, data principal rights,
  breach notification — consent capture is modelled per customer.
- **Aadhaar Act / UIDAI rules:** do not store full Aadhaar unless licensed; mask.
- **PMLA / KYC Master Direction:** KYC records and retention.
- **TRAI TCCCPR (DLT):** SMS headers and templates must be DLT-registered.
- **WhatsApp Business Policy:** opt-in, approved templates, 24-hour window.
- **GST:** processing/documentation fees are typically taxable services; interest
  is typically exempt — fee posting supports a GST output split.
- **Companies Act / Income Tax:** books and retention; audit trail
  ("edit log") requirement for accounting software (Rule 3(1), Companies
  (Accounts) Rules) — met by immutable journals + audit log.

## 8. Success metrics

- ≥ 95% of employee-days reconciled on the same day by week 4 of rollout.
- Zero unexplained ledger vs. sub-ledger differences at month end.
- Median payment recording time < 30 s.
- Trial balance available without manual adjustment on day 1 of each month.
