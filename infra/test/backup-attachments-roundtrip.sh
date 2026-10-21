#!/bin/sh
# =============================================================================
# backup-attachments-roundtrip.sh — the backup sidecar's DB + attachments round-trip (issue #1467).
#
# Runs the REAL `backup` service from compose.yaml (copied verbatim into a temp project dir, so the
# exact script, mounts and digest-pinned image production runs) against a throwaway Postgres and a
# throwaway attachments volume, then restores both with the commands docs/05-runbooks/backups.md
# gives the operator and checks the result byte for byte. Asserts:
#
#   1. Empty attachments volume (a fresh install, or one with no uploads yet): the run succeeds and
#      writes a matched pair app-<ts>.dump + attachments-<ts>.tar.gz.
#   2. Seeded volume: every blob is archived, tmp/ (in-flight uploads) is left out, no *.partial
#      remains, and the log names the blob count.
#   3. Disaster recovery: with the db and attachments volumes deleted, the documented restore (DB
#      first, then attachments, api still down) brings back every row and every blob — same bytes
#      (each blob's sha256 equals its file name), same owner (uid 1000, the api's `node` user), same
#      mtime — and every live attachment row has its blob.
#   4. Disk guard: a run that would leave less than BACKUP_MIN_FREE_MB free refuses the tarball
#      (loud FAILED line, non-zero exit, on-failure hook fired), keeps the DB dump of that run and the
#      last good tarball, and leaves no partial file. A non-numeric BACKUP_MIN_FREE_MB fails the same way.
#   5. Retention: each kind has its own window — with the defaults a 10-day-old tarball is pruned
#      (BACKUP_ATTACHMENTS_RETENTION_DAYS=7) while a 10-day-old dump is kept (BACKUP_RETENTION_DAYS=14);
#      anything else in ./backups is kept, and a failed attachments step does not prune old tarballs.
#   6. The offsite hook receives both files of a run, in the documented "$1" form.
#   7. Opt-out: BACKUP_ATTACHMENTS=false writes the dump and no tarball, exits 0, keeps the last good
#      tarball and still ages old tarballs out; an unknown BACKUP_ATTACHMENTS or a non-numeric
#      BACKUP_ATTACHMENTS_RETENTION_DAYS fails the run loud and keeps the dump. The defaults (on, 7 days)
#      apply with neither variable set — what an existing install gets on update.
#
# Isolation: its own compose project name, temp directory, env file and volumes. It never reads or
# writes infra/env/.env.prod, ./backups or any lazyit-prod_* volume of the checkout it runs from.
#
# Requires docker with the compose v2 plugin (it pulls the pinned postgres image if missing).
# Run from anywhere:  sh infra/test/backup-attachments-roundtrip.sh
# Exit 0 = the round-trip holds; non-zero = a regression (the failing assertion is printed).
# =============================================================================
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)

PIN=$(grep -o 'postgres:18-alpine@sha256:[0-9a-f]*' "$REPO_ROOT/compose.yaml" | head -n1)
[ -n "$PIN" ] || { echo "ERROR: could not extract the pinned postgres image from compose.yaml" >&2; exit 1; }

WORK=$(mktemp -d)
PROJ="lazyit-bkptest-$$"
ATT_VOL="${PROJ}_attachments_data"
DB_VOL="${PROJ}_db_data"

mkdir -p "$WORK/infra/env"
cp "$REPO_ROOT/compose.yaml" "$WORK/compose.yaml"
# BACKUP_CRON never fires during the test (Jan 1st, 00:00): every run below is triggered explicitly.
cat > "$WORK/infra/env/.env.prod" <<'EOF'
POSTGRES_USER=lazyit
POSTGRES_DB=lazyit
POSTGRES_PASSWORD=backup-roundtrip-test-1467
BACKUP_CRON=0 0 1 1 *
EOF

DC="docker compose -p $PROJ -f $WORK/compose.yaml --profile prod --env-file $WORK/infra/env/.env.prod"

