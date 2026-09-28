# 03 — Database Schema

PostgreSQL 16. Conventions:

- Primary keys: `uuid` (UUIDv7 — time-ordered, index-friendly, not guessable in sequence).
  Human-facing identifiers (`CUST-2026-000001`, `LN-…`, `REC-…`) are separate unique columns.
- Money: `NUMERIC(18,2)`; rates `NUMERIC(9,6)` (percent p.a.); quantities `NUMERIC(18,4)` where needed.
  Currency column `CHAR(3) DEFAULT 'INR'` on every money-bearing header row.
- Every table: `created_at timestamptz`, `created_by uuid`; mutable master data also
  `updated_at`, `updated_by`, `version int` (optimistic locking).
- Dates: `business_date date` (IST business day) is distinct from `created_at` (instant).
  `value_date` = date the money is accounted for.
- **Soft state, not deletes.** Financial tables have no `deleted_at`; they have
  `status` with controlled transitions. Master data (customers, users) uses
  `is_active` / `archived_at`.
- Encrypted columns are `bytea` suffixed `_enc`; searchable ones get a keyed
  HMAC blind index `*_bidx` (see doc 11).
- Extensions: `pgcrypto`, `pg_trgm`, `btree_gist`, `citext`.

---

## 1. Platform

### companies
`id, legal_name, trade_name, logo_file_id, address, phone, email, gstin, pan_enc,
cin, receipt_footer, timezone ('Asia/Kolkata'), date_format, currency ('INR'),
fy_start_month (4), settings jsonb`

### branches
`id, company_id FK, code UNIQUE (e.g. 'KKD'), name, address, phone, is_active,
default_cash_account_id FK accounts`

### users
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| username | citext UNIQUE | |
| email | citext UNIQUE NULL | |
| mobile | varchar(15) UNIQUE NULL | E.164 |
| password_hash | text | argon2id |
| password_changed_at | timestamptz | |
| totp_secret_enc | bytea NULL | |
| mfa_enabled | bool | |
| failed_login_count | int | |
| locked_until | timestamptz NULL | |
| status | enum `ACTIVE, DISABLED, LOCKED` | |
| must_change_password | bool | |

### roles, permissions, role_permissions, user_roles
- `roles(id, code UNIQUE, name, is_system)` — seeded: `SUPER_ADMIN, MANAGEMENT,
  BRANCH_MANAGER, COLLECTION_EMPLOYEE, ACCOUNTANT`.
- `permissions(code PK, module, description)` — e.g. `payment.create`.
- `role_permissions(role_id, permission_code)`.
- `user_roles(user_id, role_id)`.
- `user_permission_overrides(user_id, permission_code, effect ALLOW|DENY)` — explicit grants (e.g. Management allowed a setting).
- `user_branches(user_id, branch_id)` — branch scope; `ALL` via flag on role.

### sessions
`id (random 256-bit, stored as SHA-256 hash), user_id, created_at, last_seen_at,
expires_at, ip inet, user_agent, device_label, mfa_verified bool, revoked_at, revoke_reason`

### login_events
`id, user_id NULL, identifier_tried, success bool, reason, ip, user_agent, at`
Index `(identifier_tried, at)`, `(ip, at)`.

### password_reset_tokens
`id, user_id, token_hash, expires_at, used_at`

### employees
`id, user_id FK UNIQUE NULL, branch_id FK, employee_code UNIQUE, full_name,
designation, mobile, joined_on, is_collector bool, cash_in_hand_account_id FK accounts,
status`

### numbering_sequences
| column | notes |
|---|---|
| seq_type | `CUSTOMER, LOAN, RECEIPT, PAYMENT, JOURNAL, EXPENSE, REVERSAL, CLOSURE` |
| scope_key | `''` or branch code |
| fiscal_year | e.g. `2026` (FY 2026-27) |
| format | e.g. `REC-{BR}-{FY}-{SEQ:6}` |
| next_value | bigint |
PK `(seq_type, scope_key, fiscal_year)`. Allocated inside the business
transaction with `SELECT … FOR UPDATE` → gapless; a rolled-back txn releases the number.

### audit_logs (append-only, hash-chained)
`id bigserial, at timestamptz, user_id, role_codes text[], branch_id, ip inet,
user_agent, session_id, action text, entity_type, entity_id, old_values jsonb,
new_values jsonb, reason text, request_id, prev_hash bytea, hash bytea`
- `hash = SHA256(prev_hash || canonical_json(row))`.
- No UPDATE/DELETE grants; trigger raises on any attempt.
- Sensitive fields (PAN etc.) stored masked in old/new values.

