# Phase 5 Report — Accounting (accountant features)

Status: **complete, awaiting your review.** Items marked ⚖ need your CA's confirmation.

## 1. What was built

| Area | What it does |
|---|---|
| **Expenses** (`/expenses`) | Claimed → approved at the branch → **posted by an accountant**. Whoever claimed it can never approve, post or reverse it (DB CHECK + API). Collectors claim from their own cash in hand from the phone. Branch staff pay from branch cash or a bank account. Categories map to expense accounts (fuel 5300, travel 5310, office 5400, rent 5200, salaries 5100, bank charges 5500, other 5900). Bills (PDF/photo) attach through the same scanned file store as KYC; categories can require one. Posting creates **E9**: Dr expense / Cr cash-in-hand, branch cash or bank. A posted expense can't be edited (DB trigger); a wrong one is reversed with a reason and step-up. |
| **Cash & bank** (`/banking`) | Balances grouped as bank, branch cash, cash with collectors, UPI awaiting bank match, and cheques in hand — straight from the journal. |
| **Deposits & hand-overs** | Collector cash → bank or branch safe, branch cash → bank (**E6**), with slip number. **You can't deposit more than an account holds** (account row locked while checking). A reversal must be done by someone other than the recorder. |
| **Cheque lifecycle** (**E8**) | Received (cheques in hand) → **deposited** (Dr bank / Cr cheques in hand) → **cleared**. **Bounced**: the bank deposit is undone, the payment is reversed exactly as an approved reversal (installments restored, receipt cancelled, customer told by SMS), and an optional bounce charge is added to the next installment (Dr fees receivable / Cr other charges) ⚖. Bounce needs step-up. |
| **Manual journals** (`/journals`) | Prepared by one person, **approved by another with step-up**. The entry records both names. Must balance. **Loan receivables (1310–1340) and customer advances (2200) are refused**: they must always equal the loan sub-ledger, so only loan actions change them. Approved journals can be mirrored with one click ("Prepare reversal"). |
| **Journal browser** | Every entry, filtered by date, type and search. Each entry shows its lines, loan and employee, who posted and approved it, and what it reverses or what reversed it, with a link to the source (loan, payment). |
| **Books** (`/books`) | **Trial balance**, **profit & loss** (accrual basis ⚖), **balance sheet** (assets = liabilities + equity + profit not yet closed ⚖), **cash & bank book** (opening + receipts − payments = closing for every cash, collector, UPI, cheque and bank account) and **day book**. Each exports to **Excel** with company header, report name, filters, generated time, frozen header and Indian number format (12,34,567.00). Branch accountants see only their branches. |
| **Month locks** | **Soft-lock** (accountant): only adjustments and reversals. **Lock** (management): nothing at all. **Reopen** (management): a reason (10+ characters) and step-up, audited. The current month can't be locked. The API gives a clear "books for 2026-09 are locked" error, and the **database refuses it too**, even if the API is bypassed. |
| **Cash never negative** | Deposits, expenses paid from branch cash, and manual journals crediting a cash account all refuse to take cash below what is actually held. |

## 2. How it was tested

| Suite | Count |
|---|---|
| Money, contracts, loan engine (incl. allocation) | 46 |
| API integration (real PostgreSQL) | **157** (13 new: the expense chain and maker-checker at each step; collector own-cash only; bank account required; future dates; reject and reverse with step-up; DB refuses edit/delete of a posted expense; branch cash can't go negative; deposits capped by cash held; second-person deposit reversal; cross-branch hand-over refused; cheque deposit/clear; bounce after deposit with charge and the fees receivable tie-out; bounce before deposit; manual journal balance, control-account refusal, maker-checker and step-up; soft-lock/lock/reopen including the database-level refusal; trial balance and balance sheet balance; P&L arithmetic; cash book identity; all five Excel exports; branch scoping) |
| Browser (Playwright: iPhone 13, desktop, Pixel 7) | 10 steps. The collector claims fuel on the phone. The manager approves claims, records a cash deposit and deposits a cheque. A new accountant enrols 2FA, posts the approved expenses and prepares a manual journal. A new admin enrols 2FA, approves the journal with step-up, and bounces the deposited cheque with a charge. Then all books tabs and an Excel download. No page errors and no horizontal overflow. |

**Total: 203 automated tests, all passing.** The Phase 4 browser suite was re-run on the new demo data and still passes.

### Defects found and fixed during Phase 5
1. Collectors could not claim expenses: the branch check rejected their assigned-loan scope. Their own branch is now enforced through their employee record.
2. Branch cash could be driven negative by expenses and manual journals, as the first demo run showed (−₹315). Both now refuse, like deposits already did.
3. Demo data had no opening capital, so the bank balance went negative after disbursements. The demo now books partners' capital and branch cash floats first, as a real start would.

## 3. Deviations and deferrals

| Planned | Status | Why |
|---|---|---|
| Expense approval limits per category (manager ≤ limit, management above) | Not yet: one branch approval, then accountant posting | The two-person chain covers control; limits need your figures (open question 8). |
| Nightly integrity checks (doc 07 §7) | The checks exist as tests and as live "balanced" flags on the trial balance and balance sheet. **The nightly job and alerts are not built yet.** | Comes with daily reconciliation in Phase 6, which raises the alerts. |
| Refund of an advance left over at loan closure | Not built | A payment-out with its own approval; scheduled with reconciliation differences (Phase 6). |
| Year-end closing entry (P&L → retained earnings) | Not built; current profit shows on its own balance-sheet line ⚖ | Should be prepared with your CA. |
| GST on bounce charges and penal charges | Not applied ⚖ | Needs CA confirmation of GST treatment. |

## 4. ⚖ For your CA
- Accrual basis (D1) is now visible in the P&L: interest income is recognised when installments fall due.
- Bounce and penal charges carry no GST at present.
- Year-end closing and opening-balance migration (E15) for existing books.

## 5. How to try it
`pnpm --filter @fin/api db:seed:demo` now also creates `accounts.kkd` (Accountant,
2FA set up at first sign-in), partners' capital, expenses at each stage, a
cash deposit and a cheque in hand. Sign in as `manager.kkd` to approve claims and
deposit the cheque, and as `accounts.kkd` to post expenses and read the books.

Next: **Phase 6 — Daily reconciliation** (employee settlement, cash counts,
differences with reasons, bank/UPI statement import and matching, day close).