cleanup() {
  $DC down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$ATT_VOL" "$DB_VOL" >/dev/null 2>&1 || true
  # ./backups was written by root inside the container; remove it the same way.
  docker run --rm --entrypoint sh -v "$WORK:/w" "$PIN" -c 'find /w -mindepth 1 -delete' >/dev/null 2>&1 || true
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PASS=0
pass() { PASS=$((PASS + 1)); echo "  ok - $1"; }
die() { echo "  FAIL - $1" >&2; exit 1; }

# in_backups CMD: run a shell command with ./backups mounted at /b (root-owned files, any host user).
in_backups() { docker run --rm --entrypoint sh -v "$WORK/backups:/b" "$PIN" -c "$1"; }
# in_att CMD: run a shell command against the attachments volume, mounted at /a.
in_att() { docker run --rm --entrypoint sh -v "$ATT_VOL:/a" "$PIN" -c "$1"; }
# run_backup [exec flags...]: one immediate backup run, the way cron would start it. Prints the log.
run_backup() {
  # TS has one-second resolution: never let two runs share a timestamp.
  sleep 1
  $DC exec -T "$@" backup lazyit-backup 2>&1
}
psql_q() { $DC exec -T db sh -c 'psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' _ "$1"; }
ts_of() { echo "$1" | sed -n 's/.*starting run \([0-9-]*\).*/\1/p' | head -n1; }

echo "backup sidecar round-trip (project $PROJ, image $PIN)"

$DC up -d backup >/dev/null 2>&1 || { $DC logs backup db >&2 || true; die "could not bring up db + backup"; }
i=0
until $DC exec -T backup test -x /usr/local/bin/lazyit-backup 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 60 ] || die "the backup sidecar never installed lazyit-backup"; sleep 1
done
pass "db + backup sidecar up from the real compose.yaml"
$DC logs backup 2>/dev/null | grep -q "attachments=true, retention 7d" \
  || { $DC logs backup >&2 || true; die "defaults: an env without BACKUP_ATTACHMENTS* did not schedule attachments on, 7 days"; }
pass "defaults with no new variable set: attachments on, 7-day tarball retention, 14-day dumps"

# --- 1. empty attachments volume --------------------------------------------------------------------
psql_q "CREATE TABLE attachments (id text PRIMARY KEY, sha256 text NOT NULL, \"deletedAt\" timestamptz)" >/dev/null
OUT=$(run_backup) || { echo "$OUT" >&2; die "a run against an empty attachments volume failed"; }
TS1=$(ts_of "$OUT")
in_backups "test -s /b/app-$TS1.dump && test -s /b/attachments-$TS1.tar.gz" \
  || { echo "$OUT" >&2; die "empty volume: the matched pair app-$TS1.dump + attachments-$TS1.tar.gz was not written"; }
LIST=$(in_backups "tar -tzf /b/attachments-$TS1.tar.gz")
[ "$LIST" = "./" ] || die "empty volume: expected an archive holding only ./, got: $LIST"
echo "$OUT" | grep -q "0 blob(s), verified" || die "empty volume: the log does not report 0 blobs"
pass "empty volume: matched pair written, archive verifies, 0 blobs"

