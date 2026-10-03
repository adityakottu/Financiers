#!/usr/bin/env bash
# Builds and starts the API (port 4000) and the web app (port 3000) for demo / verification;
# Ctrl+C stops both. Only port 3000 is opened in a browser — the web app forwards /api/v1 to the
# API. For day-to-day development with live reload use `pnpm dev:api` and `pnpm dev:web` instead.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f apps/api/.env ] || { echo "Run 'pnpm setup' (scripts/dev-setup.sh) first"; exit 1; }
echo "Building…"
pnpm --filter "./packages/**" run build >/dev/null
pnpm --filter @fin/api run build >/dev/null
(cd apps/web && env -u NODE_ENV NEXT_TELEMETRY_DISABLED=1 pnpm exec next build >/dev/null)
trap 'kill 0' INT TERM EXIT
(set -a; . apps/api/.env; set +a; cd apps/api && node dist/main.js) &
(cd apps/web && API_URL=http://localhost:4000 NEXT_TELEMETRY_DISABLED=1 pnpm exec next start -p 3000 -H 0.0.0.0) &
sleep 3
echo
echo "Financiers is running → http://localhost:3000   (Codespaces: Ports tab → 3000 → Open in browser)"
echo "Sign-ins are in .demo-credentials. Ctrl+C to stop."
wait
