# Phase 10 Report — Production deployment

Status: **complete, awaiting your review.** Nothing has been deployed: that needs your AWS account (or
server), domain and secrets. Everything needed to deploy is in the repository, and the steps are in
[deployment.md](deployment.md). Items marked ⚖ need your CA's or legal advisor's confirmation.

## 1. What was built

| Area | What it does |
|---|---|
| **Container images** | `apps/api/Dockerfile` (API, worker and the ops tasks share one image) and `apps/web/Dockerfile` (Next.js standalone server). Multi-stage builds, production dependencies only, **non-root user (10001)**, tini as PID 1, health checks. The API image carries `pg_dump`/`pg_restore` for backups and the **Amazon RDS certificate authorities**, so database connections verify the server certificate (`sslmode=verify-full`). |
| **Release task** (`node dist/ops/release.js`) | Run on every deploy **before traffic moves**, as the schema owner. It applies migrations, syncs permissions, roles and numbering with the build, creates the first Super Admin (first deploy only), re-applies the least-privilege database roles, and sets `fin_app`'s password from the secret (quoted by PostgreSQL itself). It is safe to run repeatedly. On AWS the owner's credentials come from the **RDS-managed, auto-rotated secret**, so no owner password is stored anywhere. |
| **Readiness & logs** | `/api/v1/health` (liveness, no database call) and `/api/v1/health/ready`. The load balancer uses readiness: the database answers **and every migration in the image is applied**, so a new version never takes traffic against an old schema. In production logs are **JSON lines** for CloudWatch, plus an access log with method, path (no query string), status, duration, request id and user id. No bodies or search terms are logged. |
| **Document storage on S3** | `STORAGE_DRIVER=s3`: a private bucket with SSE-KMS. Writes are **write-once** (If-None-Match), and credentials come from the task role. Downloads still go through the API, which checks permission and malware status; there are no public or presigned links. The local driver is kept for development and the single-server pilot. |
| **Backups** (`scripts/backup.sh`) | Nightly `pg_dump` (checked readable). Alongside it the script saves the **audit-chain head**: the last audit record's hash, the record count and the dump's SHA-256. Both go to S3 (SSE-KMS, Object Lock bucket) or a local directory with 35-day pruning. A `LATEST` pointer is written for the drill. |
| **Restore drill** (`scripts/restore-drill.sh latest`) | Fetches the newest nightly backup, restores it into a scratch database and runs every integrity check. It **compares the restored audit chain with the head recorded at backup time**, so a backup cannot be swapped or rewritten unnoticed, then drops the scratch database. Scheduled weekly on AWS. |
| **AWS (Terraform, `infra/terraform`)** | All in ap-south-1 (Mumbai), with DR copies in ap-south-2 (Hyderabad). **Network:** VPC with public / app / isolated data subnets, NAT, an S3 gateway endpoint and rejected-traffic flow logs. **Database:** RDS PostgreSQL 16 — Multi-AZ, KMS, TLS-only, PITR 35 days, deletion protection, Performance Insights, slow-query log, automated backups replicated to Hyderabad. **Storage:** document bucket (KMS, versioned, TLS-only, replicated to Hyderabad) and backup bucket (**Object Lock compliance 35 days**, Glacier after 90 days, kept 8 years ⚖). **Compute:** ECS Fargate (web ×2, api ×2, worker ×1, clamav), read-only root filesystems, all Linux capabilities dropped, rolling deploys with automatic rollback, Cloud Map for internal names. **Edge:** ALB (TLS 1.2/1.3, HTTP→HTTPS, invalid headers dropped) with **AWS WAF** (IP reputation, common rules, known bad inputs, SQL injection, a per-IP rate limit). **Secrets & keys:** Secrets Manager; separate KMS keys for RDS, S3, secrets and logs. **Backups & schedules:** AWS Backup daily with a vault lock and a Hyderabad copy; nightly backup and weekly drill schedules (Asia/Kolkata). **Alarms** to SNS: API 5xx, API p95 > 1 s, unhealthy targets, database CPU / storage / memory, integrity failure, backup or drill failure, **no backup in 26 h**. **Deploy role:** GitHub OIDC (no stored AWS keys; production only from the protected environment). |
| **Single server** (`deploy/compose`) | For the pilot (doc 13 §5): Caddy (automatic HTTPS, HSTS), web, api, worker, clamav, release, nightly backup, and optional local PostgreSQL. Containers are read-only, drop all capabilities, and only Caddy is exposed. |
| **CI** (`.github/workflows/ci.yml`) | New jobs: **build both production images, smoke-test them** (non-root; API tools present; web serves `/login`), and **Trivy scan** — fixable HIGH/CRITICAL vulnerabilities fail the build. `terraform fmt` / `validate` and a compose-file check also run. The S3 document-store test runs against an S3 mock. |
| **CD** (`.github/workflows/deploy.yml`) | Staging on every push to `main`; **production on a version tag after approval** in the GitHub `production` environment. Steps: build → push (immutable tags) → scan → **RDS snapshot** (production) → task definitions → **release task, stop on failure** → rolling update with automatic rollback → smoke test (readiness, login, HSTS). Skipped until AWS is configured. |
| **ZAP** (`.github/workflows/zap.yml`) | OWASP ZAP baseline against staging, weekly and on demand (checklist B2). |
| **Guide** | [deployment.md](deployment.md): AWS step by step (state, apply, secrets, GitHub, DNS, first sign-in, rollback), the single server, and how to verify. The DR runbook now uses the release task, `restore_snapshot` for a Hyderabad rebuild, and the scheduled drill. |