### attachments / files
`id, storage_key, bucket, original_name, mime_type (sniffed), size_bytes, sha256,
scan_status PENDING|CLEAN|INFECTED|FAILED, uploaded_by, uploaded_at,
classification (KYC|ASSET|AGREEMENT|RECEIPT|EXPENSE|OTHER)`

### system_settings
`key PK, value jsonb, updated_by, updated_at` — every change audited.

### notifications
`id, user_id NULL, role_code NULL, branch_id NULL, type, severity, title, body,
entity_type, entity_id, created_at, read_at, resolved_at`

### outbox
`id bigserial, topic, payload jsonb, created_at, available_at, attempts,
processed_at, last_error` — written in business txns; relayed by worker.

### idempotency_keys
`user_id, key uuid, request_hash bytea, status IN_PROGRESS|DONE, response_status int,
response_body jsonb, created_at, expires_at` — PK `(user_id, key)`. Retained 7 days.

---

## 2. Customers & KYC

### customers
| column | notes |
|---|---|
| id, customer_no UNIQUE | `CUST-2026-000001` |
| branch_id FK | home branch |
| full_name, relation_type (`S/O, D/O, W/O, C/O`), relation_name | |
| dob, gender | |
| mobile, alt_mobile, email | mobile indexed; not encrypted (operational necessity), masked in UI for roles without `customer.view_contact` |
| address_line1/2, village_town, mandal, district, state, pincode | |
| occupation, employer_business_name, business_type, monthly_income NUMERIC(18,2), work_address | |
| kyc_status | `PENDING, PARTIAL, VERIFIED, REJECTED` |
| risk_category | `LOW, MEDIUM, HIGH` ⚖ (KYC Master Direction) |
| whatsapp_opt_in bool, whatsapp_opt_in_at, sms_opt_out bool | consent |
| dpdp_consent_at, dpdp_consent_version | ⚖ |
| status | `ACTIVE, INACTIVE, BLACKLISTED` |
| search_vector tsvector (generated) | |

Indexes: `gin (full_name gin_trgm_ops)`, `btree (mobile)`, `btree (customer_no)`,
`btree (branch_id, status)`, `gin (search_vector)`.

### customer_kyc_documents
| column | notes |
|---|---|
| id, customer_id FK | |
| doc_type | `AADHAAR, PAN, DRIVING_LICENCE, VOTER_ID, PASSPORT, OTHER` |
| number_enc bytea | AES-256-GCM; **Aadhaar: NULL — never stored in full** |
| number_last4 varchar(4) | for display/search |
| number_bidx bytea | HMAC-SHA256 of normalised number (PAN/DL/Voter) for exact search |
| aadhaar_ref_token | optional vault reference token if an Aadhaar Data Vault is adopted ⚖ |
| verified_by, verified_at, verification_method | |
| file_ids uuid[] | redacted images for Aadhaar (first 8 digits masked) ⚖ |

Unique partial index on `(doc_type, number_bidx)` for PAN to catch duplicate customers.

### customer_references
`id, customer_id, name, relationship, mobile, address, sort_order`

### customer_documents
`id, customer_id, file_id, category (ADDRESS_PROOF, PHOTO, AGREEMENT, OTHER), notes`

### customer_events (timeline)
`id, customer_id, loan_id NULL, at, event_type, summary, ref_type, ref_id, actor_id`
Populated by domain events: loan created, installment due, SMS/WA sent/delivered,
payment, receipt, visit, PTP, reversal, closure. Index `(customer_id, at DESC)`.

---

## 3. Products, loans, assets

