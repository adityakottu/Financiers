# 07 — Accounting & Double-Entry Specification

⚖ **REVIEW:** Income recognition basis (D1), GST treatment of fees, NPA/provisioning
and write-off policy, and Ind AS applicability must be confirmed by your CA. The
engine supports alternatives via configuration; this document describes the
recommended default.

## 1. Principles

1. **Every financial event produces exactly one balanced journal entry** (Σ Dr = Σ Cr),
   created in the same DB transaction as the business record.
2. **Only posting rules create journals.** Business modules emit a `PostingEvent`;
   `PostingRuleEngine` maps it to lines using the loan product's `gl_mapping`.
   Manual journals exist but require a second-user approval.
3. **Immutable.** Journals are never edited or deleted. Corrections are
   **reversal entries** (exact mirror, linked by `reverses_entry_id`) plus a new
   correct entry.
4. **Sub-ledgers tie to control accounts.** Loan-wise receivables, employee
   cash-in-hand, customer advances each have per-entity dimensions on journal lines
   (`loan_id`, `employee_id`, `customer_id`). A nightly check proves
   Σ(sub-ledger) = control account balance.
5. **Two dates.** `value_date` (economic date — drives reports & period locks) and
   `posted_at` (when recorded — drives audit).
6. **Employees never see this.** The collector sees "Collect ₹1,250". The
   accountant sees the lines.

## 2. Chart of Accounts (seed)

Codes are editable by Admin/Accountant (⚙); `is_system` accounts can't be deleted.
Postable sub-accounts are created automatically per branch / employee / bank.

| Code | Account | Type | Notes |
|---|---|---|---|
| **1000** | **Assets** | | |
| 1110-{BR} | Branch Cash — {branch} | Asset | branch safe |
| 1120-{EMP} | Cash-in-Hand — {employee} | Asset | one per collector (D5) |
| 1130-{BR} | Cheques in Hand — {branch} | Asset | received, not yet cleared |
| 1210-{n} | Bank — {bank a/c} | Asset | one per bank account |
| 1250-{n} | UPI Clearing — {UPI a/c/VPA} | Asset | UPI received, awaiting bank settlement match |
| 1310 | Loan Principal Receivable | Asset | dims: loan, category |
| 1320 | Interest Receivable | Asset | accrued, not collected |
| 1330 | Fees Receivable | Asset | |
| 1340 | Penal Charges Receivable | Asset | |
| 1410 | Employee Shortage Recoverable | Asset | dim: employee |
| 1420 | Staff Advances | Asset | |
| 1500 | Repossessed Assets Held for Sale | Asset | |
| 1600 | Fixed Assets | Asset | |
| 1710 | GST Input Credit | Asset | ⚖ |
| **2000** | **Liabilities** | | |
| 2100 | Payables — Vendors | Liability | |
| 2200 | Customer Advances | Liability | overpayments (D4); dim: customer/loan |
| 2250 | Unidentified Receipts (Suspense) | Liability | bank credits not yet identified — must be zero at month end or explained |
| 2310 | GST Output Payable | Liability | ⚖ |
| 2400 | Insurance Premium Payable | Liability | if insurance collected on behalf of insurer |
| 2500 | Borrowings | Liability | |
| 2900 | Other Liabilities | Liability | |
| **3000** | **Equity** | | |
| 3100 | Capital | Equity | |
| 3200 | Retained Earnings | Equity | |
| 3900 | Opening Balance Equity | Equity | only for data migration; cleared to capital by CA |
| **4000** | **Income** | | |
| 4100 | Interest Income | Income | dim: category |
| 4210 | Processing Fee Income | Income | |
| 4220 | Documentation Fee Income | Income | |
| 4230 | Other Charges Income | Income | |
| 4300 | Penal Charges Income | Income | |
| 4400 | Other Income | Income | |
| 4500 | Bad Debts Recovered | Income | |
| 4600 | Cash Excess (Over) | Income | approved excess on settlement |
| **5000** | **Expenses** | | |
| 5100 Salaries · 5200 Rent · 5300 Fuel · 5310 Travel · 5400 Office · 5500 Bank Charges · 5900 Other | Expense | per expense category |
| 5600 | Bad Debts Written Off | Expense | |
| 5610 | Loss on Sale of Repossessed Asset | Expense | |
| 5700 | Cash Shortage Written Off | Expense | only with approval |
| 5800 | Interest / Penalty Waived | Expense (or contra-income ⚖) | |