## 2. How it was tested

| Check | Result |
|---|---|
| Money, contracts, loan engine | 46 passing |
| API integration (real PostgreSQL, as `fin_app`) | **219** passing (3 new: liveness / readiness; local store write-once and path traversal refused; **S3 store write-once with SSE**, run against an S3-compatible mock) |
| Backup → restore drill, local directory | `backup ok` → `restore-drill.sh latest`: integrity checks pass, **audit chain head matches**, RESTORE VERIFIED |
| Backup → restore drill, S3 | Same, through the S3 code path (S3 mock): RESTORE VERIFIED |
| Release task | On an empty database: migrations, admin, roles; `fin_app` signs in with a password containing a quote. Run again: idempotent |
| Next.js standalone server | Built and run: `/login` 200, static assets 200, `/api/v1` proxied to the API |
| Dockerfiles | `docker build --check`: no warnings |
| Terraform | `terraform fmt -check` clean; `terraform validate` **valid** (Terraform 1.10.5, AWS provider 5.100) |
| Compose | `docker compose config` valid (8 services) |
| Lint / typecheck / web build | Clean |

**Total: 265 automated tests, all passing.**

**Not run here:** full image builds and the Trivy scan. This sandbox's network does not let containers
download packages, so CI runs them on the first push. The AWS apply and the deploy workflow need your
account. Pass `-var image_tag=<the deployed tag>` when you apply.

### Defects found and fixed during Phase 10
1. The local document store threw synchronously for an invalid key instead of returning a rejected promise (found by the new test).
2. The integrity-failure alarm pattern did not match the log text's case (`INTEGRITY CHECK FAILED`). CloudWatch patterns are case-sensitive.
3. The release task first built the `ALTER ROLE` statement with string interpolation. The security lint refused it, and PostgreSQL's `format(%L)` now quotes the value.

## 3. Deviations and deferrals

| Planned (doc 13) | Status | Why |
|---|---|---|
| CloudFront in front of the ALB | **Not included**; WAF on the ALB | Users are in a few Indian towns. CloudFront adds little but a second TLS and cache layer to get right; it is easy to add later. |
| ElastiCache Redis | **Not needed** | Rate limits, sessions and jobs live in PostgreSQL (Phase 8), which removes a component. |
| Read replica for reports | Not included | Reports meet their targets on the primary (Phase 8 load test). Add one if reporting load grows. |
| Separate PDF renderer service | Not needed | PDFs are generated in-process (pdfkit) within limits. |
| Image signing (cosign), Semgrep, OpenTelemetry tracing | Not included | Trivy, gitleaks and the security lint cover the main risks for V1. Tracing can be added with the ADOT collector. |
| Preview environment per PR | Not included | Staging plus the Codespaces demo cover review. |
| Separate AWS backup account | Same account, with a vault lock, an **Object Lock** bucket and **copies in Hyderabad** | Account creation is yours. Point the AWS Backup copy at a vault in a second account once it exists (checklist C1). |
| Staging sizing | Same Terraform with `env = "staging"` (single-AZ database) | Use smaller `db_instance_class`, `api_count` and `web_count` values in staging. |

## 4. ⚖ For your CA / legal advisor
- Retention: backups expire after **8 years** (financial records). KYC retention under PMLA may differ, so confirm both.
- Data residency: everything is in Mumbai, with DR copies in Hyderabad. Confirm no third-party processors outside India (SMS / WhatsApp providers: check their data-location terms).
- CERT-In: logs are kept **180 days** in Mumbai, as the CERT-In directions ask. Confirm that this, together with the audit log in the database (kept with the financial records), meets your obligations.

## 5. Before go-live (from the [checklist](go-live-checklist.md))
1. `terraform apply` for staging, then deploy `main`, then run the load test (C5) and ZAP (B2) on staging, then the external penetration test (B1).
2. Secrets in Secrets Manager; the two data keys also in a sealed envelope (B4).
3. Production apply, a tag, approval and deploy. Run the drill once by hand and record the time (C2).
4. Data migration and pilot (Phase 9).
