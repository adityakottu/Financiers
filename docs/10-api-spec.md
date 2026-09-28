# 10 — API Specification

REST/JSON over HTTPS. Base path `/api/v1`. An OpenAPI 3.1 document is generated
from the Zod contracts in `packages/contracts` and published at `/api/v1/openapi.json`
(non-production only).

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `sid` cookie (HttpOnly, Secure, SameSite=Strict, `__Host-` prefix). No tokens in localStorage |
| CSRF | `X-CSRF-Token` header on POST/PUT/PATCH/DELETE (double-submit) + Origin check |
| Idempotency | `Idempotency-Key: <uuid>` **required** on every money-moving POST (payments, reversals, disbursements, deposits, expenses post, journals). Same key + same body → original response replayed (`Idempotent-Replayed: true`). Same key + different body → `409 IDEMPOTENCY_MISMATCH` |
| Optimistic lock | Mutable master data returns `ETag: "v{version}"`; updates require `If-Match` → `412` on conflict |
| Money | JSON **strings** with 2 dp: `"1250.00"`. Never JSON numbers |
| Dates | `YYYY-MM-DD` for business/value dates; RFC 3339 with offset for instants |
| Pagination | cursor: `?limit=50&cursor=…` → `{ data, nextCursor }`; max limit 200 |
| Filtering | `?branchId=&employeeId=&from=&to=&status=&method=&category=&dpdMin=&dpdMax=` |
| Sorting | `?sort=-dueDate,loanNo` (allow-listed fields only) |
| Errors | `{ "error": { "code": "DAY_CLOSED", "message": "…", "details": {…}, "requestId": "…" } }` |
| Status codes | 400 validation, 401 unauthenticated, 403 missing permission, 404 not found or out of scope, 409 conflict/state, 412 precondition, 422 business rule, 429 rate limit |
| Scope leakage | A row outside the caller's scope returns **404** (not 403), so existence isn't disclosed |
| PII | Masked by default; `?reveal=pan` only with `kyc.reveal`, audited |

## 2. Endpoints

Permission shown in brackets. All list endpoints are scope-filtered.

### Auth & sessions
```
POST   /auth/login                 {identifier, password} → 200 | 202 {mfaRequired}
POST   /auth/mfa/verify            {code}
POST   /auth/logout
POST   /auth/logout-all
POST   /auth/password/forgot       {identifier}        (always 202)
POST   /auth/password/reset        {token, newPassword}
POST   /auth/password/change       {current, new}
POST   /auth/mfa/setup | /auth/mfa/enable | /auth/mfa/disable   (step-up)
GET    /auth/me                    → user, roles, permissions, branches
GET    /auth/sessions              → own devices
DELETE /auth/sessions/:id
GET    /auth/csrf
```

### Admin
```
GET/POST        /users                     [user.manage]
GET/PATCH       /users/:id                 [user.manage]
POST            /users/:id/roles           [permission.assign] (step-up)
POST            /users/:id/disable | /unlock | /force-logout
GET/POST        /roles, /permissions       [role.manage]
GET/POST/PATCH  /branches                  [branch.manage]
GET/POST/PATCH  /employees                 [user.manage | branch mgr for own branch]
GET/PUT         /settings/company | /settings/numbering | /settings/general
GET/POST/PATCH  /providers                 [settings.sms|settings.whatsapp] (credentials write-only)
GET/POST/PATCH  /templates                 [template.manage]
GET/POST/PATCH  /reminder-rules            [reminder_rule.manage]
GET             /audit-logs                [audit.view]
GET             /audit-logs/verify         [audit.view] → hash-chain status
```

### Customers & search
```
GET    /search?q=…&type=any|customer|loan|vehicle       [search.global]
GET    /customers                    [customer.view]
POST   /customers                    [customer.create]
GET    /customers/:id                [customer.view]
PATCH  /customers/:id                [customer.edit]  (If-Match)
GET    /customers/:id/timeline       [customer.view]
GET    /customers/:id/loans
POST   /customers/:id/kyc            [customer.edit]
GET    /customers/:id/kyc/:docId/reveal   [kyc.reveal] (audited)
POST   /customers/:id/documents      multipart → file scan → attach
GET    /files/:id/url                → short-lived presigned URL (scope-checked, audited for KYC)
POST   /customers/:id/consents       {whatsappOptIn, dpdpConsentVersion}
```

