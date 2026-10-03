# Phase 6 Report — Daily reconciliation

Status: **complete, awaiting your review.** Items marked ⚖ need your CA's confirmation.

## 1. What was built

| Area | What it does |
|---|---|
| **Employee cash settlement** | One settlement per employee per day. **Expected cash** comes straight from the employee's cash-in-hand ledger account (1120): opening + cash collected − reversals − deposited / handed over − expenses paid. The collector **declares** what they hold from the phone (`/collect` → "End-of-day cash"). **Someone else counts it.** The database refuses a count or approval by the employee themselves. Count = expected → **Matched**. Otherwise → **Short / Excess**. The count stores a snapshot. If the ledger moves afterwards (a late payment, a deposit), the settlement is flagged **"count again"** and blocks the day close. |
| **Differences (E11)** | Every rupee of a shortage or excess is explained with a **reason** (pending deposit, expense, customer refund, correction, counting error, other) and a **resolution**. Shortage: carry forward, recover from the employee (1410), or write off (5700). Excess: other income (4600) or suspense (2250). One person records it. **Another approves it with step-up.** Above **₹1,000** only Management can approve ⚖. Explanations can't exceed the difference. A recount supersedes pending explanations. Approval posts the E11 adjustment. Carry-forward posts nothing: the cash stays with the employee for the next day. |
| **Bank / UPI statement import** | CSV or Excel. Presets cover a generic layout, SBI and HDFC; any other layout uses a column mapper (date formats DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD-MMM-YYYY, DD MMM YYYY). A **preview** shows new rows, duplicates and **unreadable rows with the reason**. Unreadable rows are **never silently dropped**: importing needs explicit confirmation and they are stored on the import record. Each line has a content hash, so **importing the same file twice adds nothing**. UTRs are extracted from UPI/NEFT/IMPS/RTGS narrations. Imports are append-only. |
| **Matching** | Candidates are UPI, bank-transfer and cheque payments, cash deposits, disbursements and bank-paid expenses. **Only an exact reference/UTR + amount match with a single candidate is confirmed automatically.** Amount + date matches are only **suggestions** for a person to confirm or reject. Confirming a UPI receipt posts **E7** (Dr bank / Cr UPI clearing) and marks the payment reconciled. Confirming a cheque marks it cleared. **Undo** needs a reason and mirrors E7. A statement line and a book item can each have only **one confirmed match** (unique indexes). A **payment confirmed by the bank cannot be reversed** until the match is undone. Unknown credits can be **held in suspense** (Dr bank / Cr 2250). Bank-only items can be **marked explained** with a reason. Nothing is ever marked reconciled without a match or a written reason. |
| **Bank reconciliation statement** | Per bank account, as of a date: balance in the books, last statement balance, items in the books not yet on the statement, items on the statement not in the books, and the **unexplained difference**. |
| **Not yet in bank** | UPI and bank transfers collected but not yet seen on any statement, with age. Old ones are highlighted. |
| **Day close** (`/reconciliation`) | Per branch and date: every employee's expected / counted / status, collections confirmed by the bank, and items in transit. **The day can't close while any cash count is missing, stale or has an unapproved difference.** UPI and cheques in transit don't block; they carry forward. Closing stores a summary. **After close, the database refuses money postings dated that day** (payments, deposits, expenses, disbursements, manual journals, transfers, fees); the API returns a clear `DAY_CLOSED`. Accruals and penalties still run. **Reopen takes two people:** one asks with a reason, another approves with step-up (database CHECK). |
| **Board** | A week per branch: employees × days, 🟢 reconciled, 🟠 pending, 🔴 difference not approved, 🔒 closed. Click a cell to open that day. |
| **Roles** | Collector: declare own cash. Branch manager: count, explain, approve ≤ ₹1,000, close the day, ask to reopen. Accountant: count, explain, import statements, match, close. Management: approve any difference, approve reopen. |

## 2. How it was tested

