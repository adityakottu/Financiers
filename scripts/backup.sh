#!/usr/bin/env bash
# Nightly logical backup (doc 14 §2): pg_dump (custom format) of DATABASE_URL, plus the audit-chain
# head (the last audit record's hash) so a later restore can prove the trail was not rewritten.
# Both go to BACKUP_TARGET:
#   s3://bucket/prefix   → uploaded with SSE-KMS (bucket with Object Lock; credentials from the task role)
#   /a/local/directory   → kept there; files older than BACKUP_KEEP_DAYS (default 35) are removed
# RDS automated snapshots and PITR stay the first line of recovery; this is the independent copy.
#
#   DATABASE_URL=postgresql://… BACKUP_TARGET=s3://fin-backups-123/postgres scripts/backup.sh
# Exit code: 0 ok, 1 failed (alert on it).
set -euo pipefail
here0="$(cd "$(dirname "$0")" && pwd)"
# On AWS the owner URL is built from the RDS-managed secret (apps/api/src/ops/db-url.ts).
[ -n "${DATABASE_URL:-}" ] || DATABASE_URL=$(node "$here0/../apps/api/dist/ops/db-url.js")
: "${DATABASE_URL:?set DATABASE_URL}"
: "${BACKUP_TARGET:?set BACKUP_TARGET (s3://bucket/prefix or a directory)}"
here="$(cd "$(dirname "$0")" && pwd)"
s3obj() { node "$here/../apps/api/dist/ops/s3-object.js" "$@"; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
day=$(date -u +%Y/%m/%d)
db=$(node -e "console.log(new URL(process.argv[1]).pathname.slice(1))" "$DATABASE_URL")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dump="$work/$db-$stamp.dump"
head="$work/$db-$stamp.audit-head.json"

t0=$(date +%s)
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$dump" "$DATABASE_URL"
pg_restore --list "$dump" > /dev/null   # the archive is readable
sha=$(sha256sum "$dump" | cut -d' ' -f1)
psql -At "$DATABASE_URL" -c "SELECT json_build_object('db', current_database(), 'at', now(), 'last_id', id, 'last_hash', encode(hash, 'hex'), 'records', (SELECT count(*) FROM audit_logs), 'dump_sha256', '$sha') FROM audit_logs ORDER BY id DESC LIMIT 1" > "$head"
[ -s "$head" ] || echo "{\"db\":\"$db\",\"records\":0,\"dump_sha256\":\"$sha\"}" > "$head"

case "$BACKUP_TARGET" in
  s3://*)
    base="${BACKUP_TARGET%/}/$day"
    s3obj put "$dump" "$base/$(basename "$dump")"
    s3obj put "$head" "$base/$(basename "$head")"
    # A pointer to the newest backup, read by the weekly restore drill.
    printf '%s\n' "$base/$(basename "$dump")" > "$work/LATEST"
    s3obj put "$work/LATEST" "${BACKUP_TARGET%/}/LATEST"
    where="$base"
    ;;
  *)
    mkdir -p "$BACKUP_TARGET"
    chmod 700 "$BACKUP_TARGET"
    cp "$dump" "$head" "$BACKUP_TARGET/"
    printf '%s\n' "$BACKUP_TARGET/$(basename "$dump")" > "$BACKUP_TARGET/LATEST"
    find "$BACKUP_TARGET" -name "$db-*" -mtime +"${BACKUP_KEEP_DAYS:-35}" -delete
    where="$BACKUP_TARGET"
    ;;
esac
echo "backup ok: $(basename "$dump") ($(du -h "$dump" | cut -f1), sha256 $sha) → $where in $(( $(date +%s) - t0 ))s"