### loan_products
| column | notes |
|---|---|
| id, code UNIQUE, name, category | category: `ELECTRONICS, TWO_WHEELER, THREE_WHEELER, FOUR_WHEELER, BUS, LORRY_TRUCK, OTHER` |
| interest_method | `FLAT, REDUCING_EMI, SIMPLE`, extensible via `calc_engine_key` |
| rate_min, rate_default, rate_max NUMERIC(9,6) | % p.a. |
| tenure_min, tenure_max (in periods), allowed_frequencies text[] | |
| rounding_rule jsonb | `{ "installment": "NEAREST_1", "adjust": "LAST" }` |
| fee_rules jsonb | list of `{code, basis: FLAT|PCT_OF_PRINCIPAL, value, gst_applicable, collect: UPFRONT|DEDUCT_FROM_DISBURSAL|ADD_TO_FIRST_INSTALLMENT}` |
| penalty_rule jsonb | `{type: FLAT_PER_INSTALLMENT|PCT_OF_OVERDUE_PER_DAY|PCT_PA_ON_OVERDUE, value, grace_days, cap}` |
| allocation_rule_id FK | |
| reminder_rule_set_id FK | |
| gl_mapping jsonb | account codes per posting slot (doc 07) |
| max_ltv_pct | loan ÷ asset value cap |
| approval_threshold NUMERIC | above → manager/management approval |
| effective_from, effective_to, version | products are versioned; loans reference the exact version |

### loans
| column | notes |
|---|---|
| id, loan_no UNIQUE | |
| customer_id, branch_id, product_id, product_version | |
| co_applicant_id, guarantor_id NULL | |
| status | `DRAFT, PENDING_APPROVAL, APPROVED, DISBURSED/ACTIVE, CLOSED, FORECLOSED, WRITTEN_OFF, CANCELLED` |
| asset_value, down_payment, principal NUMERIC(18,2) | |
| interest_method, interest_rate, rate_basis (`PA`) | frozen at creation |
| frequency (`DAILY, WEEKLY, FORTNIGHTLY, MONTHLY, CUSTOM`), custom_interval_days | |
| num_installments, installment_amount | |
| total_interest, total_fees, total_payable | frozen |
| apr NUMERIC(9,6) | computed for KFS ⚖ |
| disbursement_date, first_due_date, maturity_date | |
| disbursed_amount, disbursement_account_id | |
| assigned_collector_id FK employees | current; history in collection_assignments |
| **Denormalised balances** (updated in same txn, verified nightly): `principal_outstanding, interest_outstanding, fees_outstanding, penalty_outstanding, overdue_amount, dpd int, advance_balance, next_due_date, next_due_amount` | |
| closed_at, closure_type (`REGULAR, FORECLOSURE, SETTLEMENT, WRITE_OFF`) | |
| calc_snapshot jsonb | full input + engine version used, so the schedule is reproducible |

Indexes: `(branch_id, status)`, `(customer_id)`, `(assigned_collector_id, status)`,
`(status, next_due_date)`, `(dpd) WHERE status='ACTIVE'`.

### loan_charges
`id, loan_id, code, description, amount, gst_amount, collection_mode, status (PENDING|COLLECTED|WAIVED|DEDUCTED)`

### loan_installments
| column | notes |
|---|---|
| id, loan_id, installment_no | UNIQUE `(loan_id, installment_no)` |
| due_date | |
| principal_due, interest_due, fees_due, penalty_due | |
| principal_paid, interest_paid, fees_paid, penalty_paid | |
| waived_amount | |
| total_due (generated) = Σdue − waived | |
| total_paid (generated) | |
| balance (generated) | |
| opening_principal, closing_principal | for statement |
| status | `UPCOMING, DUE_TODAY, PARTIALLY_PAID, PAID, OVERDUE, WAIVED, RESCHEDULED` |
| paid_on date NULL, days_overdue int | |
| superseded_by_schedule_version | reschedules create new rows; old rows → `RESCHEDULED` |
CHECK constraints: every `*_paid ≤ *_due`, all ≥ 0.
Index `(due_date, status)`, `(loan_id, status)`.

### loan_schedule_versions
`id, loan_id, version, reason (ORIGINAL|RESCHEDULE|RESTRUCTURE), created_by, approved_by, created_at`

### assets
| column | notes |
|---|---|
| id, asset_no, loan_id FK, customer_id FK | |
| category | same enum as product category |
| status | `ACTIVE, REPOSSESSED, RELEASED, SOLD, CLOSED, WRITTEN_OFF` |
| asset_value, purchase_price, purchase_date, dealer_name, invoice_no | |
| make/brand, model, variant, manufacture_year, colour | |
| serial_no | electronics |
| registration_no | normalised uppercase no spaces; indexed |
| chassis_no, engine_no | indexed (trigram) |
| rc_details jsonb, hypothecation_marked bool, hypothecation_date, hypothecation_bank | |
| insurance_policy_no, insurance_expiry, insurer | |
| permit_no, permit_expiry, fitness_expiry, tax_valid_till, vehicle_type | commercial |
| attributes jsonb | category-specific extras (validated by Zod per category) |
Unique partial indexes: `registration_no WHERE status IN ('ACTIVE','REPOSSESSED')`,
`chassis_no WHERE status IN ('ACTIVE','REPOSSESSED')` (prevents double-financing).