### Products & loans
```
GET/POST/PATCH /loan-products        [product.manage]
GET/POST       /allocation-rules     [product.manage]
POST   /loans/calculate              → preview (doc 06 §11)            [loan.create]
POST   /loans                        {customerId, productId, asset, terms, previewHash} → DRAFT [loan.create]
GET    /loans                        [loan.view]
GET    /loans/:id                    [loan.view]
POST   /loans/:id/submit             → PENDING_APPROVAL
POST   /loans/:id/approve            [loan.approve]
POST   /loans/:id/reject
POST   /loans/:id/disburse           {accountId, date, feeCollection} Idempotency-Key [loan.disburse]
GET    /loans/:id/schedule           [loan.view]
GET    /loans/:id/statement?from&to&format=json|pdf|xlsx   [statement.generate]
GET    /loans/:id/foreclosure-quote?date=
POST   /loans/:id/foreclose          Idempotency-Key
POST   /loans/:id/reschedule-requests   → approval flow
POST   /loans/:id/waivers            → approval flow
POST   /loans/:id/close              → closure record, letter, asset release checklist
POST   /loans/:id/write-off          → approval flow
GET/PATCH /assets/:id  ;  POST /assets/:id/status   [asset.status_change]
```

### Collections
```
GET    /collections/today?employeeId=         → collector home: totals + customer cards
GET    /collections/sheet?date=&employeeId=
POST   /assignments                  {loanIds[], employeeId, fromDate}   [assignment.manage]
GET/POST /targets                    [target.manage]
POST   /loans/:id/payments           Idempotency-Key                    [payment.create]
       { amount, method, referenceNo?, cheque?{no,bank,date}, receivedAt, location? }
       → 201 { payment, allocations[], receipt{no, url, verifyUrl}, loanBalances, nextDue }
GET    /payments?…                   [payment.view]
GET    /payments/:id
POST   /payments/:id/reverse         {reasonCode, reasonText} Idempotency-Key → REQUESTED   [payment.reversal.request]
POST   /reversals/:id/approve        (step-up; approver ≠ requester)     [payment.reversal.approve]
POST   /reversals/:id/reject
PATCH  /payments/:id/cheque-status   {status, date}                      [cheque.update_status]
GET    /receipts/:id  ;  GET /receipts/:id/pdf
POST   /receipts/:id/send            {channels:["WHATSAPP","SMS"]}       [message.send]
GET    /r/:verifyToken               public receipt verification page (minimal data, rate-limited)
POST   /loans/:id/visits             [visit.record]
POST   /loans/:id/promises           [visit.record]
```

### Communications
```
POST   /communications/sms           {customerId, loanId?, templateCode, vars?}  [message.send]
POST   /communications/whatsapp      {customerId, loanId?, templateCode, attachReceiptId?}
GET    /communications/logs?channel=&status=
POST   /webhooks/sms/:provider       signature-verified, no session
POST   /webhooks/whatsapp/:provider  signature-verified, no session
```

### Accounting
```
GET/POST/PATCH /accounts             [coa.manage | ledger.view]
GET    /accounts/:id/ledger?from&to&branchId&employeeId&type   [ledger.view]
GET    /journals?…  ;  GET /journals/:id
POST   /journals                     manual, → PENDING_APPROVAL  Idempotency-Key [journal.manual.create]
POST   /journals/:id/approve         [journal.manual.approve]
POST   /journals/:id/reverse
GET/POST /bank-accounts              [cash_bank.manage]
GET    /cash-bank/summary?date=      opening + receipts − payments = closing
GET/POST /expense-categories
POST   /expenses                     [expense.create]
POST   /expenses/:id/submit | /approve | /reject | /post (Idempotency-Key)
POST   /deposits                     Idempotency-Key [deposit.record]
POST   /deposits/:id/verify          [deposit.verify]
POST   /periods/:id/lock | /unlock
```

