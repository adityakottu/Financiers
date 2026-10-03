# Phase 7 Report — Reports, dashboards and recovery

Status: **complete, awaiting your review.** Items marked ⚖ need your CA's or legal advisor's confirmation.

## 1. What was built

| Area | What it does |
|---|---|
| **Reports** (`/reports`) | **32 named reports** on one engine. *Loans:* active, overdue by DPD bucket, closed, written off, dues (today / tomorrow / 7 days), outstanding by loan and by customer, portfolio by category with PAR 30, asset register. *Collections:* by day, employee, branch and method; payments register; pending; collection efficiency. *Accounting:* trial balance, P&L, balance sheet, cash & bank book, day book, general ledger with running balance, receivables ageing, expense register. *Reconciliation:* employee settlements, branch day close, cash differences, UPI/bank confirmation, unmatched statement lines. *Recovery:* cases, and repossessed and sold assets. |
| **Filters** | Date range or as-of date, branch, employee, account, category, method, status and DPD bucket, whichever the report uses. **The last filters are remembered per user and report.** Impossible dates (e.g. 30 Feb) and reversed ranges are refused. |
| **Scoping** | Every report sees only the user's branches. **Collectors see only their own collections and their assigned loans.** Asking for another branch's data returns nothing rather than an error, so it doesn't confirm the branch exists. |
| **Excel** | Company name, report name, filters, *Generated … IST by …*, frozen header, real numbers and dates, Indian number format (12,34,567.00), bold totals row. |
| **PDF** | A4 landscape and print-ready. The column header repeats on every page; totals; *Page x of y*. Amounts print without ₹ because standard PDF fonts lack the glyph, as on statements. |
| **Exports** | Need `export.data` and are **recorded in the audit log** (who, which report, filters, row count). **Reports over 10,000 rows become background jobs.** The file is kept 7 days and only the requester can download it. |
| **CA pack** | One workbook for your external accountant. A contents sheet states the basis (accrual ⚖), followed by trial balance, P&L, balance sheet, cash & bank book, receivables ageing, loan receivables, expense register, write-offs and cash differences. |
| **Dashboards** | **Company:** portfolio, overdue, PAR 30/90, collections today and this month, collection efficiency, 30-day collections chart, DPD chart, 6-month disbursements, a branch table (PAR, efficiency, whether yesterday was closed) and recovery figures. **Branch:** today's dues, day status, cash counts pending, the same charts, and **collector performance** (book, overdue, collected, efficiency, visits, promises kept, cases). **Collector:** to collect now, collected today and this month, efficiency, promises due, own book. Collection efficiency on the dashboards is computed by the collection-efficiency report itself, so the two cannot disagree. |
| **Charts** | One validated hue on the white surface; bars at most 24px with a rounded data end; hairline grid. A tooltip on hover **and keyboard focus**, and a "Show as table" view, so no value is hover-only. |
| **Recovery cases** (`/recovery`) | Cases are opened by hand, or **automatically by the nightly job** once a loan is past a configurable DPD (default 30), and owned by the assigned collector. At most one open case per loan. Calls, visits and notes go into a history **that cannot be edited or deleted** (database trigger). |
| **Stages** | **Configurable** stages and allowed moves (defaults: Follow-up → Field recovery → Escalated → Settlement → Repossession → Resolved / Written off). **No legal step is hard-coded** ⚖. Moving into a stage marked *needs approval* (default: Repossession) **waits for a second person, who confirms with their password.** *Resolved* is refused while the loan is still overdue. *Written off* is reached only through an approved write-off. |
| **Repossession** (E14 ⚖) | Allowed only once the case has been approved into Repossession. Records the date, where the asset is kept, its condition and an optional valuation. **It is custody only: nothing is posted.** The asset can be released back to the customer. |
| **Sale** (E14 ⚖) | One person records the sale (price, buyer, invoice, bank account). **A second person approves it with step-up.** The proceeds are posted Dr bank / Cr customer advance (2200), then **settle the loan through the same allocation engine as any payment**, so the loan's figures and the ledger always agree. If the proceeds cover everything owed, the loan closes and the **surplus stays in 2200 as owed to the customer** (closure checklist: refund due), and the case closes as Resolved. If not, what is due now is paid, the rest is applied as installments fall due, and the shortfall remains receivable. |
| **Write-off** (E13 ⚖) | Requested with a reason (20+ characters); **approved by Management with step-up, never by the requester.** It removes **exactly the receivables on the books** for the loan (principal, interest that fell due, fees, penal), using any advance first, against 5600 Bad Debts. Future, unaccrued interest is not written off because it was never income. The loan becomes *Written off*; earlier payments can no longer be reversed. **Money received later is booked as 4500 Bad Debts Recovered, not as a repayment**, and the database refuses allocations on such payments. Refused while a reversal, an uncleared cheque or a sale is pending. |
| **Waiting for you** (`/notifications`) | The notification centre planned for Phase 4, delivered now. It shows what is waiting for **your** decision: loans to approve, reversals, expenses to approve or post, journals, cash differences, day reopen requests, bank lines to match, recovery decisions, write-offs, overdue loans without a case, and exports ready. It is computed live, so it is never stale, and it **never lists your own requests.** |
| **Run & verify** | `.devcontainer/` for **GitHub Codespaces** and VS Code Dev Containers. `pnpm setup` creates new keys, migrates and loads demo data with random demo passwords kept in a git-ignored file; `pnpm demo` builds and starts the app. Guide: [run-and-verify.md](run-and-verify.md), covering Codespaces, VS Code, and Cloudflare Quick Tunnel or Tunnel + Access. |

