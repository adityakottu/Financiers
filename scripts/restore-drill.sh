#!/usr/bin/env bash
# Backup → restore → verify drill (doc 14 §4). Takes a logical backup of DATABASE_URL (or uses the
# dump file given as $1), restores it into a scratch database, runs the integrity checks and
# compares row counts, then drops the scratch database. Prints timings as RTO evidence.
# Exit code: 0 = restore verified, 1 = verification failed, 2 = could not run.
#
#   DATABASE_URL=postgresql://owner@host/financiers scripts/restore-drill.sh            # dump now, then verify
#   DATABASE_URL=postgresql://owner@host/financiers scripts/restore-drill.sh nightly.dump  # verify an existing backup
#   DATABASE_URL=… BACKUP_TARGET=s3://bucket/postgres scripts/restore-drill.sh latest    # the newest nightly backup (weekly task)
# An existing backup is also checked against the audit-chain head saved next to it by backup.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -n "${DATABASE_URL:-}" ] || DATABASE_URL=$(node apps/api/dist/ops/db-url.js 2>/dev/null || true)
: "${DATABASE_URL:?set DATABASE_URL (a role that can create databases)}"
s3obj() { node apps/api/dist/ops/s3-object.js "$@"; }
integrity() {
  if [ -f apps/api/dist/integrity/cli.js ]; then (cd apps/api && node dist/integrity/cli.js); else pnpm --silent --filter @fin/api exec tsx src/integrity/cli.ts; fi
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src_db=$(node -e "console.log(new URL(process.argv[1]).pathname.slice(1))" "$DATABASE_URL")
scratch="${src_db}_restore_${stamp,,}"
scratch_url=$(node -e "const u=new URL(process.argv[1]);u.pathname='/'+process.argv[2];console.log(u.toString())" "$DATABASE_URL" "$scratch")
admin_url=$(node -e "const u=new URL(process.argv[1]);u.pathname='/postgres';console.log(u.toString())" "$DATABASE_URL")
t0=$(date +%s)

head_json=""
if [ "${1:-}" = latest ]; then
  : "${BACKUP_TARGET:?set BACKUP_TARGET to find the latest backup}"
  case "$BACKUP_TARGET" in
    s3://*) s3obj get "${BACKUP_TARGET%/}/LATEST" "$work/LATEST" ;;
    *) cp "$BACKUP_TARGET/LATEST" "$work/LATEST" ;;
  esac
  set -- "$(cat "$work/LATEST")"
fi
if [ -n "${1:-}" ]; then
  src="$1"
  case "$src" in
    s3://*)
      dump="$work/backup.dump"; s3obj get "$src" "$dump"
      s3obj get "${src%.dump}.audit-head.json" "$work/head.json" 2>/dev/null && head_json="$work/head.json" || true
      ;;
    *)
      dump="$src"; [ -f "${src%.dump}.audit-head.json" ] && head_json="${src%.dump}.audit-head.json"
      ;;
  esac
  echo "Using backup $src"
else
  dump="$work/backup.dump"
  echo "1/4 Backing up $src_db …"
  pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$DATABASE_URL"
fi
echo "    backup size: $(du -h "$dump" | cut -f1)"

echo "2/4 Restoring into scratch database $scratch …"
psql -q "$admin_url" -c "CREATE DATABASE \"$scratch\""
cleanup() { psql -q "$admin_url" -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" || true; rm -rf "$work"; }
trap cleanup EXIT
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$scratch_url" "$dump"
t_restore=$(( $(date +%s) - t0 ))

echo "3/4 Integrity checks on the restored copy …"
status=0
DATABASE_URL="$scratch_url" integrity || status=1
if [ -n "$head_json" ]; then
  want=$(node -e "const h=require(process.argv[1]);console.log(h.last_hash??'')" "$head_json")
  got=$(psql -At "$scratch_url" -c "SELECT encode(hash, 'hex') FROM audit_logs ORDER BY id DESC LIMIT 1")
  if [ "$want" = "$got" ]; then echo "    audit chain head matches the one recorded at backup time ✓"; else echo "    audit chain head DIFFERS from the one recorded at backup time ✗"; status=1; fi
fi

echo "4/4 Row counts (source vs restored) …"
tables="loans payments receipts journal_entries journal_lines audit_logs customers loan_installments payment_allocations"
for t in $tables; do
  a=$(psql -At "$scratch_url" -c "SELECT count(*) FROM $t")
  if [ -z "${1:-}" ]; then
    b=$(psql -At "$DATABASE_URL" -c "SELECT count(*) FROM $t")
    flag=$([ "$a" = "$b" ] && echo ok || echo DIFFERENT)
    [ "$flag" = ok ] || status=1
    printf '    %-22s source %-8s restored %-8s %s\n' "$t" "$b" "$a" "$flag"
  else
    printf '    %-22s restored %s\n' "$t" "$a"
  fi
done

echo
echo "Restore took ${t_restore}s; whole drill $(( $(date +%s) - t0 ))s (target RTO: 4 h in-region)."
if [ "$status" = 0 ]; then echo "RESTORE VERIFIED ✓"; else echo "RESTORE VERIFICATION FAILED ✗"; fi
exit $status
