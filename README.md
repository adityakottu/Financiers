# Financiers

Lending, collections, accounting and daily reconciliation system for an
asset-backed lending business in India.

**Current phase:** Phase 7 — Reports, dashboards & recovery ✅ (see [Phase 7 report](docs/phase-7-report.md);
earlier: [Phase 6](docs/phase-6-report.md), [Phase 5](docs/phase-5-report.md), [Phase 4](docs/phase-4-report.md), [Phase 3](docs/phase-3-report.md), [Phase 2](docs/phase-2-report.md)).
Architecture and specifications: [docs/README.md](docs/README.md).

## Repository layout

```
apps/api          NestJS API (PostgreSQL, Kysely, SQL migrations)
apps/web          Next.js web app (desktop console + mobile-responsive)
packages/loan-engine Pure schedule / APR / fee / penalty calculations (shared by API and web)
packages/money    Decimal Money type and Indian number formatting
packages/contracts Permission catalogue, roles, Zod schemas shared by API and web
docs/             Architecture pack (Phase 1) and phase reports
```

## Try it

The quickest way to open the app is **GitHub Codespaces** (Code → Codespaces → Create), then
`pnpm demo`. Step-by-step instructions for Codespaces, VS Code and sharing through Cloudflare:
[docs/run-and-verify.md](docs/run-and-verify.md). On your own machine, `pnpm setup` then `pnpm demo`
does everything below automatically.

## Running locally

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or `docker compose up -d postgres`).

```bash
pnpm install
pnpm --filter "./packages/**" run build

# API configuration
cp apps/api/.env.example apps/api/.env
#   fill DATA_ENCRYPTION_KEY and BLIND_INDEX_KEY with two different values from:
#   openssl rand -base64 32

pnpm db:migrate                                  # uses DATABASE_URL from your shell
SEED_ADMIN_PASSWORD='<a strong password>' pnpm db:seed
#   or, for realistic demo data (never in production):
#   DEMO_PASSWORD='<password>' SEED_ADMIN_PASSWORD='<password>' pnpm --filter @fin/api db:seed:demo

pnpm dev:api     # http://localhost:4000/api/v1
pnpm dev:web     # http://localhost:3000  (proxies /api/v1 to the API)
```

The demo data includes branches KKD and RJY, users `manager.kkd`, `manager.rjy`,
`collector.kkd` and `accounts.kkd` (password = `DEMO_PASSWORD`), 36 customers, three loan
products and loans in every state, with end-of-day processing run for the last
10 days, then a day of collections by `collector.kkd` (payments, receipts,
a reversal awaiting approval, visits), partners' capital, expenses at each stage,
a cash deposit and a cheque in hand.

Messaging runs in test mode (nothing is sent; messages are marked "Not sent (test
mode)") until MSG91 / WhatsApp Business Cloud API credentials are set — see
`apps/api/.env.example`.

Production web build: `pnpm --filter @fin/web build`. Do not run it with
`NODE_ENV=development` exported in your shell (Next.js then fails with
"<Html> should not be imported outside of pages/_document").

The first Super Admin must change the seeded password and enrol two-step
verification (any TOTP authenticator app) at first sign-in.

## Tests

```bash
pnpm test        # package unit tests + API unit and integration tests
```

API integration tests run against a real PostgreSQL database named
`financiers_test` (dropped and recreated on each run). Override with
`TEST_DATABASE_URL`. The database name must end in `_test`.

## Security notes for operators

- Never commit `.env` files or keys. `DATA_ENCRYPTION_KEY` encrypts KYC numbers
  and TOTP secrets — losing it makes them unreadable; leaking it exposes them.
  Store it in a secrets manager and back it up separately from the database.
- `ENFORCE_MFA=false` is refused in production.
- Items marked ⚖ in the docs need review by a qualified professional before go-live.
