# Runbook — Security or data incident

Use this when something may have exposed, changed or destroyed data. Examples: a lost collector
phone that was signed in, a staff member suspected of fraud, an *Integrity check failed* alert, a
leaked password, or unexplained changes. When unsure, treat it as an incident; standing down costs
nothing.

Roles: **Incident lead**, a Management person who decides. **Tech lead**, who runs the commands.
**Accountant**, who checks the money. Keep a timeline as you go (time, what was seen, what was done).

## First 15 minutes

1. **Contain without destroying evidence.**
   - **One person's account:** Admin → *Users & access* → the user → **Disable**, then **Sign out
     everywhere**. Disabling ends every session at once; nothing they did is deleted.
   - **Lost or stolen phone:** do the same for that collector, then reset their password and 2FA
     (*Reset 2FA*). Their unsynced work is not at risk: payments exist only once the server
     confirmed them.
   - **Wider or unclear:** switch on **maintenance mode** (Admin → System health, or
     `PUT /api/v1/system/maintenance {"enabled": true}` with step-up). Every change is refused,
     reading continues. If the application itself is suspect, set `MAINTENANCE_MODE=true` in the
     environment and restart; then it cannot be switched off from inside the app.
2. **Preserve evidence.** Nothing in the audit trail, journal or payments can be edited or deleted
   by the application, but take copies anyway:
   - `pnpm --filter @fin/api db:verify` (integrity checks; save the output);
   - a database snapshot (AWS: *RDS → Take snapshot*; single server: `scripts/backup.sh`);
   - application logs for the period (CloudWatch → export to S3 / `docker compose logs > file`).
3. **Tell the incident lead.** Decide the severity:

| Severity | Examples | Who to tell |
|---|---|---|
| **S1** | Customer data copied out; money moved without authority; database tampering (audit chain broken) | Management immediately; **CERT-In within 6 hours** if reportable ⚖; **Data Protection Board / affected customers** per DPDP Act ⚖; your auditor |
| **S2** | One account misused, contained, no customer data out; integrity check failed with a known cause | Management same day |
| **S3** | Suspicious sign-ins blocked by lockout; a failed scan of an upload | Weekly review |

⚖ CERT-In (Directions of 28 April 2022) requires reporting certain incidents within 6 hours of
noticing them. The DPDP Act 2023 requires notifying the Board and affected people of a personal data
breach. Agree with your legal advisor, **before go-live**, who reports and how. Keep their contacts in
the table at the end.

## Investigate

- **Who did what:** *Audit log*, filtered by user and dates. Every payment, reversal, approval,
  KYC reveal, export and sign-in is there with IP and device.
- **Is the money right:** run the integrity checks (`db:verify` or Admin → System health → Run now). Then the
  *Trial balance* report, and for each branch involved the *Cash & bank book* and *Payments
  register* for the days concerned.
- **Has history been altered:** `AUDIT_CHAIN` failing means someone changed the audit table by going
  around the application (database access). The check names the first altered record. Treat it as S1.
- **Collector fraud** (e.g. receipts not matching cash): compare the *Payments register*, *Employee
  cash settlement* report and customer SMS receipts. Receipts go to customers automatically, so
  ask customers.

## Recover

- Wrong postings are **never deleted**. Correct them with reversals and approved manual journals,
  each with a reason. That keeps the correction itself visible.
- If data must be restored from backup, follow [disaster-recovery.md](disaster-recovery.md).
- Rotate any secret that may have leaked: database passwords, `DATA_ENCRYPTION_KEY` (needs a re-encrypt
  plan), and the SMS / WhatsApp tokens. Then force sign-out for all users.
- Switch maintenance mode off only after the integrity checks pass.

## Afterwards (within 5 working days)

Write a short report: what happened, timeline, impact (customers, amounts), root cause, what is
changed to prevent it, and who was notified when. File it with the audit-log export.

## Contacts (fill in before go-live)

| Who | Name | Phone | Email |
|---|---|---|---|
| Incident lead (Management) | | | |
| Tech lead | | | |
| Accountant | | | |
| Legal advisor ⚖ | | | |
| CERT-In | incident@cert-in.org.in | +91-11-24368572 | |
| Hosting support (AWS) | | | |
