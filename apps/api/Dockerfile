# API (and worker / ops tasks) image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t financiers-api .
# Runs as a non-root user with a read-only root filesystem in production (see infra/terraform).

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/money/package.json packages/money/
COPY packages/loan-engine/package.json packages/loan-engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@fin/api..."
COPY tsconfig*.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter "./packages/**" run build && pnpm --filter @fin/api run build

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/money/package.json packages/money/
COPY packages/loan-engine/package.json packages/loan-engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@fin/api..."

FROM node:22-alpine AS runtime
# pg_dump / pg_restore / psql for the backup and restore-drill tasks; tini as PID 1.
RUN apk add --no-cache postgresql16-client bash tini && addgroup -S fin && adduser -S -G fin -u 10001 fin \
  && mkdir -p /data/files && chown 10001:10001 /data/files && chmod 700 /data/files
WORKDIR /app
# Amazon RDS certificate authorities: connections use sslmode=verify-full (Node and libpq).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem PGSSLROOTCERT=/etc/ssl/rds-global-bundle.pem
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/packages packages
COPY --from=build /app/packages/money/dist packages/money/dist
COPY --from=build /app/packages/loan-engine/dist packages/loan-engine/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/package.json apps/api/
COPY scripts/backup.sh scripts/restore-drill.sh scripts/
USER 10001
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Other commands with the same image:
#   node dist/ops/release.js       (every deploy: migrations, reference data, roles — as the schema owner)
#   node dist/integrity/cli.js     (integrity check)
#   /app/scripts/backup.sh         (nightly backup)
#   /app/scripts/restore-drill.sh  (weekly restore drill)
CMD ["node", "dist/main.js"]
