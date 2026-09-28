# 13 — Deployment Architecture

## 1. Recommendation

**AWS, Mumbai region (ap-south-1)**, DR in Hyderabad (ap-south-2) — keeps all
personal and financial data in India ⚖ (D6). Vercel is not recommended for the
API/workers here: financial workloads need long-lived DB connections, background
workers, private networking and Indian data residency guarantees that are
simpler on AWS.

## 2. Topology

```mermaid
flowchart TB
  U[Users: browsers & Android phones] -->|HTTPS| CF[CloudFront + AWS WAF]
  CF --> ALB[Application Load Balancer]
  subgraph VPC ap-south-1
    subgraph Public subnets
      ALB
      NAT[NAT Gateway]
    end
    subgraph Private app subnets
      WEB[ECS Fargate: web (Next.js) ×2+]
      API[ECS Fargate: api (NestJS) ×2+]
      WRK[ECS Fargate: worker ×1+]
      PDF[ECS Fargate: pdf-renderer]
      AV[ECS Fargate: clamav]
    end
    subgraph Private data subnets
      RDS[(RDS PostgreSQL 16 Multi-AZ)]
      RR[(Read replica — reports)]
      REDIS[(ElastiCache Redis, TLS, Multi-AZ)]
    end
  end
  ALB --> WEB
  ALB -->|/api| API
  WEB --> API
  API --> RDS
  API --> REDIS
  WRK --> RDS
  WRK --> REDIS
  WRK --> PDF
  API --> S3[(S3: documents, receipts, exports — SSE-KMS, private)]
  WRK --> S3
  WRK -->|via NAT, egress allow-list| EXT[SMS / WhatsApp providers]
  EXT -->|signed webhooks| ALB
  RDS -. snapshots/PITR .-> BK[(Backup account: AWS Backup vault, Object Lock)]
  S3 -. replication .-> S3DR[(S3 ap-south-2)]
```

## 3. Environments

| Env | Purpose | Data | Deploy |
|---|---|---|---|
| local | dev | synthetic (docker-compose: Postgres, Redis, MinIO, Mailpit, mock SMS/WA) | — |
| preview | per-PR | synthetic, ephemeral | auto on PR |
| staging | UAT, E2E, pen-test | synthetic seed; prod-like config | auto on merge to `main` |
| production | live | real | manual approval of a tagged release |

## 4. CI/CD (GitHub Actions)

1. Install (pnpm, cached) → lint → typecheck → unit → integration (Testcontainers) → build.
2. Security: Semgrep, gitleaks, `pnpm audit`/OSV, container image scan (Trivy).
3. Build images, sign (cosign), push to ECR.
4. Staging: run migrations (`fin_migrator` role) → deploy → E2E + ZAP baseline.
5. Production: manual approval → pre-deploy snapshot → migrations → rolling deploy
   (ECS, min healthy 100%) → smoke tests → auto-rollback on failed health checks.

Migrations are **expand/contract**: additive first, backfill, switch code,
remove old columns in a later release — no destructive migration in the same
release that stops using a column.

## 5. Sizing (V1 starting point, ~10 branches, ~50 users, ≤100k loans)

| Component | Size |
|---|---|
| RDS PostgreSQL | db.m7g.large Multi-AZ, 200 GB gp3, PITR 35 days |
| Redis | cache.t4g.small Multi-AZ |
| API | 2 × 1 vCPU / 2 GB |
| Web | 2 × 0.5 vCPU / 1 GB |
| Worker | 1 × 1 vCPU / 2 GB (+ PDF renderer 1 × 1 vCPU / 2 GB) |

Indicative cost range ₹35k–60k/month; to be refined once volumes are known.
A lower-cost single-VM alternative (e.g. Lightsail/EC2 + managed RDS) is viable
for pilot but keeps RDS managed backups regardless.

## 6. Configuration & secrets

- 12-factor config; all secrets in AWS Secrets Manager, injected as env at task start.
- `.env.example` in repo with names only. gitleaks in pre-commit and CI.
- KMS keys: `kms/rds`, `kms/s3`, `kms/app-data` (column encryption), `kms/blind-index`.

## 7. Observability

- Logs: JSON → CloudWatch (PII-redacted), 90-day hot retention, archived to S3.
- Metrics & traces: OpenTelemetry; dashboards for payment latency, queue depth,
  message failures, recon backlog, DB health.
- Alerts: API 5xx rate, payment p95, queue backlog, failed SMS/WA > threshold,
  ledger integrity job failure, audit chain failure, backup failure, disk/CPU.
- Uptime checks from outside AWS (login page + health endpoint).
