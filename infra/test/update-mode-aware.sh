#!/bin/sh
# infra/update.sh per auth mode (#1545, ADR-0102): envs come from start.sh itself, so its per-mode commenting and update.sh's check cannot drift apart.
# Offline: update.sh is sourced via LAZYIT_UPDATE_LIB_ONLY, or run whole in a sandbox with stub docker and git. Run: sh infra/test/update-mode-aware.sh
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)
UPDATE_SH="$REPO_ROOT/infra/update.sh"
START_SH="$REPO_ROOT/infra/start.sh"
EXAMPLE="$REPO_ROOT/infra/env/.env.prod.example"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

fail=0
pass=0
flunk() { echo "FAIL: $*"; fail=1; }

# render <name> <answers> — a fresh install's .env.prod, answering start.sh's questions in order.
render() {
  if ! (cd "$REPO_ROOT" && printf '%b' "$2" | LAZYIT_ENV_FILE="$WORK/$1.env" LAZYIT_SKIP_DOCKER=1 \
      LAZYIT_SKIP_BRINGUP=1 sh "$START_SH" >"$WORK/$1.log" 2>&1); then
    echo "start.sh could not render the $1 install:"; sed 's/^/    /' "$WORK/$1.log"; exit 1
  fi
}

# without <src> <dst> <KEY…>
without() {
  _src=$1; _dst=$2; shift 2
  cp "$_src" "$_dst"
  for _k in "$@"; do
    grep -v "^${_k}=" "$_dst" >"$_dst.tmp" || true
    mv "$_dst.tmp" "$_dst"
  done
}

# with <src> <dst> <KEY=value…> — <src> plus active lines, as a hand-edited or pre-ADR-0102 file has them.
with() {
  _src=$1; _dst=$2; shift 2
  cp "$_src" "$_dst"
  for _kv in "$@"; do
    grep -v "^${_kv%%=*}=" "$_dst" >"$_dst.tmp" || true
    printf '%s\n' "$_kv" >>"$_dst.tmp"
    mv "$_dst.tmp" "$_dst"
  done
}

# lib <env-file> <snippet> [example] — run <snippet> with update.sh sourced and INSTALL_MODE detected as main() does.
lib() {
  (
    cd "$WORK"
    # shellcheck disable=SC2016  # expanded by the inner sh, on purpose
    LAZYIT_UPDATE_LIB_ONLY=1 sh -c '
      . "$1"
      ENV_EXAMPLE=$2; ENV_FILE=$3; DC=$4
      PREV_REF=0123456789abcdef0123; FROM_VERSION=v2.1.0; TARGET_TAG=v2.2.0
      INSTALL_MODE=$(install_auth_mode)
      eval "$5"
    ' lib "$UPDATE_SH" "${3:-$EXAMPLE}" "$1" "$WORK/fake-dc" "$2" 2>&1
  ) || true
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

# Fake `docker compose`: logs each exec, and every exec into $FAKE_DC_DOWN fails like a stopped service.
cat >"$WORK/fake-dc" <<'EOF'
#!/bin/sh
[ "$1" = exec ] || exit 0
svc=$3; shift 3
echo "exec $svc $1" >>"$FAKE_DC_LOG"
[ "$svc" != "${FAKE_DC_DOWN:-}" ] || exit 1
case "$1" in
  sh) printf 'PGDMP fake dump of %s\n' "$svc" ;;
  pg_restore) cat >/dev/null ;;
esac
EOF
chmod +x "$WORK/fake-dc"
export FAKE_DC_LOG="$WORK/dc.log"

backup() {
  : >"$FAKE_DC_LOG"
  lib "$1" 'backup_databases; print_restore_commands; print_success'
  sed 's/^/log: /' "$FAKE_DC_LOG"
}

# Blank answers take the default; lan skips the auth question (it forces local).
render lan   'lan\n\n\n\n'
render local 'local\nlocal\n\n\n'
render byoi  'local\nbyoi\nhttps://login.example.com\nhttps://login.example.com/oauth2/keys\nclient-id\nclient-secret\n\n\n'

