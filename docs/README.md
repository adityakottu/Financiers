# Financiers — Phase 1 Architecture Pack

Secure Lending, Collections, Accounting & Reconciliation Management System for an
asset-backed lending business in India (electronics, 2W, 3W, 4W, buses, lorries/trucks).

> **Status: Approved** with the recommended defaults for D1–D10 (D1 and D10 still need
> CA/legal confirmation). Phases 2–6 are complete — see the [Phase 2](phase-2-report.md), [Phase 3](phase-3-report.md), [Phase 4](phase-4-report.md), [Phase 5](phase-5-report.md) and [Phase 6](phase-6-report.md) reports.

## The spine of the system

Every rupee must be traceable along one chain:

```
Customer → Loan → Asset → Schedule → Installment
        → Employee Collection → Payment → Allocation → Receipt
        → Employee Cash-in-Hand / UPI Clearing / Bank
        → Employee Settlement (deposit) → Daily Reconciliation → Day Close
        → General Ledger → Reports
```

Three layers, one database, one ledger:

| Layer | Owns | Writes to ledger? |
|---|---|---|
| **Lending** | customers, KYC, assets, loans, schedules | Yes — disbursement, fees, accruals |
| **Collections** | assignments, visits, PTPs, payments, receipts | Yes — every payment & reversal |
| **Accounting** | chart of accounts, journals, cash/bank, expenses, reconciliation, day close | Owns the ledger |

The ledger is never "calculated from totals". Every balance shown anywhere
(loan outstanding, employee cash-in-hand, bank balance, P&L) is either derived
from journal lines or verified against them.

## Documents

| # | Document | Purpose |
|---|---|---|
| 01 | [Product Requirements](01-product-requirements.md) | Scope, personas, V1 vs later, non-goals |
| 02 | [System Architecture](02-system-architecture.md) | Stack, modules, runtime, key patterns |
| 03 | [Database Schema](03-database-schema.md) | Tables, columns, constraints, indexes |
| 04 | [ER Diagram](04-er-diagram.md) | Entity relationships (Mermaid) |
| 05 | [Roles & Permissions](05-roles-permissions.md) | RBAC + branch scoping matrix |
| 06 | [Loan Calculation Spec](06-loan-calculation-spec.md) | Interest methods, schedules, rounding, APR |
| 07 | [Accounting Spec](07-accounting-spec.md) | Chart of accounts, posting rules, period locks |
| 08 | [Payment Allocation Spec](08-payment-allocation-spec.md) | Waterfall engine, overpayment, reversal |
| 09 | [Reconciliation Spec](09-reconciliation-spec.md) | Employee/cash/UPI/bank reconciliation, day close |
| 10 | [API Spec](10-api-spec.md) | REST endpoints, conventions, idempotency |
| 11 | [Security Spec](11-security-spec.md) | Auth, encryption, PII, threat model |
| 12 | [Testing Strategy](12-testing-strategy.md) | Financial test matrix, security tests |
| 13 | [Deployment Architecture](13-deployment-architecture.md) | Infra, environments, CI/CD |
| 14 | [Backup & DR](14-backup-dr.md) | RPO/RTO, backups, restore drills |
| 15 | [Implementation Roadmap](15-implementation-roadmap.md) | Phases 2–8, deliverables, exit criteria |
| — | [Phase 2 report](phase-2-report.md) | What was built, tested, and carried forward |
| — | [Phase 3 report](phase-3-report.md) | Lending, assets, ledger core, end-of-day job |
| — | [Phase 4 report](phase-4-report.md) | Collections, payments, receipts, reversals, messaging |
| — | [Phase 5 report](phase-5-report.md) | Expenses, deposits, cheques, manual journals, books, month locks |
| — | [Phase 6 report](phase-6-report.md) | Cash settlement, differences, statement import & matching, day close |

Items marked **⚖ REVIEW** require sign-off from a qualified Indian legal,
accounting (CA) or compliance professional before go-live. The system is built to
make those rules *configurable*, not to decide them.

## Decisions required before Phase 2

These change code, schema or accounting output. Recommended defaults are in bold.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Interest income recognition | Cash basis (recognise when collected) / Accrual on due date | **Accrual on due date** (Dr Interest Receivable / Cr Interest Income on each due date), switchable per company. Your CA must confirm; if you are an RBI-registered NBFC, Ind AS / IRACP norms apply ⚖ |
| D2 | Allocation mode default | Installment-wise (oldest installment first, all components) / Component-wise (all penalties first, then fees…) | **Installment-wise, oldest first; within an installment: Penalty → Fees → Interest → Principal** — configurable per product |
| D3 | Installment rounding | Paise / nearest ₹1 / nearest ₹10 | **Nearest ₹1, difference absorbed by last installment** |
| D4 | Overpayment handling | Hold as customer advance / auto-apply to future installments / auto-prepay principal | **Hold as Customer Advance (liability)**; apply to next due on due date automatically; prepayment only by explicit action |
| D5 | Employee cash model | One shared branch cash account / per-employee "Cash-in-Hand" sub-ledger | **Per-employee Cash-in-Hand sub-ledger** — makes employee reconciliation fall straight out of the ledger |
| D6 | Deployment region | AWS Mumbai (ap-south-1) / other Indian cloud | **AWS ap-south-1** with DR copy in ap-south-2 (Hyderabad) — keeps all data in India ⚖ |
| D7 | Backend shape | Next.js API routes / separate NestJS API | **Separate NestJS API** in a TypeScript monorepo (see Architecture §2) |
| D8 | SMS / WhatsApp providers | MSG91, Gupshup, Kaleyra, Twilio; WhatsApp via Meta Cloud API or a BSP | **Provider-agnostic adapters; start with MSG91 (SMS, DLT) + Meta WhatsApp Cloud API** — you need DLT entity/template registration and a verified WhatsApp Business account |
| D9 | Penalty model | Penal interest (% p.a. on overdue) / flat penal charge per installment / none | **Flat or % penal *charge* per overdue installment, not capitalised, grace period configurable** — aligns with RBI's 2023 penal-charges guidance if it applies to you ⚖ |
| D10 | Regulatory status | RBI-registered NBFC / state money-lender licence / other | Needed to finalise KFS/APR disclosure, recovery rules and GST on fees ⚖ |
