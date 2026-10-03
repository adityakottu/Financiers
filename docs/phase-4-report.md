# Phase 4 Report — Collections

Status: **complete, awaiting your review.** Two items need professional
confirmation before go-live; they are marked ⚖ below.

## 1. What was built

### Recording a payment (the collector's 30-second flow)
| Capability | Notes |
|---|---|
| Collector day sheet (`/collect`, mobile-first) | Today's totals (collected, still due, cash in hand, UPI/bank/cheque), then customer cards sorted by days late. Each card has Collect, Call, Reminder SMS and Visit buttons. Tabs: to collect, collected, next 7 days, all. Collectors get a **Collect** tab in the mobile bottom bar. |
| Collect dialog | Quick amounts (overdue, overdue + today, next installment). A **live preview** says exactly what the money settles, e.g. "Clears installment 1, 2, 3. Balance after ₹34,653." Supports cash (field or branch counter), UPI, bank transfer (choose the company account) and cheque. Ends on a receipt screen with a PDF. |
| Allocation engine | A pure function in `packages/loan-engine` covering doc 08: installment-wise or component-wise; order penalty → fees → interest → principal (configurable per product); excess goes to advance or is refused. It passes the doc's worked examples and 500 random cases (sums exactly, never over-settles, independent of input order). |
| Never early income | Money paid ahead is held as **customer advance** (2200), not booked as interest. The nightly job applies it when the installment falls due. |
| Full settlement | Paying exactly the remaining balance closes the loan. The loan closure record and checklist are created, the asset is freed for future financing, and a closure SMS is sent. Paying more than the balance is refused, with the maximum shown. |
| Accounting (E4/E5) | Dr collector's **cash-in-hand** (1120-{employee}), branch cash, **UPI clearing** (1250-{branch}), the chosen bank, or cheques-in-hand. Cr penal / fees / interest / principal receivable, and customer advance. The entry is in the same transaction as the payment. |
| Receipts | Gapless `REC-{branch}-{FY}-NNNNNN`. A5 PDF with the amount in words (Indian system), what was paid, balance and next due, and a **QR code** to a public verification page that shows only what proves authenticity (masked name and loan number). |

### Safety
| Protection | How |
|---|---|
| Double taps and retries | Idempotency key per collect dialog. Five concurrent identical submits produce one payment (tested). |
| Possible duplicates | The same amount on the same loan within 30 minutes asks "Is this a second, separate payment?" before recording. |
| UTR / UPI transaction ID | Usable once (case-insensitive), enforced by a database index; tested under a race. |
| Concurrent payments on one loan | A row lock on the loan serialises them; installments are never over-settled (also a DB CHECK). |
| Permanence | The database refuses edits and deletes of payments (only workflow fields change), allocations and receipts. Allocations must add up to the payment, checked at commit. |
| Reversals | Requested with a reason, then **approved by a different person** (DB CHECK + API) after re-entering their password. The reversal posts an exact mirror entry, restores installments, cancels the receipt (the PDF is watermarked CANCELLED and the QR page says "cancelled"), reopens a loan the payment had closed, and first unwinds any advance applications that used the money. |

### Collections management
- **Assignment**: loans are assigned to collectors of the same branch, one at a time or in bulk, with history.
- **Team view (`/collections`)**: per collector it shows loans, overdue, due that day, cash/UPI/bank/cheque, visits and open promises, plus the count of unassigned loans and the reversal approval queue.
- **Installments due (`/installments`)**: by date range or all overdue, with the collector (or "Unassigned").
- **Visits and promises to pay**: outcomes are recorded on the loan. Each night, promises are marked kept, partial or broken from what was actually paid.
- **Payments & receipts (`/payments`)**: filters by date, method and status, totals by method, and a detail page with allocation, journal and reversal history.
- **Loan page**: Collect button, plus Payments and Collections tabs (collector, messages, visits, promises).
- **Dashboard**: real "Collected today" with the method split and reversals waiting.

### Messaging (official APIs only)
| Capability | Notes |
|---|---|
| Providers | **MSG91** SMS (Flow API with DLT template IDs) and the **Meta WhatsApp Business Cloud API** (approved templates). There is no unofficial automation, and collectors' reminder buttons go through these APIs, not personal WhatsApp. Without credentials the system runs in **test mode**: messages are prepared and logged as "Not sent (test mode)", never shown as sent. |
| Consent | WhatsApp is used only for customers who opted in. Skipped messages are logged with the reason, never silently dropped. |
| Events | Payment received, receipt cancelled, loan disbursed, loan closed, due reminder and overdue notice. |
| Reminder rules | −3, −1, 0, +1, +7, +15 and +30 days; each can be switched on or off. Each rule fires once per installment. Reminders are sent only between **09:00 and 20:00 IST**. ⚖ |
| Queue | Messages commit with the business change. The relay retries with backoff (up to 5 attempts), uses SKIP LOCKED so several servers can run it, and marks an interrupted send as failed with an explanation rather than risk a duplicate. |
| Delivery webhooks | WhatsApp requires the **X-Hub-Signature-256** HMAC over the raw body. MSG91 requires a shared token. Status only ever moves forward. Webhooks that aren't configured answer 404. |
| Limits | At most 3 manual messages per loan per day. ⚖ |
| Templates screen | Edits may only use the event's placeholders. The screen reminds users that SMS text must match the DLT registration exactly. |

