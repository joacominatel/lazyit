#!/bin/sh
# infra/update.sh claiming its UpdateRun row (ADR-0084 §4) under the one-active-run index: a pending request for
# another target is superseded, never deleted, in the same transaction as the insert. Offline: update.sh is
# sourced via LAZYIT_UPDATE_LIB_ONLY and psql is a stub that records the SQL it is fed. Run: sh infra/test/update-run-row.sh
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)
UPDATE_SH="$REPO_ROOT/infra/update.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

fail=0
pass=0
flunk() { echo "FAIL: $*"; fail=1; }

# Fake `docker compose`: each `exec db … psql` appends its SQL to $FAKE_SQL as one block, then answers the claim
# SELECT with $FAKE_REQUESTED_ID and an INSERT with 42. $FAKE_DB_DOWN makes every exec fail like a stopped db.
cat >"$WORK/fake-dc" <<'EOF'
#!/bin/sh
[ "$1" = exec ] || exit 0
[ -z "${FAKE_DB_DOWN:-}" ] || exit 1
sql=$(cat)
printf '%s\n--\n' "$sql" >>"$FAKE_SQL"
case "$sql" in
  "SELECT id FROM update_runs WHERE status='requested'"*) [ -z "${FAKE_REQUESTED_ID:-}" ] || echo "$FAKE_REQUESTED_ID" ;;
  *"INSERT INTO update_runs"*) echo 42 ;;
esac
EOF
chmod +x "$WORK/fake-dc"
export FAKE_SQL="$WORK/sql.log"

# claim — run claim_update_run for v2.1.0 -> v2.2.0, then print its output, the resulting RUN_ID and every SQL block.
claim() {
  : >"$FAKE_SQL"
  (
    # shellcheck disable=SC2016  # expanded by the inner sh, on purpose
    LAZYIT_UPDATE_LIB_ONLY=1 sh -c '
      . "$1"
      DC=$2; FROM_VERSION=v2.1.0; TARGET_TAG=v2.2.0
      claim_update_run
      echo "run_id=[$RUN_ID]"
    ' lib "$UPDATE_SH" "$WORK/fake-dc" 2>&1
  ) || echo "claim_update_run exited non-zero"
  sed 's/^/sql: /' "$FAKE_SQL"
}

# check <description> <output> <pattern that must match> [pattern that must not]
check() {
  _desc=$1; _out=$2; _must=$3; _mustnt=${4:-}
  if ! printf '%s\n' "$_out" | grep -Eq -- "$_must"; then
    flunk "$_desc — output lacks /$_must/:"; printf '%s\n' "$_out" | sed 's/^/    /'; return 0
  fi
  if [ -n "$_mustnt" ] && printf '%s\n' "$_out" | grep -Eq -- "$_mustnt"; then
    flunk "$_desc — output contains /$_mustnt/:"; printf '%s\n' "$_out" | sed 's/^/    /'; return 0
  fi
  pass=$((pass + 1))
  echo "ok   - $_desc"
  [ -z "${VERBOSE:-}" ] || printf '%s\n' "$_out" | sed 's/^/    /'
}

# 1. No pending request for this target: one psql session supersedes any pending request, then inserts, in a transaction.
out=$(claim)
check "no request for the target: a new run is created" "$out" '^run_id=\[42\]$' 'could not record'
session=$(printf '%s\n' "$out" | awk '/^sql: BEGIN;$/ { on = 1 } on { print } on && /^sql: --$/ { exit }')
check "the pending request is superseded, as failed with a reason, in the insert's transaction" "$session" \
  "^sql: UPDATE update_runs SET status='failed', error='Superseded by an operator-run update to v2\\.2\\.0\\.', \"finishedAt\"=now\\(\\), .* WHERE status='requested';$"
check "the supersede comes before the insert, and both commit together" \
  "$(printf '%s\n' "$session" | sed -En 's/^sql: (BEGIN|UPDATE|INSERT|COMMIT).*/\1/p' | tr '\n' ' ')" \
  '^BEGIN UPDATE INSERT COMMIT $'
check "nothing is deleted" "$out" '^sql: ' 'DELETE'

# 2. A pending request for this target is claimed, and nothing is superseded or inserted.
out=$(FAKE_REQUESTED_ID=7 claim)
check "a request for the target is claimed" "$out" '^run_id=\[7\]$' "Superseded|INSERT"
check "the claimed run is stamped backing_up" "$out" "^sql: UPDATE update_runs SET status='backing_up'.* WHERE id=7;$"

# 3. A database error stays non-fatal.
out=$(FAKE_DB_DOWN=1 claim)
check "an unreachable database warns and the update continues" "$out" \
  'could not record an UpdateRun row \(non-fatal' 'exited non-zero'

echo
if [ "$fail" -ne 0 ]; then
  echo "update-run-row: FAILED ($pass passed)"
  exit 1
fi
echo "update-run-row: all $pass checks passed"
