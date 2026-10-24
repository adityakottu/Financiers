# Deploying Financiers

Two supported ways to run it in production, both in India (doc 13 ⚖ D6):

| | **A. AWS (recommended)** | **B. Single server (pilot)** |
|---|---|---|
| What | ECS Fargate, RDS PostgreSQL Multi-AZ, S3, WAF, ALB — `infra/terraform` | One Linux server with Docker — `deploy/compose` |
| Scale | ~10 branches and up; zero-downtime rolling deploys | One pilot branch, a few dozen users |
| Backups | RDS PITR 35 days + AWS Backup (copy in Hyderabad) + nightly `pg_dump` to an Object-Lock bucket + weekly restore drill | Nightly `pg_dump` to S3 (preferred) or a local volume; managed RDS still strongly advised |
| Cost (indicative) | ₹35k–60k / month | ₹4k–10k / month (+ RDS if used) |

Whichever you choose, go through the [go-live checklist](go-live-checklist.md).

## What runs

| Piece | Image / command | Notes |
|---|---|---|
| Web | `apps/web/Dockerfile` | Next.js standalone server, port 3000, non-root, read-only root filesystem |
| API | `apps/api/Dockerfile` → `node dist/main.js` | Port 4000. `WORKERS=false` on API instances |
| Worker | same image, `WORKERS=true` | **Exactly one**: end of day, reminders, integrity checks, rescans |
| ClamAV | `clamav/clamav:stable` | Required in production (`CLAMAV_ADDRESS`) |
| Release task | same image → `node dist/ops/release.js` | **On every deploy, before traffic**: migrations, reference data, first admin, least-privilege roles, `fin_app` password. As the schema owner |
| Backup | same image → `/app/scripts/backup.sh` | Nightly 01:30 IST. Dump + audit-chain head → `BACKUP_TARGET` |
| Restore drill | same image → `/app/scripts/restore-drill.sh latest` | Weekly. Restores the newest backup into a scratch database and verifies it |

Health endpoints: `GET /api/v1/health` (liveness: the process answers) and `GET /api/v1/health/ready`
(readiness: the database answers and every migration in the image is applied — used by the load balancer).

Logs are JSON lines (`LOG_FORMAT=json`, the default in production). The access log records method, path
(without the query string), status, duration, request id and user id — never bodies or search terms.

## A. AWS

Prerequisites: an AWS account (ideally an Organization with a separate backup account), a domain, and an
ACM certificate for it in **ap-south-1**. Terraform ≥ 1.10.

1. **State bucket** (once): create a private, versioned S3 bucket in ap-south-1 for Terraform state.
2. **Apply**:
   ```bash
   cd infra/terraform
   cp production.tfvars.example production.tfvars   # edit: domain, certificate, alert email
   terraform init -backend-config="bucket=<state-bucket>" -backend-config="key=financiers/production.tfstate"
   terraform apply -var-file=production.tfvars
   ```
   This creates the VPC (public / app / data subnets, NAT), RDS PostgreSQL 16 (encrypted, Multi-AZ, PITR
   35 days, deletion protection, TLS-only, automated backups replicated to Hyderabad), S3 buckets
   (documents: KMS, versioned, replicated to Hyderabad; backups: Object Lock compliance 35 days, 8-year
   lifecycle ⚖), KMS keys, ECR, ECS cluster and services, ALB (TLS 1.2+) with WAF, Secrets Manager,
   AWS Backup with a Hyderabad copy, the backup and restore-drill schedules, alarms to SNS, and the
   GitHub deploy role (OIDC).
