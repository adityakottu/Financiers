# Runbook — Restore from backup / disaster recovery

Targets (doc 14): lose at most **5 minutes** of data (RPO); be back within **4 hours** in-region,
**8 hours** cross-region (RTO). Practise this quarterly; the weekly restore drill (below) proves the
backups work.

## Decide

| Situation | Do |
|---|---|
| A bad change (wrong bulk update, bad migration), service otherwise fine | §1 point-in-time restore beside production, repair forward |
| Database lost or corrupted | §2 full restore |
| AWS Mumbai region down | §3 cross-region |

Who decides: Management + tech lead (doc 14 §5). Record the decision time; that's when the RTO
clock starts.

## 0. Freeze

Switch on **maintenance mode**, so nothing new is written while you work (Admin → System health, or
`MAINTENANCE_MODE=true` and restart). Tell branches: collect on paper receipts *with the receipt
book numbers noted*, and enter them when the system is back. Idempotency protects anything a
phone retries.

## 1. Point-in-time restore (bad change)

1. AWS console → RDS → the production database → **Restore to point in time** → a time **one minute
   before** the bad change (find it in the audit log) → new instance `financiers-pitr-<date>`.
   Single server: restore the last nightly dump into a new database:
   `createdb financiers_pitr && pg_restore --no-owner -d financiers_pitr /backups/<file>.dump`
   (granularity is then the nightly dump, not minutes).
2. Run the checks on the restored copy:
   `DATABASE_URL=postgresql://…/financiers_pitr pnpm --filter @fin/api db:verify`
3. Compare the affected tables between the copy and production. Decide with the accountant:
   - **Repair forward (preferred):** post approved correction journals or reversals in production,
     with the incident reference as the reason. Financial history is never silently overwritten.
   - **Repoint:** only if production is unusable. Follow §2 with the restored instance as the new
     database. Everything after the restore time must then be re-entered (step 2.5).
4. Integrity checks on production, then maintenance off.

## 2. Full restore

1. Restore the latest point-in-time backup into a new instance (AWS) or the latest dump into a
   new database (single server). Use the **backup account** copy if the production account may be
   compromised.
2. Point the application at it: update the `DATABASE_URL` secret and redeploy (AWS ECS: force a new
   deployment; single server: edit `.env`, then `docker compose up -d`).
3. Re-create the least-privilege roles if they are not already in the instance:
   `pnpm --filter @fin/api db:roles`, then set their passwords from Secrets Manager.
4. `pnpm --filter @fin/api db:verify` → all checks pass.
5. **Close the gap.** Payments made between the backup time and the outage exist on customers'
   SMS / WhatsApp receipts, the provider's delivery logs and the paper receipts. Compare them to
   the restored *Payments register*. Re-enter missing ones with their original reference and date.
   The accountant signs off each branch.
6. Maintenance off. Announce. Watch the next nightly integrity run.

## 3. Region outage (cross-region)

1. In the DR account / region (ap-south-2): restore the latest cross-region snapshot copy
   (Terraform `infra/terraform` with `region = "ap-south-2"`, `restore_snapshot = <arn>`).
2. Promote the S3 replica bucket for documents, and replicate secrets.
3. Point DNS at the DR load balancer (Route 53 failover record, or change the CNAME).
4. Then §2 steps 3–6.

## Weekly restore drill (automated)

`scripts/restore-drill.sh` takes the newest backup, restores it into a scratch database, runs every
integrity check, compares row counts and drops the scratch database. It exits non-zero if anything
fails. The scheduled workflow / cron runs it weekly. Review the result every Monday.
```bash
DATABASE_URL=postgresql://owner@host/financiers scripts/restore-drill.sh              # fresh dump
DATABASE_URL=postgresql://owner@host/financiers scripts/restore-drill.sh last.dump    # a given backup
```
Record the "Restore took …" time each quarter against the 4-hour target.
