# 05 — Roles & Permission Matrix

## 1. Model

- **Permission** = `module.action` string (e.g. `payment.create`). Code checks
  permissions, never role names.
- **Role** = named bundle of permissions. Five system roles are seeded; Super Admin
  can create custom roles (e.g. "Senior Collector").
- **Overrides** = per-user ALLOW/DENY on top of roles (e.g. grant one Management
  user `settings.sms.manage`). DENY wins.
- **Scope** = what rows a permission applies to:
  - `ALL` — all branches (Super Admin, Management)
  - `BRANCH` — branches in `user_branches` (Manager, Accountant)
  - `ASSIGNED` — loans currently assigned to the employee (Collector)
  - `OWN` — records created by the user (e.g. own expenses)
- **Separation of duties** (enforced in code, not just UI):
  - Requester ≠ approver for reversals, adjustments, write-offs, day reopen, manual journals.
  - A collector's own settlement cannot be verified or approved by that collector.
  - A user cannot change their own roles/permissions.
- **Step-up auth**: permission-changing, reversal-approval, period-unlock and
  provider-credential actions require re-entering password/TOTP within 5 minutes.

## 2. Matrix

Legend: ✅ allowed · 🔷 own branch(es) · 👤 assigned/own only · 🅰 needs approval by another user · ⚙ only if explicitly granted · — denied

### Platform & admin

| Permission | Super Admin | Management | Branch Mgr | Accountant | Collector |
|---|---|---|---|---|---|
| user.manage (create/edit/disable) | ✅ | — | — | — | — |
| role.manage / permission.assign | ✅ | — | — | — | — |
| branch.manage | ✅ | — | — | — | — |
| settings.company | ✅ | ⚙ | — | — | — |
| settings.numbering | ✅ | — | — | — | — |
| settings.sms / settings.whatsapp (providers, credentials) | ✅ | ⚙ | — | — | — |
| template.manage (SMS/WA templates) | ✅ | ⚙ | — | — | — |
| reminder_rule.manage | ✅ | ⚙ | — | — | — |
| product.manage (loan products, allocation rules) | ✅ | ⚙ | — | — | — |
| coa.manage (chart of accounts) | ✅ | — | — | ⚙ | — |
| audit.view | ✅ | ✅ | 🔷 (branch actions) | 🔷 financial only | — |
| session.manage_others (force logout) | ✅ | — | — | — | — |
| import.run | ✅ | — | 🔷 customers/assets | 🔷 opening balances | — |

### Customers & lending

| Permission | Super Admin | Management | Branch Mgr | Accountant | Collector |
|---|---|---|---|---|---|
| customer.view | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| customer.create / edit | ✅ | — | 🔷 | — | — |
| customer.view_contact (unmasked mobile) | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| kyc.view_masked | ✅ | ✅ | 🔷 | 🔷 | — |
| kyc.reveal (full PAN/DL; logged) | ✅ | ⚙ | 🔷 | — | — |
| document.upload | ✅ | — | 🔷 | 🔷 (expense) | 👤 (visit photo) |
| document.view_kyc | ✅ | ✅ | 🔷 | — | — |
| search.global | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| loan.view | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| loan.create (draft) | ✅ | — | 🔷 | — | — |
| loan.approve | ✅ | ✅ | 🔷 ≤ threshold | — | — |
| loan.disburse | ✅ | — | 🔷 | 🔷 | — |
| loan.edit_terms (post-disbursal) | — (reschedule only) | — | — | — | — |
| loan.reschedule | 🅰 | 🅰 | 🔷🅰 (request) | — | — |
| loan.waive (penalty/fee) | 🅰 | 🅰 | 🔷🅰 ≤ limit | — | — |
| loan.close / foreclose | ✅ | ✅ | 🔷 | 🔷 | — |
| loan.write_off | 🅰 | 🅰 | — | — | — |
| asset.view / edit | ✅ | ✅ view | 🔷 | 🔷 view | 👤 view |
| asset.status_change (repossess/release/sell) | 🅰 | 🅰 | 🔷🅰 | — | — |
| recovery.manage | ✅ | ✅ | 🔷 | — | 👤 notes/visits |
| statement.generate | ✅ | ✅ | 🔷 | 🔷 | 👤 (send only) |