### asset_documents
`id, asset_id, file_id, doc_type (RC, INSURANCE, INVOICE, PERMIT, FITNESS, NOC, PHOTO, OTHER), expiry_date`

### asset_events
`id, asset_id, at, from_status, to_status, reason, actor_id, approved_by, attachments`

### loan_closures
`id, loan_id, closure_no, closed_on, principal_paid, interest_paid, fees_paid,
penalty_paid, waivers, checklist jsonb (NOC issued, RC returned, hypothecation
removal letter…), closure_letter_file_id, approved_by`

---

## 4. Collections

### collection_assignments
`id, loan_id, employee_id, from_date, to_date NULL, assigned_by, reason` —
exclusion constraint (btree_gist) prevents overlapping active assignment per loan.

### collection_targets
`id, employee_id, period_type (DAILY|WEEKLY|MONTHLY), period_start, target_amount, set_by`
(Management metric only; never used by accounting.)

### collection_visits
`id, loan_id, customer_id, employee_id, visited_at, outcome (PAID, PARTIAL,
PROMISED, NOT_AVAILABLE, REFUSED, SHIFTED, OTHER), notes, lat NULL, lng NULL, payment_id NULL`

### promises_to_pay
`id, loan_id, employee_id, promised_amount, promised_date, status (OPEN, KEPT, BROKEN, PARTIAL), created_at, resolved_at`

### recovery_cases
`id, loan_id, stage (configurable state code), opened_at, dpd_at_open, owner_id, status, notes`
### recovery_stage_definitions (configurable workflow; no legal step hard-coded ⚖)
`code, name, sort_order, requires_approval_role, allowed_next text[]`
### recovery_actions
`id, case_id, action_type, at, actor_id, details jsonb, attachments uuid[]`

---

## 5. Payments & receipts

### payments
| column | notes |
|---|---|
| id, payment_no UNIQUE | `PAY-2026-000001` |
| loan_id, customer_id, branch_id | |
| collected_by (employee_id), recorded_by (user_id) | |
| amount NUMERIC(18,2) CHECK > 0, currency | |
| method | `CASH, UPI, BANK_TRANSFER, CHEQUE, OTHER` |
| reference_no | UTR / txn id / cheque no |
| cheque_bank, cheque_date, cheque_status (`RECEIVED, DEPOSITED, CLEARED, BOUNCED`) | |
| received_at timestamptz, business_date, value_date | |
| location_text, lat, lng | optional |
| debit_account_id | Employee cash-in-hand / UPI clearing / bank / cheques-in-hand |
| status | `POSTED, REVERSAL_PENDING, REVERSED` |
| reconciliation_status | `UNRECONCILED, MATCHED, VERIFIED, DIFFERENCE` |
| journal_entry_id FK | |
| idempotency_key | |
| settlement_id NULL | employee day settlement it was covered by |
Unique partial index `(method, reference_no) WHERE method IN ('UPI','BANK_TRANSFER') AND status <> 'REVERSED'`.
Index `(collected_by, business_date)`, `(loan_id, received_at)`, `(branch_id, business_date, method)`.

### payment_allocations (immutable)
`id, payment_id, installment_id NULL, component (PENALTY|FEE|INTEREST|PRINCIPAL|ADVANCE|GST), amount, sequence, rule_snapshot jsonb`
CHECK `amount > 0`. Σ(allocations) = payment.amount enforced by deferred constraint trigger.

### payment_reversals
`id, reversal_no, payment_id UNIQUE, reason_code, reason_text, requested_by, requested_at,
approved_by, approved_at, status (REQUESTED, APPROVED, REJECTED), reversal_journal_entry_id`
CHECK `approved_by <> requested_by`.

### receipts
`id, receipt_no UNIQUE, payment_id UNIQUE, issued_at, pdf_file_id, verify_token (random, for public page),
status (ISSUED, CANCELLED), cancelled_by_reversal_id, snapshot jsonb (exact figures printed)`

### customer_advances (sub-ledger view; balances also in GL)
Derived from allocations with component `ADVANCE` and their later applications.

---

## 6. Accounting

