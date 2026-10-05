# Go-live checklist

Tick each line with a name and date. Go live only when every **must** line is ticked. "Pilot"
means one branch running the system **alongside** the existing process for 2–4 weeks (doc 15), with
the daily comparison in *Pilot → Parallel run*. Every other branch starts only after the pilot
branch signs off.

## A. Professional sign-offs ⚖ (must)

| # | Decision | Who | Where it is described | Signed |
|---|---|---|---|---|
| A1 | Interest recognition basis: accrual on due date (D1) | CA | doc 07; Phase 3, 5 reports | |
| A2 | Interest split per installment for flat loans (straight-line vs rule of 78) and APR / KFS presentation | CA + legal | doc 06 | |
| A3 | GST on processing / documentation fees, bounce and penal charges | CA | doc 07; Phase 5 report | |
| A4 | Penal charges: wording, caps, never compounded; RBI fair-practice and penal-charges circular | Legal | doc 06; Phase 3 report | |
| A5 | Reminder timing, quiet hours and wording; the message limits | Legal | Phase 4 report | |
| A6 | KYC rule ("2 verified documents"), risk categories, Aadhaar handling (last 4 digits only, masked image) | Legal | docs 03, 11 | |
| A7 | Cash differences: recover from employee, write-off, excess to income; the ₹1,000 Management threshold; suspense ageing | CA | Phase 6 report | |
| A8 | Recovery stages and what must happen before Repossession can be approved (notices, timelines, recovery-agent conduct) | Legal | Phase 7 report | |
| A9 | E13 write-off policy and approvers; E14 sale treatment (custody, proceeds through the advance, surplus owed) | CA + Board | Phase 7 report | |
| A10 | Year-end closing entry; opening balances from the old system (E15, account 3900) | CA | Phase 5, 9 reports | |
| A11 | Retention: financial ≥ 8 years, KYC per PMLA; DPDP consent wording and breach procedure | Legal | docs 11, 14 | |
| A12 | Data residency: production, backups and DR in India (AWS Mumbai / Hyderabad) | Management | doc 13 | |
| A13 | CERT-In 6-hour reporting: who reports, contacts filled in the incident runbook | Legal + Management | runbooks/incident-response.md | |

## B. Security (must)

| # | Check | Signed |
|---|---|---|
| B1 | Third-party penetration test (CERT-In empanelled auditor ⚖) on staging; all high/critical findings fixed and re-tested | |
| B2 | OWASP ZAP baseline in CI is clean on staging | |
| B3 | Every user has their own account; Super Admin limited to two people; 2FA set up for Super Admin, Management, Accountants | |
| B4 | Production secrets only in AWS Secrets Manager; `DATA_ENCRYPTION_KEY` and `BLIND_INDEX_KEY` backed up separately (sealed envelope / second account) | |
| B5 | The application connects as `fin_app` (least privilege); `db:roles` applied; the owner password is held by two people | |
| B6 | ClamAV running and `CLAMAV_ADDRESS` set (production refuses to start without it) | |
| B7 | `APP_ORIGIN` is only the official address; HTTPS everywhere; HSTS on | |
| B8 | SMS (MSG91, DLT templates approved) and WhatsApp (Meta Cloud API, templates approved) credentials set; test message received | |

## C. Operations (must)

| # | Check | Signed |
|---|---|---|
| C1 | Backups: RDS PITR 35 days + AWS Backup plan + copies in the backup account | |
| C2 | Restore drill run on the production backup; "RESTORE VERIFIED"; time recorded vs the 4-hour target | |
| C3 | Nightly integrity check ran green for 7 consecutive days on staging | |
| C4 | Alerts reach a phone: API errors, integrity failure, backup failure, disk/CPU, uptime check | |
| C5 | Load test on staging hardware: payment p95 < 500 ms, search p95 < 300 ms at the expected customer count | |
| C6 | Runbooks read by the tech lead and branch support; contacts filled in | |
| C7 | Rollback plan: previous image tag noted; database snapshot taken just before go-live | |

## D. Data migration (must, per branch)

| # | Check | Signed |
|---|---|---|
| D1 | Customers imported (*Data migration*); rejected rows fixed and re-imported; count matches the old register | |
| D2 | Existing loans imported with installments already paid; **each loan's outstanding matches the old ledger** (spot-check 20 and all > ₹2 lakh) | |
| D3 | Opening balances (cash, bank, other accounts) posted by manual journal against 3900 and approved | |
| D4 | Trial balance on cut-over day agrees with the old books; the CA signs | |
| D5 | Collectors assigned; routes checked with the branch manager | |

## E. People (must)

| # | Check | Signed |
|---|---|---|
| E1 | Each role trained on the demo system (run-and-verify.md checklist) | |
| E2 | Collectors' phones: browser added to home screen, sign-in works on 4G in the field | |
| E3 | Branch knows the day-close routine and whom to call (runbooks/day-close-support.md) | |

## F. Pilot exit (per branch)

| # | Check | Signed |
|---|---|---|
| F1 | 10+ business days of parallel run with zero unexplained differences in collections and cash | |
| F2 | All days closed; all settlements matched or approved | |
| F3 | Branch manager and accountant sign that the system can replace the old process | |
| F4 | Management approves stopping the old process for this branch | |