## 2. How it was tested

| Suite | Count | What it proves |
|---|---|---|
| Allocation engine | 12 (+500 random cases) | Doc 08 examples a–e, custom order, fees, REJECT mode, invalid amounts and rules, properties |
| Loan engine (Phase 3) | 19 | Unchanged, all pass |
| API integration | 144 (33 new) | Assignment rules and scope; preview vs record; journal lines per method; advance instead of early income; full settlement and closure; REJECT products; idempotency under 5 concurrent submits; duplicate warning; UTR race; 4 concurrent payments on one loan; DB refuses edits/deletes; allocations must sum; receipt PDF and public verification; amounts in words; two-person reversal with step-up; reopening a closed loan; unwinding an applied advance; promises kept/broken; my-day vs team totals; consent and test mode; manual-send limit; reminder dedupe; template placeholders; MSG91 and Meta payload formats and error classes; webhook signatures. **After every flow the ledger is checked against the loan's own figures** (principal, accrued interest, penal, advance) and the trial balance. |
| Browser (Playwright: iPhone 13, desktop, Pixel 7) | 13 steps | Collector collects cash from the bottom-nav Collect tab, sees the receipt and PDF, is warned on a repeat amount, records a promise and sends a reminder. Manager sees dashboard and team totals, approves the pending reversal through the step-up dialog, browses payments, collects by UPI from the loan page, and checks installments and communications. The QR verification page works without sign-in and rejects bad tokens. No page errors and no horizontal overflow. |

**Total: 190 automated tests, all passing**, plus the browser run.

### Defects found and fixed during Phase 4
1. The "installments cleared" summary missed fully paid installments (found by the first test run).
2. Demo seed: branches inserted directly had no cash, cheque or UPI-clearing accounts. The seed now creates them, and recording a payment creates a missing standard branch account instead of failing.
3. Bank accounts of kind "UPI settlement" were classed as UPI clearing and could appear as disbursement sources next to the new internal clearing accounts. They are now bank accounts; clearing accounts are internal only.
4. The collector's day sheet counted "still due" and "pending" on different bases. The labels now say what each number means.

## 3. Deviations from the plan

| Planned | Built | Reason |
|---|---|---|
| Backdated payments (`payment.backdate`) with penalty re-evaluation | **Not allowed**: value date is always today | Re-evaluating penalties already assessed needs business-day locks (Phase 6). This avoids silent penalty errors meanwhile. |
| Separate `/m` mobile app | **Same app, mobile-first `/collect` page** with a collector bottom tab | One codebase, the same security, nothing extra to deploy. |
| Notification centre v1 | Moved to Phase 7 | Messages, the reversal queue and dashboard alerts cover the need for now. |
| Cheque deposit, clearing and bounce | Cheques are recorded (status RECEIVED, held in cheques-in-hand) | Deposit, clearing and bounce are Phase 5 (cheque lifecycle, E8). |
| Receipt in ₹ symbol | Still "Rs." in PDFs | Needs an embedded font; carried to Phase 7 with the report exports. |

## 4. ⚖ For professional review
- **Full settlement charges the remaining scheduled dues.** For reducing-balance (EMI) loans this includes future interest. RBI fair-practice expectations on foreclosure need confirming. A foreclosure quote with interest rebate is planned for Phase 7.
- Reminder timing (09:00–20:00), frequency (rules and the 3-per-day manual limit) and template wording should be checked against RBI recovery guidelines and your DLT registrations.

## 5. Remaining work carried forward
- Refunding an advance left over at closure (shown on the loan as owed to the customer). This will be a payment-out in Phase 5.
- Employee cash settlement, deposits and bank matching are Phase 5/6 (cash-in-hand already accumulates per collector in 1120-{employee}).
- Collection targets, recovery cases and repossession (Phase 7).

## 6. How to try it
`pnpm --filter @fin/api db:seed:demo` now also assigns the Kakinada loans to
`collector.kkd`, records the day's payments, a pending reversal, a visit and a promise.
Sign in as `collector.kkd` on a phone to see the day sheet, and as `manager.kkd`
to approve the reversal.

Next: **Phase 5 — Accounting** (expenses, deposits, cheque lifecycle, manual
journals, books, P&L, balance sheet, period locks).