### accounts (chart of accounts)
| column | notes |
|---|---|
| id, code UNIQUE, name | e.g. `1100 Cash`, `1101-KKD Branch Cash KKD` |
| type | `ASSET, LIABILITY, EQUITY, INCOME, EXPENSE` |
| normal_balance | `DEBIT` / `CREDIT` |
| parent_id | tree |
| is_postable | only leaves take postings |
| subtype | `CASH, BANK, UPI_CLEARING, EMPLOYEE_CASH, CHEQUES_IN_HAND, LOAN_RECEIVABLE, …` |
| branch_id NULL, employee_id NULL, bank_account_id NULL | control/sub-ledger link |
| is_system | cannot be renamed/deleted |
| is_active | |

### bank_accounts
`id, account_id FK accounts UNIQUE, bank_name, branch_name, account_no_enc, account_no_last4, ifsc, upi_vpa, type (CURRENT, SAVINGS, UPI_SETTLEMENT, WALLET)`

### journal_entries (immutable)
| column | notes |
|---|---|
| id, entry_no UNIQUE | |
| entry_type | `DISBURSEMENT, FEE, PAYMENT, ACCRUAL, PENALTY, EXPENSE, DEPOSIT, TRANSFER, ADJUSTMENT, REVERSAL, OPENING, WRITE_OFF, REPOSSESSION, SALE, MANUAL` |
| value_date, business_date, posted_at | |
| branch_id | |
| source_type, source_id | e.g. `payment`, id |
| narration | |
| reverses_entry_id NULL UNIQUE | a reversal points at what it reverses |
| created_by, approved_by NULL | manual/adjustment entries require approver |

### journal_lines (immutable)
`id, entry_id FK, line_no, account_id FK, debit NUMERIC(18,2) DEFAULT 0, credit NUMERIC(18,2) DEFAULT 0,
branch_id, loan_id NULL, customer_id NULL, employee_id NULL, cost_centre NULL, memo`
CHECK `(debit = 0) <> (credit = 0)` and both ≥ 0.
Deferred constraint trigger: per entry Σdebit = Σcredit and ≥ 2 lines.
Indexes: `(account_id, value_date)`, `(loan_id)`, `(employee_id, value_date)`, `(entry_id)`.

### account_balances_daily (materialised, rebuildable)
`account_id, date, branch_id, opening, debits, credits, closing` — built by job, used for fast reports; always rebuildable from lines.

### expense_categories
`id, name, account_id FK, requires_receipt bool, approval_limit`

### expenses
`id, expense_no, branch_id, employee_id NULL, category_id, amount, gst_amount, expense_date, payment_method,
paid_from_account_id, vendor, bill_no, notes, file_ids, status (DRAFT, SUBMITTED, MANAGER_APPROVED, APPROVED, REJECTED, POSTED, REVERSED),
journal_entry_id`

### expense_approvals
`id, expense_id, level, action, actor_id, at, comment`

---

## 7. Reconciliation & day close

### business_days
`id, branch_id, business_date, status (OPEN, SUBMISSION, VERIFICATION, CLOSED), closed_by, closed_at, reopened_by NULL, reopen_reason`
UNIQUE `(branch_id, business_date)`.

### accounting_periods
`id, period_start, period_end, status (OPEN, SOFT_LOCKED, LOCKED), locked_by, locked_at`

### employee_settlements (one per employee per business day)
| column | notes |
|---|---|
| id, employee_id, branch_id, business_date | UNIQUE `(employee_id, business_date)` |
| expected_collection | from today's sheet (metric) |
| collected_cash, collected_upi, collected_bank, collected_cheque, collected_other, collected_total | from payments (system-computed, stored as snapshot) |
| opening_cash | = previous day's closing expected cash-in-hand |
| cash_deposited | Σ deposits posted from employee cash that day |
| approved_cash_expenses | Σ approved expenses paid from employee cash |
| expected_closing_cash | computed |
| declared_closing_cash | entered by employee |
| verified_closing_cash | counted by accountant/manager |
| cash_difference | expected − verified |
| upi_verified, bank_verified, cheque_verified | from statement matching |
| status | `OPEN, SUBMITTED, VERIFIED, MATCHED, SHORT, EXCESS, PENDING_VERIFICATION, APPROVED` |
| submitted_at, verified_by, verified_at, approved_by, approved_at | |

