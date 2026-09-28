# 04 — ER Diagram

Rendered by GitHub (Mermaid). Split into four views for readability; column
details are in [03-database-schema.md](03-database-schema.md).

## 4.1 Identity, org & audit

```mermaid
erDiagram
  COMPANIES ||--o{ BRANCHES : has
  BRANCHES ||--o{ EMPLOYEES : employs
  USERS ||--o| EMPLOYEES : "is (optional)"
  USERS ||--o{ USER_ROLES : has
  ROLES ||--o{ USER_ROLES : grants
  ROLES ||--o{ ROLE_PERMISSIONS : includes
  PERMISSIONS ||--o{ ROLE_PERMISSIONS : in
  USERS ||--o{ USER_PERMISSION_OVERRIDES : has
  USERS ||--o{ USER_BRANCHES : "scoped to"
  BRANCHES ||--o{ USER_BRANCHES : scopes
  USERS ||--o{ SESSIONS : opens
  USERS ||--o{ LOGIN_EVENTS : generates
  USERS ||--o{ AUDIT_LOGS : "acts in"
  EMPLOYEES ||--|| ACCOUNTS : "cash-in-hand account"
```

## 4.2 Lending

```mermaid
erDiagram
  BRANCHES ||--o{ CUSTOMERS : "home branch"
  CUSTOMERS ||--o{ CUSTOMER_KYC_DOCUMENTS : has
  CUSTOMERS ||--o{ CUSTOMER_REFERENCES : has
  CUSTOMERS ||--o{ CUSTOMER_DOCUMENTS : has
  CUSTOMERS ||--o{ CUSTOMER_EVENTS : timeline
  CUSTOMERS ||--o{ LOANS : borrows
  LOAN_PRODUCTS ||--o{ LOANS : "configures"
  ALLOCATION_RULES ||--o{ LOAN_PRODUCTS : "used by"
  REMINDER_RULE_SETS ||--o{ LOAN_PRODUCTS : "used by"
  LOANS ||--|{ ASSETS : "secured by"
  ASSETS ||--o{ ASSET_DOCUMENTS : has
  ASSETS ||--o{ ASSET_EVENTS : "status history"
  LOANS ||--o{ LOAN_CHARGES : has
  LOANS ||--|{ LOAN_SCHEDULE_VERSIONS : has
  LOAN_SCHEDULE_VERSIONS ||--|{ LOAN_INSTALLMENTS : contains
  LOANS ||--o| LOAN_CLOSURES : "closed by"
  LOANS ||--o{ RECOVERY_CASES : has
  RECOVERY_CASES ||--o{ RECOVERY_ACTIONS : logs
  CUSTOMER_DOCUMENTS }o--|| FILES : stores
  ASSET_DOCUMENTS }o--|| FILES : stores
```

## 4.3 Collections & payments

```mermaid
erDiagram
  EMPLOYEES ||--o{ COLLECTION_ASSIGNMENTS : "assigned"
  LOANS ||--o{ COLLECTION_ASSIGNMENTS : "assigned to"
  EMPLOYEES ||--o{ COLLECTION_TARGETS : has
  EMPLOYEES ||--o{ COLLECTION_VISITS : makes
  LOANS ||--o{ COLLECTION_VISITS : "visited for"
  LOANS ||--o{ PROMISES_TO_PAY : has
  LOANS ||--o{ PAYMENTS : receives
  EMPLOYEES ||--o{ PAYMENTS : collects
  PAYMENTS ||--|{ PAYMENT_ALLOCATIONS : "split into"
  LOAN_INSTALLMENTS ||--o{ PAYMENT_ALLOCATIONS : "paid by"
  PAYMENTS ||--|| RECEIPTS : produces
  PAYMENTS ||--o| PAYMENT_REVERSALS : "may be reversed"
  PAYMENTS ||--|| JOURNAL_ENTRIES : "posted as"
  PAYMENT_REVERSALS ||--o| JOURNAL_ENTRIES : "posted as"
  PAYMENTS }o--o| EMPLOYEE_SETTLEMENTS : "settled in"
  CUSTOMERS ||--o{ SMS_LOGS : receives
  CUSTOMERS ||--o{ WHATSAPP_LOGS : receives
  MESSAGE_TEMPLATES ||--o{ SMS_LOGS : renders
  MESSAGE_TEMPLATES ||--o{ WHATSAPP_LOGS : renders
  PROVIDER_CONFIGS ||--o{ SMS_LOGS : "sent via"
  PROVIDER_CONFIGS ||--o{ WHATSAPP_LOGS : "sent via"
```

## 4.4 Accounting & reconciliation

```mermaid
erDiagram
  ACCOUNTS ||--o{ ACCOUNTS : "parent of"
  ACCOUNTS ||--o| BANK_ACCOUNTS : "details"
  JOURNAL_ENTRIES ||--|{ JOURNAL_LINES : "has ≥2 balanced"
  ACCOUNTS ||--o{ JOURNAL_LINES : "posted to"
  JOURNAL_ENTRIES ||--o| JOURNAL_ENTRIES : "reverses"
  EXPENSE_CATEGORIES ||--o{ EXPENSES : classifies
  EXPENSES ||--o{ EXPENSE_APPROVALS : "approved via"
  EXPENSES ||--o| JOURNAL_ENTRIES : "posted as"
  CASH_DEPOSITS ||--|| JOURNAL_ENTRIES : "posted as"
  BRANCHES ||--o{ BUSINESS_DAYS : "closes"
  EMPLOYEES ||--o{ EMPLOYEE_SETTLEMENTS : "submits daily"
  EMPLOYEE_SETTLEMENTS ||--o{ SETTLEMENT_DIFFERENCES : has
  SETTLEMENT_DIFFERENCES ||--o| JOURNAL_ENTRIES : "adjusted by"
  EMPLOYEES ||--o{ CASH_DEPOSITS : makes
  BANK_ACCOUNTS ||--o{ BANK_STATEMENT_IMPORTS : "imported for"
  BANK_STATEMENT_IMPORTS ||--|{ BANK_STATEMENT_LINES : contains
  BANK_STATEMENT_LINES ||--o{ RECONCILIATION_MATCHES : "matched by"
  RECONCILIATION_MATCHES }o--o| PAYMENTS : "matches"
  RECONCILIATION_MATCHES }o--o| CASH_DEPOSITS : "matches"
  RECONCILIATIONS ||--|{ RECONCILIATION_ITEMS : contains
  ACCOUNTING_PERIODS ||--o{ JOURNAL_ENTRIES : "locks"
```

## 4.5 The traceability chain

One ₹1,250 cash payment, followed end to end:

```mermaid
flowchart LR
  C[Customer CUST-2026-000123] --> L[Loan LN-KKD-2026-000045]
  L --> I[Installment #7 due 05/10/2026]
  E[Employee E017 Ravi] --> P[Payment PAY-2026-004512<br/>₹1,250 CASH]
  I --> A[Allocations<br/>Penalty 50 · Interest 300 · Principal 900]
  P --> A
  P --> R[Receipt REC-KKD-2026-004512]
  P --> J[Journal JE-2026-019877<br/>Dr Cash-in-Hand E017 1,250<br/>Cr Penal Income 50<br/>Cr Interest Receivable 300<br/>Cr Loan Receivable 900]
  J --> S[Settlement E017 · 05/10/2026]
  S --> D[Deposit DEP-2026-000881<br/>Dr Bank · Cr Cash-in-Hand E017]
  D --> B[Bank statement line matched]
  S --> DC[Day close KKD 05/10/2026 ✅]
```