3. **Secrets**: put the application secret (`terraform output app_secret_arn`). Generate the keys with
   `openssl rand -base64 32`:
   ```json
   {
     "DATABASE_URL": "postgresql://fin_app:<pw>@<rds-endpoint>:5432/financiers?sslmode=verify-full",
     "FIN_APP_PASSWORD": "<pw>",
     "DATA_ENCRYPTION_KEY": "<base64 32 bytes>",
     "BLIND_INDEX_KEY": "<a different base64 32 bytes>",
     "SEED_ADMIN_PASSWORD": "<temporary; remove after the first deploy>",
     "MSG91_AUTH_KEY": "…", "MSG91_SENDER_ID": "…", "MSG91_WEBHOOK_TOKEN": "…",
     "WHATSAPP_PHONE_NUMBER_ID": "…", "WHATSAPP_ACCESS_TOKEN": "…", "WHATSAPP_APP_SECRET": "…", "WHATSAPP_VERIFY_TOKEN": "…"
   }
   ```
   `aws secretsmanager put-secret-value --secret-id <arn> --secret-string file://app-secret.json`, then
   delete the file. **Keep `DATA_ENCRYPTION_KEY` and `BLIND_INDEX_KEY` in a sealed envelope too** —
   without them encrypted KYC data cannot be read. The database owner's password is managed and rotated
   by RDS; nothing else needs it.
4. **GitHub**: create environments `staging` and `production` (production: *required reviewers*). Set the
   variables listed at the top of `.github/workflows/deploy.yml` from `terraform output`, then the
   repository variables `DEPLOY_ENABLED=true` (turns the deploy workflow on) and `STAGING_URL` (the
   weekly OWASP ZAP scan). Until then both workflows are skipped.
5. **DNS**: point the domain at `alb_dns_name` (Route 53 alias, or a CNAME).
6. **Deploy**: push to `main` (staging) or tag `v1.0.0` (production, after approval). The workflow builds
   and scans the images, takes an RDS snapshot (production), registers task definitions, **runs the
   release task and stops if it fails**, rolls out with 100% minimum healthy and automatic rollback, and
   smoke-tests the site.
7. **First sign-in**: `admin` with `SEED_ADMIN_PASSWORD` → change it, set up 2FA. Remove
   `SEED_ADMIN_PASSWORD` from the secret.
8. Subscribe a phone number to the SNS alerts topic (SMS) in addition to the email.

**Rollback**: re-run the deploy workflow on the previous tag (images are immutable and kept). Migrations are
additive (expand/contract, doc 13 §4), so the previous version runs on the new schema. For a bad data change,
restore the pre-deploy snapshot ([disaster recovery runbook](runbooks/disaster-recovery.md)).

**Terraform and deploys**: services follow the task definitions registered by the deploy workflow;
Terraform ignores those changes. Pass `-var image_tag=<the deployed tag>` when you apply so the one-off
task definitions (release, backup, drill) stay on the current image.

## B. Single server (pilot)

A server in India (e.g. AWS Lightsail / EC2 in Mumbai, 4 vCPU / 8 GB, 80 GB disk) with Docker and a DNS
name pointing at it. Ports 80 and 443 open; SSH limited to your office IP.

```bash
git clone https://github.com/adityakottu/Financiers && cd Financiers/deploy/compose
cp .env.example .env && chmod 600 .env     # fill it in
docker compose build
docker compose run --rm release            # first time and after every upgrade
docker compose up -d
docker compose ps                          # all healthy (ClamAV needs a few minutes the first time)
```

Caddy obtains the HTTPS certificate automatically. Upgrades: `git pull`, `docker compose build`,
`docker compose run --rm release`, `docker compose up -d`.

Backups: set `BACKUP_TARGET=s3://<bucket-in-ap-south-1>/postgres` (bucket with Object Lock) and give the
server an instance role that can write to it, or keep the default `/backups` volume **and copy it off the
server**. Add the weekly drill to cron (it runs as the owner, because it creates and drops a scratch
database):
`0 5 * * 0 cd …/deploy/compose && docker compose run --rm --entrypoint bash backup -c 'DATABASE_URL=$MIGRATE_DATABASE_URL /app/scripts/restore-drill.sh latest'`

## Verifying a deployment
- `https://<domain>/api/v1/health/ready` → `{"status":"ready"}`
- Sign in as the admin → *System health* → **Run now**: all integrity checks pass.
- Upload a test document on a customer: it is scanned (status *Clean*).
- [SSL Labs](https://www.ssllabs.com/ssltest/) grade A; `Strict-Transport-Security` present.
