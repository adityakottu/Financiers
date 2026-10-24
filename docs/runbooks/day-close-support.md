# Runbook — Day-close support (for whoever answers the branch phone)

Every branch closes each business day once all collectors' cash is counted and any difference is
approved (*Reconciliation → Day close*). These are the questions you will get, and the answers.

| The branch says… | Why | What to do |
|---|---|---|
| "Close day is greyed out" | The yellow box lists what is left: *cash not counted*, *count again*, *difference not approved* | Work down the list. UPI and cheques in transit **never** block the close. |
| "It says *count again*" | Money moved after the cash was counted (a late payment or a deposit) | Count that collector's cash again. The new count replaces the old, and pending explanations are dropped. |
| "Difference not approved" | Someone explained a shortage or excess; a second person must approve it | Another manager (or Management if over ₹1,000) opens the collector → **Approve**, re-entering their password. The person who explained it cannot approve it. |
| "A collector is ₹50 short and the money is at home" | — | Choose **Pending deposit → carry forward**: no entry is posted, and tomorrow's expected cash includes it. |
| "I can't record a payment for yesterday" (*DAY_CLOSED*) | Yesterday is closed | Record it today; it is dated today. If it truly must be on the closed day, *Ask to reopen*; someone else approves. |
| "We need to reopen a closed day" | — | The branch manager clicks **Ask to reopen** with a reason. Another person with approval rights approves it. Close it again afterwards. |
| "UPI payment shows *not yet in bank*" | The bank statement hasn't been imported, or the UTR differs | The accountant imports today's statement (*Bank & UPI statements*). If the UTR was typed wrong, use *Resolve → match by hand*. Never mark it reconciled without the bank line. |
| "The statement import says rows are unreadable" | The file layout differs from the chosen preset | Try the bank's other export format, or adjust the column mapping. Unreadable rows are listed and are never imported silently. |
| "Changes are paused (*MAINTENANCE*)" | Maintenance mode is on | Only Head Office switches it off. Collect on paper receipts and enter them later. |
| "*Request origin not allowed*" | The app is being opened from an address the server doesn't know | Use the official address only. If it is official, the tech lead adds it to `APP_ORIGIN`. |

Escalate to the tech lead if:
- the *Integrity check failed* item appears in *Waiting for you*;
- a day cannot be closed after all counts are approved;
- figures on the dashboard and the reports disagree.