| Suite | Count |
|---|---|
| Money, contracts, loan engine | 46 |
| API integration (real PostgreSQL) | **167** (11 new in reconciliation. CSV/date/amount/UTR parsing. Exact settlement match. ₹500 shortage explained by one person and approved with step-up by another, posting E11 to 1410. Excess to income, and the Management threshold. Import with auto-confirm of exact references (E7), suggestions only for amount + date, refusal of unreadable rows without confirmation, duplicate re-import adding nothing. A bank-confirmed payment can't be reversed until undo (E7 mirrored). Bank reconciliation explains the gap. Day close blocked until counts reconcile, stale counts, the database refusing postings on a closed day, two-person reopen. Board cells and unconfirmed UPI.) |
| Browser (Playwright: iPhone 13, desktop) | The collector declares ₹50 less than expected on the phone. A new accountant (2FA) sees the day blocked, counts, and explains the shortage as recover-from-employee; they **can't approve it themselves**. The accountant previews a file with one unreadable row (shown, not imported), imports the valid line, holds an unknown NEFT credit in suspense and explains two bank charges, then opens the bank reconciliation and "not yet in bank". The manager approves the difference with step-up, closes the day, views the board and asks to reopen, and **can't approve their own reopen**. The collector's phone shows the day closed. A new admin approves the reopen with 2FA step-up. No page errors and no horizontal overflow. |

**Total: 213 automated tests, all passing.** The Phase 4 and Phase 5 browser suites were re-run on the new demo data and still pass.

### Defects found and fixed during Phase 6
1. **A cash disbursement could overdraw branch cash.** The full test run showed KKD branch cash at −₹76,740 when the lending tests ran before the accounting tests. Phase 5 guarded expenses, deposits and journals but not disbursements. Disbursing in cash now checks what the till holds (`INSUFFICIENT_CASH`), with the account row locked.
2. Statement balances on the same date had no defined order, so the "last balance" could be the wrong row. Lines now keep their file order (`seq`).
3. The first demo statement covered only today. Every older disbursement then showed as "not yet on the statement" and the bank reconciliation looked broken. The demo now imports a statement covering the whole period (capital brought forward), and its bank reconciliation explains to ₹0.00.

## 3. Deviations and deferrals

| Planned | Status | Why |
|---|---|---|
| Fetching statements directly from the bank (API / SFTP) | Not built: files are uploaded | Needs each bank's corporate API agreement; the parser and matcher are ready for it. |
| PDF statements | Not supported: CSV/Excel only | PDF parsing is unreliable for financial data; banks offer CSV/Excel downloads. |
| Nightly integrity checks with alerts | The checks exist as tests, live "balanced" flags and the reconciliation board. **No nightly job or push alerts yet.** | Alerts need the notification channel planned for Phase 7. |
| Refund of a leftover advance at loan closure | Not built | Payment-out flow with its own approval; scheduled with recovery in Phase 7. |
| Difference approval limits per role | One threshold (₹1,000), defined in code | Your figure is needed (open question 8); it is a single constant to change. |
| Booking bank charges from the statement | Bank-only debits are "marked explained" with a reason and stay visible on the bank reconciliation. They are booked with a manual journal. | A one-click "book as expense" is a small Phase 7 addition. |

## 4. ⚖ For your CA
- Shortages recovered from an employee sit in 1410 (Shortage recoverable) until repaid. Written-off shortages go to 5700. Excess cash is income (4600) unless held in suspense.
- The ₹1,000 Management threshold for differences.
- Unknown bank credits held in suspense (2250): how long before they must be cleared or refunded.

## 5. How to try it
`pnpm --filter @fin/api db:seed:demo` now also imports an SBI statement for the
demo bank account. Disbursements, UPI receipts and the cash deposit match
automatically. An unknown NEFT credit and an SMS charge are left to resolve.
- `collector.kkd` → **My collections** → *End-of-day cash* → declare.
- `accounts.kkd` → **Reconciliation** → click the collector → count, explain;
  **Bank & UPI statements** → resolve the two lines, import another file.
- `manager.kkd` → **Reconciliation** → approve the difference → **Close day**.

Next: **Phase 7 — Reporting & exports** (all reports with filters, Excel/PDF,
dashboards, recovery module).