## 3. Posting rules (default: accrual on due date — D1)

Notation: `Dr account amount` / `Cr account amount`. `{coll}` = the collection
debit account chosen by method:

| Method | `{coll}` debit account |
|---|---|
| CASH | 1120-{collecting employee} (or 1110-{BR} if collected at counter by cashier) |
| UPI | 1250-{UPI a/c} |
| BANK_TRANSFER | 1210-{bank a/c} (reconciliation status UNRECONCILED until statement match) |
| CHEQUE | 1130-{BR} |

### E1 Loan disbursement — ₹1,00,000, processing fee ₹2,000 + 18% GST deducted, paid by bank
```
Dr 1310 Loan Principal Receivable      1,00,000.00   (loan LN-…)
   Cr 1210 Bank                                        97,640.00
   Cr 4210 Processing Fee Income                        2,000.00
   Cr 2310 GST Output Payable                             360.00
```
If fee is collected upfront instead: disbursement `Dr 1310 / Cr Bank 1,00,000`,
separate receipt `Dr {coll} 2,360 / Cr 4210 2,000 / Cr 2310 360`.
If fee is added to installment 1: `Dr 1330 Fees Receivable 2,360 / Cr 4210 2,000 / Cr 2310 360` at disbursement.

### E2 Installment falls due — nightly `interest.accrue` (accrual basis)
Installment #1 of Example D: interest 2,000.00
```
Dr 1320 Interest Receivable   2,000.00
   Cr 4100 Interest Income               2,000.00
```
Principal is already in 1310 — no entry for principal on due date.

### E3 Penal charge assessed
```
Dr 1340 Penal Charges Receivable   50.00
   Cr 4300 Penal Charges Income           50.00   (+ GST lines if applicable ⚖)
```

### E4 Payment received — ₹1,250 cash by employee E017, allocated Penalty 50 / Interest 300 / Principal 900
```
Dr 1120-E017 Cash-in-Hand           1,250.00
   Cr 1340 Penal Charges Receivable          50.00
   Cr 1320 Interest Receivable              300.00
   Cr 1310 Loan Principal Receivable        900.00
```
Payment allocated to an installment **not yet due** (paying ahead): interest for a
not-yet-due installment has not been accrued, so that portion goes to
`Cr 2200 Customer Advances` and is applied automatically on the due date
(E2 then E4-style application `Dr 2200 / Cr 1320`). This keeps income from being
recognised early.

### E5 Overpayment
Any amount left after allocation → `Cr 2200 Customer Advances` (D4).

### E6 Employee deposits cash to bank / branch safe
```
Dr 1210 Bank (or 1110 Branch Cash)     20,000.00
   Cr 1120-E017 Cash-in-Hand                   20,000.00
```

### E7 UPI settlement matched to bank statement
```
Dr 1210 Bank               5,400.00
   Cr 1250 UPI Clearing            5,400.00
```
(Gateway/MDR charges, if any: `Dr 5500 Bank Charges`.)

### E8 Cheque lifecycle
Deposit: `Dr 1210 Bank (uncleared dimension) / Cr 1130 Cheques in Hand`.
Bounce: reversal of the payment (E10) + bounce charge per product
(`Dr 1330 Fees Receivable / Cr 4230 Other Charges Income`).

### E9 Expense (approved) paid in cash by employee
```
Dr 5300 Fuel                 2,000.00
   Cr 1120-E017 Cash-in-Hand          2,000.00
```
Paid by bank: credit 1210. On credit: credit 2100 Payables, then payment clears 2100.

### E10 Payment reversal (approved)
Exact mirror of the original entry, `entry_type = REVERSAL`,
`reverses_entry_id = original`, `value_date = reversal date` if the original
day is closed (original stays in its closed day; the correction appears today),
otherwise same value date.

### E11 Settlement difference
- Shortage ₹500, approved as recoverable from employee:
  `Dr 1410 Employee Shortage Recoverable (E017) 500 / Cr 1120-E017 500`
