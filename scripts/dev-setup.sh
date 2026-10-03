#!/usr/bin/env bash
# One-time setup for a development / demo environment (Codespaces, Dev Container, or your laptop).
# Safe to run again: it never overwrites apps/api/.env or reloads demo data that already exists.
# Demo only — never run this against a production database.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
rand() { openssl rand -base64 "${1:-32}" | tr -d '\n'; }

say "1/5 Tools"
command -v node >/dev/null || { echo "Node 22 is required: https://nodejs.org"; exit 1; }
corepack enable >/dev/null 2>&1 || npm i -g pnpm@10 >/dev/null
pnpm --version

say "2/5 Dependencies"
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" run build

say "3/5 API settings (apps/api/.env)"
ENV=apps/api/.env
if [ ! -f "$ENV" ]; then
  cp apps/api/.env.example "$ENV"
  # Fresh random keys for this environment only; they never leave it.
  sed -i "s|^DATA_ENCRYPTION_KEY=.*|DATA_ENCRYPTION_KEY=$(rand)|; s|^BLIND_INDEX_KEY=.*|BLIND_INDEX_KEY=$(rand)|" "$ENV"
  echo "created $ENV with new encryption keys"
else
  echo "$ENV exists — left as it is"
fi
# In Codespaces the browser reaches the app at a forwarded https address; the API must accept it.
if [ -n "${CODESPACE_NAME:-}" ]; then
  ORIGIN="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  grep -q "$ORIGIN" "$ENV" || sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=${ORIGIN},http://localhost:3000|" "$ENV"
  grep -q '^PUBLIC_WEB_URL=' "$ENV" || echo "PUBLIC_WEB_URL=${ORIGIN}" >> "$ENV"
  echo "APP_ORIGIN set for this codespace: $ORIGIN"
fi
set -a; . "$ENV"; set +a

say "4/5 Database"
for i in $(seq 1 30); do
  node -e "require('net').connect(5432,'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" && break
  if [ "$i" = 1 ] && command -v docker >/dev/null && [ -z "${CODESPACES:-}${REMOTE_CONTAINERS:-}" ]; then docker compose up -d postgres || true; fi
  sleep 2
done
pnpm --filter @fin/api run db:migrate

say "5/5 Demo data"
CRED=.demo-credentials
if [ -f "$CRED" ]; then . "./$CRED"; fi
DEMO_PASSWORD="${DEMO_PASSWORD:-Demo#$(rand 18 | tr -dc 'A-Za-z0-9' | head -c 14)}"
SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-Ledger#$(rand 18 | tr -dc 'A-Za-z0-9' | head -c 14)}"
printf 'DEMO_PASSWORD=%q\nSEED_ADMIN_PASSWORD=%q\n' "$DEMO_PASSWORD" "$SEED_ADMIN_PASSWORD" > "$CRED"
chmod 600 "$CRED"
(cd apps/api && DEMO_PASSWORD="$DEMO_PASSWORD" SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" pnpm run db:seed:demo)

cat <<MSG

Ready. Start the app with:   pnpm demo
Then open http://localhost:3000 (in Codespaces: the "Ports" tab → port 3000).

Demo sign-ins (kept in $CRED, which git ignores):
  manager.kkd / collector.kkd / accounts.kkd / manager.rjy   password: $DEMO_PASSWORD
  admin (Super Admin)                                       password: $SEED_ADMIN_PASSWORD
  The admin and accountants must set up two-step verification at first sign-in
  (any authenticator app); the admin must also change the password.
MSG
