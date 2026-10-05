# Web (Next.js) image. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg API_URL=http://api:4000 -t financiers-web .
# API_URL is where the web server proxies /api/v1 (compiled into the build). Behind the AWS load
# balancer /api/* goes straight to the API, so this proxy is only the fallback path.

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache libc6-compat
WORKDIR /app

FROM base AS build
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/money/package.json packages/money/
COPY packages/loan-engine/package.json packages/loan-engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@fin/web..."
COPY tsconfig*.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter "./packages/**" run build && pnpm --filter @fin/web run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini && addgroup -S fin && adduser -S -G fin -u 10001 fin
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=10001:10001 /app/apps/web/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/apps/web/.next/static apps/web/.next/static
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