### Reconciliation
```
GET    /reconciliation/board?from&to&branchId         🟢🟠🔴 grid
GET    /reconciliation/daily?date&branchId            branch day view
POST   /reconciliation/daily                          {branchId, date} → start close (SUBMISSION)
GET    /settlements/:employeeId/:date
POST   /settlements/:id/submit       {declaredCash, depositIds[], notes}   [settlement.submit]
POST   /settlements/:id/verify       {countedCash, denominations?}        [settlement.verify]
POST   /settlements/:id/differences  {kind, amount, reasonCode, notes, resolution}
POST   /settlements/:id/approve      [settlement.approve]
POST   /reconciliation/:id/approve   (branch day)  [day.close]
POST   /business-days/:id/close      [day.close]
POST   /business-days/:id/reopen-requests → approval  [day.reopen]
POST   /bank-statements/import       multipart → preview {new, duplicate, errors}
POST   /bank-statements/imports/:id/confirm
POST   /bank-statements/:importId/auto-match
GET    /bank-statements/lines?status=UNMATCHED
POST   /reconciliation/matches       {statementLineId, targets[]}  (manual)
POST   /reconciliation/matches/:id/confirm | /undo
```

### Reports & exports
```
GET /reports/{name}?filters…&format=json|xlsx|pdf
  names: loans-active, loans-closed, loans-overdue, dues-today, dues-tomorrow, dues-week,
         outstanding-by-loan, outstanding-by-customer, loans-by-asset, loans-by-category,
         collection-daily, collection-employee, collection-branch, collection-method,
         collection-pending, collection-efficiency,
         day-book, cash-book, bank-book, general-ledger, income, expenses, receivables-ageing,
         payables, trial-balance, profit-loss, balance-sheet,
         recon-employee, recon-branch, recon-cash, recon-upi, recon-bank, recon-unmatched, recon-adjustments
Large exports (> 10k rows) → 202 {jobId}; GET /exports/:jobId → presigned download when ready.
GET /dashboard/company | /dashboard/branch/:id | /dashboard/collector/:employeeId
```

### Imports
```
POST /imports/:kind              multipart → job UPLOADED → async validate
GET  /imports/:id                → counts, errors (row-level), preview
GET  /imports/:id/errors.xlsx
POST /imports/:id/confirm        Idempotency-Key (only if 0 errors, or with explicit skipInvalid for non-financial kinds)
GET  /imports/templates/:kind.xlsx
```

### Notifications
```
GET  /notifications?unread=true
POST /notifications/:id/read
```

## 3. Example: record payment

Request
```http
POST /api/v1/loans/7f3e…/payments
Idempotency-Key: 5b8c2d0e-3a41-4f2b-9c7e-0d1f2a3b4c5d
X-CSRF-Token: …
Content-Type: application/json

{ "amount": "1250.00", "method": "CASH", "receivedAt": "2026-10-05T11:42:10+05:30" }
```
Response `201`
```json
{
  "payment": { "id": "…", "paymentNo": "PAY-2026-004512", "amount": "1250.00", "method": "CASH", "status": "POSTED" },
  "allocations": [
    { "installmentNo": 6, "component": "PENALTY",   "amount": "50.00" },
    { "installmentNo": 6, "component": "INTEREST",  "amount": "300.00" },
    { "installmentNo": 6, "component": "PRINCIPAL", "amount": "900.00" }
  ],
  "receipt": { "receiptNo": "REC-KKD-2026-004512", "pdfUrl": "/api/v1/receipts/…/pdf", "verifyUrl": "https://…/r/Qm9…" },
  "loan": { "principalOutstanding": "68400.00", "overdue": "0.00", "nextDue": { "date": "2026-10-05", "amount": "1200.00" } }
}
```
Errors: `422 DAY_CLOSED`, `422 LOAN_NOT_ACTIVE`, `422 OVERPAYMENT_NOT_ALLOWED`,
`409 DUPLICATE_REFERENCE` (UTR reused), `404` (loan not in collector's assignment).

## 4. Rate limits (defaults)

| Class | Limit |
|---|---|
| `/auth/login` | 5 / 15 min per identifier; 20 / 15 min per IP; exponential lockout |
| `/auth/password/forgot` | 3 / hour per identifier |
| Financial POST | 30 / min per user |
| Search | 60 / min per user |
| Exports | 10 / hour per user |
| Public `/r/:token` | 30 / min per IP |