- Shortage approved as write-off: `Dr 5700 / Cr 1120-E017`
- Excess ₹200 unexplained, approved: `Dr 1120-E017 200 / Cr 4600 Cash Excess`
  (or `Cr 2250 Suspense` pending identification)
- "Pending deposit" reason → **no entry**; carries forward as tomorrow's opening cash.

### E12 Waiver (approved)
`Dr 5800 Waiver / Cr 1340 (or 1320)` for the waived amount; installment `waived_amount` updated.

### E13 Write-off ⚖
`Dr 5600 Bad Debts / Cr 1310, 1320, 1330, 1340` for outstanding; loan → WRITTEN_OFF.
Later recovery: `Dr {coll} / Cr 4500 Bad Debts Recovered`.

### E14 Repossession & sale ⚖
Repossess (at approved valuation): `Dr 1500 Repossessed Assets / Cr 1310…`
(difference to `5600` or kept receivable per policy). Sale:
`Dr Bank / Cr 1500`, gain/loss to `4400`/`5610`; surplus owed to customer → `2200`.

### E15 Opening balances (migration)
`Dr 1310 / 1320 … / Cr 3900 Opening Balance Equity` per imported loan; cash & bank
openings likewise. The CA clears 3900.

### Cash-basis alternative (if D1 = cash basis)
E2 is not posted. E4 becomes `Dr {coll} 1,250 / Cr 4300 50 / Cr 4100 300 / Cr 1310 900`
(the user's original example). Interest Receivable is then a memo figure computed
from the schedule, not a ledger balance. Switching basis mid-year is blocked.

## 4. Posting engine contract

```ts
type PostingEvent =
  | { kind: 'LOAN_DISBURSED', loan, feeLines, fromAccountId }
  | { kind: 'INTEREST_ACCRUED', loan, installment, amount }
  | { kind: 'PAYMENT_RECEIVED', payment, allocations }
  | { kind: 'DEPOSIT', deposit } | { kind: 'EXPENSE_POSTED', expense }
  | { kind: 'REVERSAL', originalEntryId, reason } | …

LedgerService.post(tx, event): JournalEntry
  1. rule = rules[event.kind]; lines = rule(event, glMapping)
  2. assert lines.length ≥ 2, Σdr = Σcr, all amounts > 0, accounts postable & active
  3. assert value_date period OPEN and business day OPEN for branch (or entry_type ∈ {REVERSAL, ADJUSTMENT} dated today)
  4. insert entry + lines (DB trigger re-checks balance at commit)
```

## 5. Books & reports derived from the ledger

| Report | Source |
|---|---|
| General Ledger | `journal_lines` by account, running balance = opening + Σ(dr − cr) × sign |
| Cash Book | GL of all `CASH` / `EMPLOYEE_CASH` subtype accounts |
| Bank Book | GL of `BANK` accounts + reconciliation status |
| Day Book | all entries for a value date |
| Trial Balance | Σ dr, Σ cr per account as of date; must balance |
| Profit & Loss | Income − Expense accounts for period |
| Balance Sheet | Assets = Liabilities + Equity + current-period P&L |
| Receivables ageing | loan-level sub-ledger (1310/1320/1330/1340 by loan) × DPD buckets |
| Cash/Bank account summary | opening + receipts − payments = closing per account |

## 6. Periods & locks

- **Business day** (per branch): OPEN → … → CLOSED (doc 09). Closed-day postings
  rejected by trigger.
- **Accounting period** (month): OPEN → SOFT_LOCKED (accountant; only adjustments
  with approval) → LOCKED (management; nothing except via period unlock with
  two-person approval, audited).
- **Financial year**: April–March; year-end closing entry moves P&L to 3200
  Retained Earnings (generated, reviewed by CA).

## 7. Integrity checks (nightly + on demand)

1. Every journal balanced; trial balance balances.
2. Σ per-loan 1310 lines = Σ loans.principal_outstanding.
3. Σ per-employee 1120 balance = settlement expected closing cash.
4. Every POSTED payment has exactly one PAYMENT journal; every REVERSED payment has
   a REVERSAL journal; no orphan journals with `source_type=payment`.
5. 1250 UPI Clearing and 2250 Suspense ageing > 3 days flagged.
6. Any failure → notification to Accountant + Super Admin; **never auto-corrected**.
