# 14 — Backup & Disaster Recovery Plan

## 1. Objectives

| Metric | Target |
|---|---|
| **RPO** (max data loss) | ≤ 5 minutes (PITR from WAL) |
| **RTO** (time to restore service) | ≤ 4 hours in-region; ≤ 8 hours cross-region |
| Retention | Daily 35 days · Weekly 12 weeks · Monthly 12 months · Yearly (FY end) 8+ years ⚖ |

## 2. What is backed up

| Asset | Method | Location |
|---|---|---|
| PostgreSQL | RDS automated backups + PITR (35 days); AWS Backup daily/weekly/monthly plans | ap-south-1 + copy to ap-south-2; copies in separate **backup AWS account** |
| PostgreSQL logical | Nightly `pg_dump` (custom format, encrypted) of full DB | S3 backup account, Object Lock (compliance mode) |
| Documents / receipts / exports (S3) | Versioning + Cross-Region Replication + Object Lock on KYC/receipt prefixes | ap-south-2 |
| Audit chain heads | Daily export | S3 Object Lock (WORM) |
| Config & IaC | Git (Terraform) | GitHub + mirror |
| Secrets | Secrets Manager replication | ap-south-2 |
| Redis | Not backed up (cache/queue only; outbox in PG guarantees resend) | — |

Backups are encrypted with KMS keys in the backup account; production
credentials cannot delete backups (separation against ransomware/insider).

## 3. Restore procedures

### 3.1 Accidental data change (e.g. bad migration)
1. Freeze writes (maintenance mode flag → API returns 503 for mutating routes).
2. PITR restore to new instance at T − 1 min before incident.
3. Diff affected tables between restored and live; decide: repoint or
   forward-fix via approved correction journals (never silent overwrite of
   financial history — reconstructed changes must themselves be audited).
4. Verify: ledger integrity job, trial balance, audit chain.
5. Unfreeze; incident report.

### 3.2 Full region outage
1. Declare DR (Management + tech lead).
2. Restore latest cross-region snapshot/PITR copy in ap-south-2 via Terraform DR workspace.
3. Promote S3 replica buckets; switch DNS (Route 53 failover).
4. Run integrity checks; announce; collectors resume (idempotency protects any
   retried in-flight payments).
5. Reconcile the gap window: compare last known receipts sent (SMS/WA logs at
   provider) against restored payments; re-enter missing ones with original
   references via an approved backfill workflow.

## 4. Verification

- **Weekly automated restore test:** latest snapshot → scratch instance → run
  migrations check, ledger integrity, trial balance, row counts vs production
  metrics → report to Slack/email → destroy.
- **Quarterly DR drill:** full cross-region restore with timing recorded vs RTO.
- Backup job failures page on-call immediately.

## 5. Responsibilities

| Task | Owner |
|---|---|
| Backup configuration & monitoring | DevOps / tech lead |
| Weekly restore report review | Tech lead |
| DR declaration | Management + tech lead |
| Post-restore financial verification | Accountant |
| Retention policy sign-off | CA / compliance ⚖ |