# 1. Mode detection, including a pre-ADR-0086 BYOI file with no AUTH_MODE line.
for m in local byoi; do
  check "$m install detected as $m" "$(lib "$WORK/$m.env" 'echo "mode=$INSTALL_MODE"')" "^mode=$m$"
done
check "lan install detected as local" "$(lib "$WORK/lan.env" 'echo "mode=$INSTALL_MODE"')" "^mode=local$"
without "$WORK/byoi.env" "$WORK/legacy-byoi.env" AUTH_MODE
check "no AUTH_MODE is BYOI" "$(lib "$WORK/legacy-byoi.env" 'echo "mode=$INSTALL_MODE"')" "^mode=byoi$"

# 2. A fresh install of every mode has nothing missing, also when every per-mode key is active in the example.
sed -E 's/^# ((OIDC_[A-Z_]+|AUTH_ISSUER|AUTH_CLIENT_[A-Z]+|SESSION_SIGNING_SECRET)=)/\1/' "$EXAMPLE" >"$WORK/all-active.example"
for m in lan local byoi; do
  check "$m install: no env key reported missing" \
    "$(lib "$WORK/$m.env" 'echo "missing=[$(missing_env_keys | tr "\n" " ")]"')" '^missing=\[\]$'
  check "$m install: no env key reported missing when every auth key is active in the example" \
    "$(lib "$WORK/$m.env" 'echo "missing=[$(missing_env_keys | tr "\n" " ")]"' "$WORK/all-active.example")" \
    '^missing=\[\]$'
done

# 3. A genuine gap is still reported in every mode.
without "$WORK/local.env" "$WORK/local-gap.env" REDIS_URL WEB_ORIGIN
check "local install: a missing REDIS_URL and pinned WEB_ORIGIN are reported" \
  "$(lib "$WORK/local-gap.env" 'missing_env_keys | tr "\n" " "')" '(^| )REDIS_URL WEB_ORIGIN '
without "$WORK/byoi.env" "$WORK/byoi-gap.env" OIDC_ISSUER AUTH_ISSUER AUTH_SECRET
check "BYOI install: a missing AUTH_SECRET is reported" \
  "$(lib "$WORK/byoi-gap.env" 'missing_env_keys | tr "\n" " "')" '(^| )AUTH_SECRET '
check "BYOI install: a missing OIDC_ISSUER and AUTH_ISSUER are reported once the example makes them active" \
  "$(lib "$WORK/byoi-gap.env" 'missing_env_keys | tr "\n" " "' "$WORK/all-active.example")" \
  '(^| )AUTH_ISSUER AUTH_SECRET OIDC_ISSUER '

# 4. Only the app database is dumped, and the restore commands name only it.
for m in lan local byoi; do
  check "$m install: only the app database is dumped and verified" "$(backup "$WORK/$m.env")" \
    '^log: exec db pg_restore$' 'zitadel'
done

# 5. A failed dump still aborts.
export FAKE_DC_DOWN=db
check "local install: a failed app dump aborts" "$(backup "$WORK/local.env")" \
  'app database backup FAILED' 'lazyit updated'
unset FAKE_DC_DOWN

# 6. A bundled install is refused by a full run before any docker or git call; the stubs log every call.
SANDBOX="$WORK/sandbox"
mkdir -p "$SANDBOX/infra/env" "$WORK/bin"
cp "$UPDATE_SH" "$SANDBOX/infra/update.sh"
: >"$SANDBOX/compose.yaml"
: >"$SANDBOX/infra/docker-compose.prod.yaml"
cat >"$WORK/bin/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >>"$FAKE_CALLS"
case "$*" in
  "volume ls -q") printf '%s\n' $FAKE_VOLUMES ;;
  *" ps -q") echo 0123456789ab ;;
  *" exec "*" sh -c "*) printf 'PGDMP fake\n' ;;
  *" exec "*" pg_restore "*) cat >/dev/null ;;
esac
exit 0
EOF
cat >"$WORK/bin/git" <<'EOF'
#!/bin/sh
echo "git $*" >>"$FAKE_CALLS"
case "$1" in
  describe) echo v2.1.0 ;;
  rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;;
  fetch|checkout|cat-file|merge-base) exit 1 ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/git"
