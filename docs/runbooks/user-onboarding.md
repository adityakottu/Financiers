# Runbook — Adding, changing and removing users

Admin → **Employees** (the person) and **Users & access** (their sign-in). Collectors need both,
linked, so their cash and collections are tracked against them.

## Which role

| Job | Role | Scope | 2FA |
|---|---|---|---|
| Owner / MD (also IT admin) | Super Admin. Keep it to **two** people. | All branches | Required |
| Head office management | Management | All branches | Required |
| Branch manager | Branch Manager | Their branch(es) | Optional (recommended) |
| Accountant | Accountant | Their branch(es) | Required |
| Field collector | Collection Employee | Loans assigned to them | Optional |

Don't give anyone two roles to "save time". The two-person approvals depend on different people.

## Add

1. **Employees → New**: name, code, branch, mobile, *is collector* if they collect.
2. **Users & access → New user**: username, email / mobile, role, branches, and link the employee.
   They get a temporary password and must change it at first sign-in. Roles needing 2FA set up an
   authenticator app at first sign-in. Install one (Google Authenticator, Microsoft
   Authenticator) on *their own* phone.
3. Collectors: **Collections → Assign** the loans of their route.
4. Show them the [run-and-verify](../run-and-verify.md) checklist for their role on the training
   (demo) system first.

## Change

- **New branch / role:** *Users & access → Access*. A role change takes effect on the next request
  and needs your password again.
- **Forgot password:** *Reset link*, sent through the registered channel. All their sessions end.
- **Lost phone with the authenticator:** *Reset 2FA*. They set it up again at next sign-in.
  Check it is really them (call them back on the registered number) before resetting.
- **Locked out:** after 5 wrong passwords the account locks for 15 minutes, doubling each time.
  *Unlock* only after confirming it was them.

## Remove (same day they leave)

1. **Disable** the user. All their sessions end immediately; history stays, attributed to them.
2. Collectors: *Collections → Assign* their loans to someone else, and change the owner of their open
   *Recovery* cases.
3. Count and settle their cash (*Reconciliation*) before their last day. A disabled collector's
   cash account must reach zero.
4. Never delete a user or reuse their username. The audit trail needs to keep pointing at the
   right person.

## Quarterly access review

Management exports *Users & access* and confirms, per person: still employed, right role, right
branches. Disable anyone unconfirmed. Keep the signed list with the audit file.