## 2. How it was tested

| Suite | Count |
|---|---|
| Money, contracts, loan engine | 46 |
| API integration (real PostgreSQL) | **190** (23 new). Recovery: opening rules and one case per loan, collector notes but no stage moves, stage rules, two-person approval with step-up, auto-open threshold and owner, configurable stages that protect system stages, sale with surplus (loan closed, 1310–1340 at zero, 2200 shows the surplus, bank +price, refund on the checklist), sale below the dues (sub-ledger still ties), release and repossess again, write-off (exact receivables to 5600, advance used, later money to 4500 with no allocations, earlier payments not reversible), rejected write-off. **Reports (Phase 7 exit tests):** every report runs within a time budget; Excel format (header, filters, generated line, frozen header, numeric money with Indian format, bold totals); PDF; exports permission and audit; **outstanding and ageing totals equal the ledger 1310–1340**; trial balance and balance sheet balance; collections by day, branch and method agree with each other and with payments; branch and collector scoping; remembered filters; background export downloadable only by its requester; CA pack sheets. Dashboards agree with the reports; branch and collector dashboards are scoped. The inbox never shows your own requests. |
| Browser (Playwright: desktop, iPhone 13, Pixel 7) | The manager's branch dashboard and collector performance; overdue report Excel and PDF downloads; a sale recorded on the repossessed asset, with no approve button for the manager. The collector's own dashboard on a phone, a call note on a case, and only collection reports visible. The accountant: balanced trial balance, general ledger needing an account, CA pack download. The admin: company dashboard (chart tooltip on hover), inbox, approving the sale and the write-off with 2FA step-up, then the case settled and closed. Phone layouts have no horizontal overflow. |

**Total: 236 automated tests, all passing.** The Phase 4, 5 and 6 browser suites were re-run on the new demo data and still pass. `pnpm setup` was run from an empty database and `pnpm demo` was signed in through.

### Defects found and fixed during Phase 7
1. Payments recovered after a write-off were refused by the database rule that allocations must add up to the payment. The rule now requires **zero** allocations for such payments (and still the exact sum for every other payment).
2. A report's totals row put "Total" in a date column and the web page failed to render it (phone run). Date cells now show non-dates as text.
3. `pnpm setup` generated an admin password containing "admin", which the password policy rejects. The setup was run from scratch, and the prefix was changed.
4. Report filters accepted impossible dates such as 2026-02-30, which would have reached the database as an error. They are now refused as invalid.

## 3. Deviations and deferrals

| Planned | Status | Why |
|---|---|---|
| E14 "repossess at valuation: Dr 1500 / Cr 1310…" | **Repossession is custody only; the sale proceeds settle the loan** through the advance. 1500 *Repossessed Assets* is not used yet ⚖. | Posting at valuation means un-posting if the vehicle is released, and an estimate drives the books. Using the actual sale price keeps the loan sub-ledger and ledger provably equal. If your CA wants the 1500 treatment, it can be added as an approved adjustment. |
| Gain / loss on sale (4400 / 5610) | Not separate: proceeds reduce dues, surplus is owed to the customer, any shortfall stays receivable or is written off | Follows from the treatment above ⚖. |
| Refund of a surplus or a leftover advance to the customer | Shown as owed (2200, closure checklist); **the payment-out flow is not built** | Needs its own maker-checker payment-out; not on the roadmap yet — to be added before the pilot. |
| Dashboards by employee for non-collectors, date-range pickers on dashboards | Dashboards cover today, this month and fixed trends; any range is available in the reports | Keeps dashboards fast and unambiguous. |
| Notification push / email / SMS to staff | In-app inbox only | Staff messaging needs your choice of channel. |
| Large exports in a separate worker | In-process background job, file stored in the database for 7 days | Fine at your scale. Move to the worker and S3 in the production setup (doc 13). |
| Report performance at production volume | Every report finishes in under 3 s on test data | The Phase 8 load test (5× expected volume) covers this. |

## 4. ⚖ For your CA / legal advisor
- The E14 treatment above (repossession as custody; sale proceeds through the advance; surplus owed to the customer).
- Write-off policy: who may approve, and whether interest that fell due but was never collected should be reversed rather than written off.
- Recovery stages: which steps (notices, timelines) must happen before Repossession can be approved, under RBI fair-practice and recovery-agent guidelines. The software enforces only the order you configure.
- PAR 30 / PAR 90 as defined here (principal of loans more than 30 / 90 days past due).

## 5. How to try it
See [run-and-verify.md](run-and-verify.md). The fastest route is GitHub Codespaces → `pnpm demo`. The demo
data now includes seven recovery cases (opened automatically by the nightly job). One is in
Repossession with the vehicle in custody, and one write-off is waiting for approval.

Next: **Phase 8 — Security & hardening** (doc 15).