### settlement_differences
`id, settlement_id, kind (CASH, UPI, BANK, CHEQUE), amount, direction (SHORT|EXCESS), reason_code (PENDING_DEPOSIT, EXPENSE, CUSTOMER_REFUND, CORRECTION, OTHER), notes, resolution (CARRY_FORWARD, RECOVER_FROM_EMPLOYEE, WRITE_OFF, ADJUSTMENT), adjustment_journal_entry_id, approved_by, status`

### cash_deposits
`id, deposit_no, employee_id NULL, from_account_id, to_account_id, amount, deposited_at, business_date, slip_no, file_id, status (RECORDED, VERIFIED, REJECTED), journal_entry_id, verified_by`

### bank_statement_imports
`id, bank_account_id, file_id, period_from, period_to, row_count, imported_by, imported_at, parser (ICICI_CSV, SBI_XLS, GENERIC_MAPPED), status`

### bank_statement_lines
`id, import_id, bank_account_id, txn_date, value_date, description, reference, utr (extracted), debit, credit, balance, match_status (UNMATCHED, SUGGESTED, MATCHED, IGNORED), row_hash UNIQUE`
(`row_hash` prevents importing the same statement row twice.)

### reconciliation_matches
`id, statement_line_id, match_type (PAYMENT, DEPOSIT, EXPENSE, JOURNAL), target_id, amount, confidence, method (AUTO_UTR, AUTO_AMOUNT_DATE, MANUAL), matched_by, matched_at, approved_by, status (SUGGESTED, CONFIRMED, REJECTED, UNDONE)`
A payment is only `reconciliation_status = MATCHED` after a `CONFIRMED` match; auto rules only *suggest* unless UTR+amount match exactly.

### reconciliations (report snapshots)
`id, type (EMPLOYEE, BRANCH, CASH, UPI, BANK), scope_id, business_date, summary jsonb, generated_at, approved_by`
### reconciliation_items
`id, reconciliation_id, item_type, ref_id, expected, actual, difference, status`

---

## 8. Communications

### provider_configs
`id, channel (SMS|WHATSAPP), provider_key, display_name, credentials_enc bytea, sender_id, dlt_entity_id, is_active, branch_id NULL`

### message_templates
`id, channel, event_code (PAYMENT_RECEIVED, DUE_REMINDER, OVERDUE, LOAN_APPROVED, LOAN_DISBURSED, LOAN_CLOSED, STATEMENT…), language, body, variables text[], dlt_template_id, wa_template_name, wa_category, status`

### reminder_rule_sets / reminder_rules
`rule: id, set_id, offset_days (−3, −1, 0, +1, +7, +15, +30), channel[], template_id, audience (CUSTOMER|COLLECTOR|MANAGER|MANAGEMENT), min_amount, is_active`

### sms_logs / whatsapp_logs
`id, customer_id, loan_id, payment_id NULL, template_id, to_number (masked in UI), rendered_body, provider_key, provider_message_id, status (QUEUED, SENT, DELIVERED, READ, FAILED), error_code, error_text, attempts, triggered_by (AUTO|user_id), queued_at, sent_at, delivered_at`

---

## 9. Imports

### import_jobs
`id, kind (CUSTOMERS, LOANS, INSTALLMENTS, OPENING_BALANCES, EMPLOYEES, ASSETS), file_id, status (UPLOADED, VALIDATED, FAILED_VALIDATION, CONFIRMED, IMPORTING, COMPLETED, ROLLED_BACK), total_rows, valid_rows, error_rows, created_by, confirmed_by, started_at, completed_at`
### import_rows
`id, job_id, row_no, raw jsonb, normalised jsonb, errors jsonb, target_id NULL, status`
Import of financial data runs in a single transaction per job (or per batch with a
job-level compensating reversal) and posts an `OPENING` journal against an
**Opening Balance Equity** account, so imported balances are visible in the ledger.

---

## 10. Database-level protections (summary)

1. App role `fin_app` has `SELECT, INSERT` only on `journal_entries, journal_lines,
   payment_allocations, audit_logs, bank_statement_lines`; status changes on
   `payments, receipts, expenses` go through `SECURITY DEFINER` functions that
   validate the transition.
2. Deferred constraint triggers: balanced journals; allocations sum to payment.
3. Trigger `guard_closed_period` on `journal_lines` insert.
4. Trigger `forbid_mutation` on append-only tables.
5. RLS on branch-scoped tables using `app.user_id` / `app.branch_ids` session settings.
6. `migration` role separate from `fin_app`; production migrations via CI only.