# --- 2. seeded volume -------------------------------------------------------------------------------
# Content-addressed blobs (<sha[0:2]>/<sha256>, owned by uid 1000 like the api writes them), one old
# mtime to prove it survives, a larger random blob, and an in-flight tmp/ upload that must be skipped.
in_att '
  set -e
  mkdir -p /a/tmp
  i=0
  for content in "warranty.pdf bytes" "invoice OC-4512" "kb screenshot" "delivery note"; do
    i=$((i + 1)); f=/a/tmp/seed$i; printf "%s" "$content" > "$f"
    sha=$(sha256sum "$f" | cut -d" " -f1); mkdir -p "/a/${sha%"${sha#??}"}"; mv "$f" "/a/${sha%"${sha#??}"}/$sha"
  done
  head -c 3000000 /dev/urandom > /a/tmp/big
  sha=$(sha256sum /a/tmp/big | cut -d" " -f1); mkdir -p "/a/${sha%"${sha#??}"}"; mv /a/tmp/big "/a/${sha%"${sha#??}"}/$sha"
  echo "half-written upload" > /a/tmp/inflight-upload
  first=$(find /a -type f -path "/a/??/*" | sort | head -n1); touch -d "2020-01-02 03:04:05" "$first"
  chown -R 1000:1000 /a
'
MANIFEST_SRC=$(in_att 'cd /a && find . -type f -path "./??/*" | sort | while read -r f; do echo "$(sha256sum "$f" | cut -d" " -f1) $(stat -c "%u:%g %Y" "$f") $f"; done')
NBLOBS=$(echo "$MANIFEST_SRC" | wc -l | tr -d ' ')
[ "$NBLOBS" -eq 5 ] || die "seed: expected 5 blobs, found $NBLOBS"
# One row per blob, plus a soft-deleted row whose blob the GC already reclaimed (no file expected).
for path in $(echo "$MANIFEST_SRC" | awk '{print $4}'); do
  sha=$(basename "$path"); psql_q "INSERT INTO attachments VALUES ('row-$sha', '$sha', NULL)" >/dev/null
done
psql_q "INSERT INTO attachments VALUES ('row-gone', 'deadbeef', now())" >/dev/null

OUT=$(run_backup) || { echo "$OUT" >&2; die "a run against a seeded volume failed"; }
TS2=$(ts_of "$OUT")
echo "$OUT" | grep -q "$NBLOBS blob(s), verified" || { echo "$OUT" >&2; die "seeded: the log does not report $NBLOBS blobs"; }
LIST=$(in_backups "tar -tzf /b/attachments-$TS2.tar.gz")
for path in $(echo "$MANIFEST_SRC" | awk '{print $4}'); do
  echo "$LIST" | grep -qx "$path" || die "seeded: $path missing from the tarball"
done
echo "$LIST" | grep -q 'tmp' && die "seeded: tmp/ (in-flight uploads) was archived: $LIST"
in_backups 'ls /b' | grep -q '\.partial$' && die "seeded: a *.partial file was left behind"
pass "seeded volume: all $NBLOBS blobs archived, tmp/ skipped, no partial file"

# --- 3. disaster recovery: lose both volumes, restore per the runbook -----------------------------
ROWS_BEFORE=$(psql_q "SELECT count(*) FROM attachments")
$DC down >/dev/null 2>&1
docker volume rm "$DB_VOL" "$ATT_VOL" >/dev/null
# Runbook order: DB first ...
$DC up -d --wait db >/dev/null 2>&1 || die "restore: fresh db did not come up"
in_backups "cat /b/app-$TS2.dump" | $DC exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  || die "restore: pg_restore of app-$TS2.dump failed"
# ... then attachments, with the api down: the exact command from docs/05-runbooks/backups.md.
$DC run --rm --no-deps -T -v "$ATT_VOL:/restore" backup \
  sh -c "find /restore -mindepth 1 -delete && tar -xzf /backups/attachments-$TS2.tar.gz -C /restore --numeric-owner" \
  >/dev/null 2>&1 || die "restore: the documented attachments restore command failed"
MANIFEST_DST=$(in_att 'cd /a && find . -type f -path "./??/*" | sort | while read -r f; do echo "$(sha256sum "$f" | cut -d" " -f1) $(stat -c "%u:%g %Y" "$f") $f"; done')
[ "$MANIFEST_SRC" = "$MANIFEST_DST" ] || { printf 'src:\n%s\ndst:\n%s\n' "$MANIFEST_SRC" "$MANIFEST_DST" >&2; die "restore: blobs differ (bytes, owner or mtime)"; }
echo "$MANIFEST_DST" | while read -r sum _ _ path; do
  [ "$sum" = "$(basename "$path")" ] || die "restore: $path does not hash to its own name"
done
[ "$(in_att 'stat -c %u:%g /a')" = "1000:1000" ] || die "restore: the volume root is not owned by uid 1000 (the api could not write tmp/)"
ROWS_AFTER=$(psql_q "SELECT count(*) FROM attachments")
[ "$ROWS_BEFORE" = "$ROWS_AFTER" ] || die "restore: attachments rows $ROWS_BEFORE before, $ROWS_AFTER after"
for sha in $(psql_q "SELECT sha256 FROM attachments WHERE \"deletedAt\" IS NULL"); do
  in_att "test -f /a/$(echo "$sha" | cut -c1-2)/$sha" || die "restore: live row with sha $sha has no blob"
done
pass "restore: DB then attachments — $ROWS_AFTER rows, $NBLOBS blobs identical (bytes, owner, mtime), every live row has its blob"

$DC up -d backup >/dev/null 2>&1 || die "could not bring the backup sidecar back up after the restore"
i=0
until $DC exec -T backup test -x /usr/local/bin/lazyit-backup 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 60 ] || die "the backup sidecar never came back"; sleep 1
done

# --- 4. disk guard ----------------------------------------------------------------------------------
in_backups 'touch -d "2000-01-01 00:00:00" /b/attachments-20000101-000000.tar.gz /b/app-20000101-000000.dump && echo keep > /b/keep-me.txt'
if OUT=$(run_backup -e BACKUP_MIN_FREE_MB=999999999 -e 'BACKUP_ON_FAILURE_CMD=echo "$1" > /backups/alert.txt'); then
  echo "$OUT" >&2; die "disk guard: a run that cannot fit the tarball exited 0"
fi
TS3=$(ts_of "$OUT")
echo "$OUT" | grep -q "FAILED run $TS3: not enough free space for the attachments tarball" \
  || { echo "$OUT" >&2; die "disk guard: no greppable FAILED line"; }
in_backups "test -s /b/app-$TS3.dump" || die "disk guard: the DB dump of the same run was not kept"
in_backups "test ! -e /b/attachments-$TS3.tar.gz && test -s /b/attachments-$TS2.tar.gz" \
  || die "disk guard: a tarball was written, or the last good one is gone"
in_backups "grep -q 'not enough free space' /b/alert.txt" || die "disk guard: BACKUP_ON_FAILURE_CMD did not receive the reason"
in_backups 'test -e /b/attachments-20000101-000000.tar.gz' || die "disk guard: a failed attachments step pruned an old tarball"
in_backups 'ls /b' | grep -q '\.partial$' && die "disk guard: a *.partial file was left behind"
if OUT=$(run_backup -e BACKUP_MIN_FREE_MB=lots); then die "disk guard: a non-numeric BACKUP_MIN_FREE_MB was accepted"; fi
echo "$OUT" | grep -q "BACKUP_MIN_FREE_MB must be a whole number" || { echo "$OUT" >&2; die "disk guard: no reason for a bad BACKUP_MIN_FREE_MB"; }
pass "disk guard: refuses before writing, keeps the dump and the last good tarball, fires the alert hook"

# --- 5 + 6. retention and the offsite hook ----------------------------------------------------------
# DAYS10: evaluated by the container shell — a touch -d timestamp 10 days ago (busybox date).
DAYS10='$(date -d @$(( $(date +%s) - 10 * 86400 )) "+%Y-%m-%d %H:%M:%S")'
in_backups "mkdir -p /b/offsite && touch -d \"$DAYS10\" /b/attachments-old10.tar.gz /b/app-old10.dump"
OUT=$(run_backup -e 'BACKUP_OFFSITE_CMD=cp "$1" /backups/offsite/') || { echo "$OUT" >&2; die "offsite: the run failed"; }
TS4=$(ts_of "$OUT")
in_backups "test -s /b/offsite/app-$TS4.dump && test -s /b/offsite/attachments-$TS4.tar.gz" \
  || { echo "$OUT" >&2; die "offsite: the hook did not receive both files of the run"; }
pass "offsite hook: both files of the run copied, documented \"\$1\" form"
in_backups 'test ! -e /b/attachments-20000101-000000.tar.gz && test ! -e /b/app-20000101-000000.dump' \
  || die "retention: files past their retention were not pruned"
in_backups 'test ! -e /b/attachments-old10.tar.gz' || die "retention: a 10-day-old tarball survived the 7-day attachments retention"
in_backups 'test -e /b/app-old10.dump' || die "retention: a 10-day-old dump was pruned (the dumps keep 14 days)"
in_backups 'test -e /b/keep-me.txt' || die "retention: a file that is not a backup was pruned"
pass "retention: tarballs 7 days, dumps 14 days (a 10-day-old tarball pruned, a 10-day-old dump kept), other files kept"

# --- 7. opt-out and bad values ----------------------------------------------------------------------
in_backups "touch -d \"$DAYS10\" /b/attachments-old10b.tar.gz"
OUT=$(run_backup -e BACKUP_ATTACHMENTS=false) || { echo "$OUT" >&2; die "opt-out: a run with BACKUP_ATTACHMENTS=false failed"; }
TS5=$(ts_of "$OUT")
echo "$OUT" | grep -q "attachments: skipped (BACKUP_ATTACHMENTS=false)" || { echo "$OUT" >&2; die "opt-out: no skip line in the log"; }
in_backups "test -s /b/app-$TS5.dump" || die "opt-out: the DB dump was not written"
in_backups "test ! -e /b/attachments-$TS5.tar.gz" || die "opt-out: a tarball was written anyway"
in_backups "test -s /b/attachments-$TS4.tar.gz" || die "opt-out: the last good tarball is gone"
in_backups 'test ! -e /b/attachments-old10b.tar.gz' || die "opt-out: old tarballs no longer age out"
pass "opt-out: BACKUP_ATTACHMENTS=false writes the dump only, exits 0, keeps the last tarball, old ones still age out"
if OUT=$(run_backup -e BACKUP_ATTACHMENTS=maybe); then die "opt-out: BACKUP_ATTACHMENTS=maybe was accepted"; fi
TS6=$(ts_of "$OUT")
echo "$OUT" | grep -q "FAILED run $TS6: BACKUP_ATTACHMENTS must be true or false" || { echo "$OUT" >&2; die "opt-out: no reason for a bad BACKUP_ATTACHMENTS"; }
in_backups "test -s /b/app-$TS6.dump && test ! -e /b/attachments-$TS6.tar.gz" || die "opt-out: bad value — dump missing or tarball written"
if OUT=$(run_backup -e BACKUP_ATTACHMENTS_RETENTION_DAYS=week); then die "retention: a non-numeric BACKUP_ATTACHMENTS_RETENTION_DAYS was accepted"; fi
echo "$OUT" | grep -q "BACKUP_ATTACHMENTS_RETENTION_DAYS must be a whole number" || { echo "$OUT" >&2; die "retention: no reason for a bad BACKUP_ATTACHMENTS_RETENTION_DAYS"; }
pass "bad values: unknown BACKUP_ATTACHMENTS / non-numeric retention fail loud, the dump is kept"

echo "all $PASS checks passed"
