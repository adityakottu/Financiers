# Phase 9 Report — Data migration & pilot readiness

Status: **complete, awaiting your review.** Items marked ⚖ need your CA's or legal advisor's confirmation.

The roadmap (doc 15) ends with "Pilot & rollout". Phase 9 builds what the pilot needs from the software. It brings customers and running loans over from the old system with opening balances that tie to the ledger. It also compares the old process with the app every day of the pilot.

## 1. What was built

| Area | What it does |
|---|---|
| **Templates** (*Data migration*) | Excel templates for customers, running loans and the pilot day sheet, each with a *How to fill* sheet: every column, whether it is required, and an example. The cells are text, so Excel cannot turn numbers into dates or drop leading zeros. |
| **Customer import** | Each row is checked by the same rules as the customer form: mobile, dates, pincode, branch, S/O–W/O, WhatsApp consent. It also catches duplicate legacy numbers in the file or already imported, and a customer with the same name and mobile who is already in the app. **Errors are listed per row and column and can be downloaded as Excel.** Customers come in with KYC *pending*. **A column for Aadhaar, PAN, voter ID or any other ID number is refused outright**: ID numbers are never bulk-loaded, and KYC is collected in the app (doc 11). |
| **Running-loan import** (E15 ⚖) | Each loan is created on the **product's real schedule** (same engine as a new loan). The installments paid by the cut-over date are marked paid, and a part payment on the next one is split fees → interest → principal. **The app's principal outstanding must equal the old ledger's figure, or the row is refused with both numbers shown.** An optional installment amount is checked the same way. It then posts **E15** — *Dr 1310 principal, 1320 interest already due, 1330 fees, 1340 penal / Cr 3900 Opening Balance Equity* — for exactly what is outstanding, dated the cut-over day. Interest already due is in the opening balance and is never accrued again; later installments accrue as usual. No disbursement entry is posted, because that money left in the old books. |
| **Checking = doing, then rolling back** | Loan files are checked by **creating every loan for real inside a database transaction that is then rolled back**. The checks are exactly those the import will run: product limits, LTV, duplicate vehicles, schedule, balances, closed periods. Nothing is left behind, and the dry run consumes no loan, asset or journal numbers. |
| **Four eyes, all or nothing** | The upload creates nothing. **A different person** with *confirm imports* (Management) confirms with **password step-up**, and the same work then runs for real in **one transaction**. If anything changed meanwhile, nothing is imported and the row is named. **Loan files import only when every row is valid.** Customer files may leave out rows with errors only if the confirmer ticks that they accept it, and those rows stay listed. The same file cannot be imported twice. On each migrated loan the uploader is recorded as the maker and the confirmer as the approver. |
| **Legacy numbers** | Customers and loans keep their old-system number. **Global search finds them by it exactly**, and it shows on the loan and customer pages. |
| **Pilot comparison** (*Pilot comparison*) | Each pilot day, the old process's day sheet (loan, amount, method, its receipt number) is uploaded and compared with the app **loan by loan and method by method**. It shows matches, amount and method differences, payments only in the old sheet or only in the app, loans the app doesn't know, and totals per method. A bad sheet is refused whole, never half-loaded. **Sign-off needs the day closed in the app, and a written explanation if anything differs.** The comparison is then frozen and the day can't be replaced. The page shows progress towards the pilot exit (checklist F1: 10+ business days). |
| **Waiting for you** | New items: *Migration imports to confirm* (Management) and *Parallel-run days to sign off* (branch). |
| **Go-live checklist** | Section D (data migration) and F (pilot exit) now point to these pages. |

### How to migrate a branch
1. **Products:** make sure a product exists whose limits fit the old loans (rate, tenure, amount, method). A *LEGACY* product per category is the simplest.
2. **Customers:** download the template, fill it from the old register, upload, fix the listed rows, and upload again. Management confirms.
3. **Running loans:** choose the **cut-over date**: the last day the old books are complete, usually the evening before go-live. Fill one row per running loan, with the installments fully paid by that date, any part payment and the old ledger's principal outstanding. Upload; where the app's figure differs, the row says by how much, so check the rate, method or paid count. Management confirms.
4. **Other opening balances:** post cash, bank, deposits and other accounts by **manual journal against 3900** (two accountants), dated the cut-over day.
5. **Check:** the trial balance on the cut-over day against the old books; 3900 equals the old net worth of what was brought over. The CA signs (checklist D4 ⚖). *System health → Run now* must be green.
6. **Pilot:** every day, upload the old day sheet in *Pilot comparison*, explain any difference, close the day, and sign off.

## 2. How it was tested

| Suite | Count |
|---|---|
| Money, contracts, loan engine | 46 |
| API integration (real PostgreSQL, as `fin_app`) | **216** (8 new) |
| Browser (Playwright) | Phase 9 flow, below |