### Collections

| Permission | Super Admin | Management | Branch Mgr | Accountant | Collector |
|---|---|---|---|---|---|
| assignment.manage | ✅ | ✅ | 🔷 | — | — |
| target.manage | ✅ | ✅ | 🔷 | — | — |
| payment.create | ✅ | — | 🔷 | 🔷 | 👤 |
| payment.view | ✅ | ✅ | 🔷 | 🔷 | 👤 (own collections) |
| payment.edit | — | — | — | — | — |
| payment.delete | — | — | — | — | — |
| payment.reversal.request | ✅ | ✅ | 🔷 | 🔷 | — |
| payment.reversal.approve | 🅰 | 🅰 | 🔷🅰 | 🔷🅰 | — |
| receipt.view / download | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| message.send (SMS/WA manual) | ✅ | ✅ | 🔷 | 🔷 | 👤 |
| visit.record / ptp.record | ✅ | — | 🔷 | — | 👤 |
| cheque.update_status | ✅ | — | 🔷 | 🔷 | — |

`payment.edit` and `payment.delete` exist only so they can be **denied to
everyone**; the only correction path is reversal + new payment.

### Accounting & reconciliation

| Permission | Super Admin | Management | Branch Mgr | Accountant | Collector |
|---|---|---|---|---|---|
| ledger.view | ✅ | ✅ | 🔷 | 🔷 | — |
| journal.manual.create | 🅰 | — | — | 🔷🅰 | — |
| journal.manual.approve | 🅰 | 🅰 | — | 🔷🅰 | — |
| expense.create | ✅ | — | 🔷 | 🔷 | 👤 (own, cash) |
| expense.approve | ✅ | ✅ | 🔷 ≤ limit | 🔷 (final) | — |
| cash_bank.manage (accounts) | ✅ | — | — | 🔷 | — |
| deposit.record | ✅ | — | 🔷 | 🔷 | 👤 (declare) |
| deposit.verify | ✅ | — | 🔷 | 🔷 | — |
| bank_statement.import / match | ✅ | — | — | 🔷 | — |
| settlement.submit | — | — | — | — | 👤 |
| settlement.verify | ✅ | — | 🔷 | 🔷 | — |
| settlement.approve / difference.approve | ✅ | ✅ | 🔷 | — | — |
| day.close | ✅ | ✅ | 🔷 | — | — |
| day.reopen | 🅰 | 🅰 | — | — | — |
| period.lock | ✅ | ✅ | — | ✅ (soft lock) | — |
| period.unlock | 🅰 | 🅰 | — | — | — |

### Reports & exports

| Permission | Super Admin | Management | Branch Mgr | Accountant | Collector |
|---|---|---|---|---|---|
| dashboard.company | ✅ | ✅ | — | — | — |
| dashboard.branch | ✅ | ✅ | 🔷 | 🔷 | — |
| dashboard.collector | ✅ | ✅ | 🔷 | — | 👤 |
| report.loan | ✅ | ✅ | 🔷 | 🔷 | — |
| report.collection | ✅ | ✅ | 🔷 | 🔷 | 👤 own |
| report.accounting | ✅ | ✅ | 🔷 (view) | 🔷 | — |
| report.reconciliation | ✅ | ✅ | 🔷 | 🔷 | 👤 own |
| export.excel / export.pdf | ✅ | ✅ | 🔷 | 🔷 | — |
| export.pii (unmasked in export) | ⚙ | — | — | — | — |

Every export is audited (who, which report, filters, row count).

## 3. Enforcement points

1. **API guard** — `@Require('payment.create', { scope: 'ASSIGNED' })` on each
   handler; a route without a `@Require` fails CI (lint rule).
2. **Service layer** — scope filter applied to every query via a repository
   helper (`scoped(user).loans()`), so list endpoints can't leak rows.
3. **Database RLS** — branch filter as defence in depth.
4. **UI** — hides what the user can't do (convenience only; never trusted).

## 4. Required negative tests (see doc 12)

For each ❌/— cell above involving money, KYC or permissions, an integration test
asserts `403` and **no row change and no audit "success" entry**. In particular:
collector modifying payment, collector viewing unassigned customer, accountant
changing interest, manager approving own reversal, anyone deleting a payment,
anyone changing own role.