export FAKE_CALLS="$WORK/calls.log"

# run_update <env-file> <volumes> — output of a full `update.sh --yes v9.9.9`, then the stub calls and leftovers.
run_update() {
  cp "$1" "$SANDBOX/infra/env/.env.prod"
  rm -rf "$SANDBOX/.update.lock" "$SANDBOX/backups"
  : >"$FAKE_CALLS"
  (cd "$SANDBOX" && PATH="$WORK/bin:$PATH" FAKE_VOLUMES="$2" sh infra/update.sh --yes v9.9.9 2>&1) || true
  grep -v '^docker volume ls -q$' "$FAKE_CALLS" | sed 's/^/call: /' || true
  [ ! -d "$SANDBOX/.update.lock" ] || echo "left: lock"
  [ ! -d "$SANDBOX/backups" ] || echo "left: backups"
}

# refused <description> <env-file> [volumes]
refused() {
  check "$1: refused, pointing to the migration runbook" "$(run_update "$2" "${3:-}")" \
    'migrate-off-bundled-zitadel\.md' '^(call|left): '
}

with "$WORK/byoi.env" "$WORK/bundled.env" ZITADEL_MASTERKEY=0123456789abcdef0123456789abcdef \
  OIDC_ISSUER=https://auth.example.com OIDC_JWKS_URI=http://zitadel:8080/oauth/v2/keys \
  AUTH_INTERNAL_ISSUER=http://zitadel:8080
refused "bundled install" "$WORK/bundled.env"
without "$WORK/bundled.env" "$WORK/bundled-legacy.env" AUTH_MODE
refused "bundled install with no AUTH_MODE line" "$WORK/bundled-legacy.env"
with "$WORK/byoi.env" "$WORK/bundled-jwks.env" OIDC_JWKS_URI=http://zitadel:8080/oauth/v2/keys
refused "an OIDC_JWKS_URI at zitadel:8080 (no master key)" "$WORK/bundled-jwks.env"
with "$WORK/byoi.env" "$WORK/bundled-internal.env" AUTH_INTERNAL_ISSUER=http://zitadel:8080
refused "an AUTH_INTERNAL_ISSUER at zitadel:8080 (no master key)" "$WORK/bundled-internal.env"
without "$WORK/byoi.env" "$WORK/bundled-volume.env" OIDC_CLIENT_ID
refused "a Zitadel database volume and no OIDC_CLIENT_ID" "$WORK/bundled-volume.env" \
  "lazyit-prod_db_data lazyit-prod_zitadel_db_data"

mkdir "$SANDBOX/.update.lock"
cp "$WORK/bundled.env" "$SANDBOX/infra/env/.env.prod"
(cd "$SANDBOX" && PATH="$WORK/bin:$PATH" FAKE_VOLUMES='' sh infra/update.sh --yes v9.9.9 >/dev/null 2>&1) || true
if [ -d "$SANDBOX/.update.lock" ]; then
  pass=$((pass + 1)); echo "ok   - a refusal leaves another run's lock in place"
else
  flunk "a refusal removed a lock it did not take"
fi
rmdir "$SANDBOX/.update.lock" 2>/dev/null || true

# Not refused: the update proceeds to the backup (the stubs stop it later, at the tag fetch).
proceeds() {
  check "$1: not refused" "$(run_update "$2" "${3:-}")" '^call: docker compose .* exec -T db ' \
    'migrate-off-bundled-zitadel'
}
proceeds "BYOI install with its own IdP" "$WORK/byoi.env" "lazyit-prod_db_data lazyit-prod_zitadel_db_data"
with "$WORK/local.env" "$WORK/local-leftover.env" ZITADEL_MASTERKEY=0123456789abcdef0123456789abcdef
proceeds "local install with a stray ZITADEL_MASTERKEY and Zitadel volume" "$WORK/local-leftover.env" \
  "lazyit-prod_zitadel_db_data"

echo
if [ "$fail" -ne 0 ]; then
  echo "update-mode-aware: FAILED ($pass passed)"
  exit 1
fi
echo "update-mode-aware: all $pass checks passed"