New API tests (`src/imports/imports.int.test.ts`):
- **Templates** are workbooks with the columns and a how-to sheet, with no ID-number columns. A collector cannot download them.
- **Customers:** 5 rows → 2 valid, 3 with errors (bad mobile, impossible date 31/02, duplicate legacy number, unknown branch, bad Y/N), each tied to its row and column. Nothing is created by the upload, and the errors Excel has one line per error. The uploader cannot confirm, and step-up is required. Errors must be accepted explicitly. After confirmation exactly 2 customers exist, with legacy numbers, and search finds them. Re-uploading the same file is refused, and so is confirming twice. Exactly one audit entry is written for the upload and one for the confirmation.
- **ID numbers:** an `aadhaar_no` column is refused with an explanation; a file without required columns is refused.
- **Four eyes:** even a Super Admin cannot confirm their own upload. A cancelled batch keeps no row data.
- **Loans, refused rows:** wrong outstanding (the app's figure is reported), unknown customer, disbursed on the cut-over day, and an installment that differs from the app's. **The dry run leaves no loans, assets or numbers behind.**
- **Loans, clean file confirmed:** the confirmed totals equal the validated totals. Loans are ACTIVE with the legacy number and cut-over date, the uploader as maker and the confirmer as approver. Paid installments are PAID and the part payment is applied. **Interest due by the cut-over is never accrued again.** Per loan, the ledger 1310 / 1320 / 1340 equals the loan's balances. The only journal entry is the OPENING entry, dated the cut-over. The penal charge is on the overdue installment. **3900 rises by exactly the opening total.** A payment afterwards works, and **every integrity check passes.** A file containing an already-imported loan is refused.
- **Cut-over:** missing or future dates are refused.
- **Pilot:** a collector cannot upload. A sheet with bad rows is refused whole, with each problem listed. The comparison of matched, only-in-old and unknown loans and per-method totals is checked. **Another branch's manager cannot see the day.** Sign-off is refused without a note when there are differences, and refused while the day is open. After sign-off the comparison is frozen, re-upload is refused, and the exit counter shows 1 explained day.

**Browser (desktop + Pixel 7):** the manager downloads the template and uploads customers, sees the errors, and gets no confirm button on their own upload. The admin sees the item in *Waiting for you* and confirms with 2FA step-up. The manager's first loan upload shows the app's outstanding; a corrected file shows the opening balances, and the admin confirms them. On the phone, the manager compares a day sheet: unknown loan listed, only-in-old shown, sign-off asks for an explanation, no horizontal overflow.

**Total: 262 automated tests, all passing.**

### Defects found and fixed during Phase 9
1. The ID-number column check missed the common spelling "aadhaar" (found by the test); it now catches *aadhar / aadhaar / adhar*, PAN, voter ID, licence, passport and KYC.

## 3. Deviations and deferrals

| Planned | Status | Why |
|---|---|---|
| Asset-only import (doc 15 lists "assets") | Assets come in **with their loan** (asset columns on the loan row) | An asset without a loan has nothing to secure; closed loans are not migrated. |
| Closed loans and old payment history | **Not imported**; only running loans and their position at the cut-over | History stays in the old system (keep it read-only for the retention period ⚖). Importing it would double-count income that the old books already hold. |
| Per-installment payment dates from the old system | Paid installments are dated their due date (or the cut-over, if earlier) | The old system's exact dates rarely exist per installment; the loan's timeline records that it was brought over. |
| Opening cash / bank / other balances | By **manual journal** (existing two-accountant flow) | Few lines per branch; a manual journal shows the CA exactly what was posted. |
| KYC documents | Collected in the app after migration | ID numbers are never bulk-loaded (doc 11). |
| Refund of a customer's surplus (from Phase 7) | Still not built | Needed before the first sale surplus is paid out; not blocking the pilot. |

## 4. ⚖ For your CA / legal advisor
- **E15:** opening balances posted to 3900 *Opening Balance Equity*, per loan. Interest already due at the cut-over is included as receivable; future interest is not. The CA should clear 3900 against the old books' capital and reserves once everything is brought over (checklist A10, D4).
- Whether penal charges outstanding in the old system may be carried over and collected (and how they were disclosed to the customer).
- WhatsApp consent: import *Y* only where the customer's written consent exists.
- Retention of the old system's records after go-live.

## 5. How to try it
`pnpm demo`, then sign in as `manager.kkd` → **Data migration**: download the customers template, add two rows (branch KKD), upload. Sign in as the admin → *Waiting for you* → confirm with 2FA. Then upload a running-loan row for one of those customers (product `TW-STD`). The first attempt shows the app's principal outstanding to copy into the file. **Pilot comparison**: upload a day sheet (template on the page) for today.

Next: **Phase 10 — Production deployment** (doc 13).
