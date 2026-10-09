#!/bin/sh
# infra/update.sh per auth mode (#1545): envs come from start.sh itself, so its per-mode commenting and update.sh's check cannot drift apart.
# Offline: update.sh is sourced via LAZYIT_UPDATE_LIB_ONLY and docker compose is a stub. Run: sh infra/test/update-mode-aware.sh
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

# lib <env-file> <snippet> — run <snippet> with update.sh sourced and INSTALL_MODE detected as main() does.
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
    ' lib "$UPDATE_SH" "$EXAMPLE" "$1" "$WORK/fake-dc" "$2" 2>&1
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
  lib "$1" 'backup_databases; echo "zitadel-dump=[$BACKUP_ZITADEL]"; print_restore_commands; print_success'
  sed 's/^/log: /' "$FAKE_DC_LOG"
}

# Blank answers take the default; lan skips the auth question (it forces local).
render lan     'lan\n\n\n\n'
render local   'local\nlocal\n\n\n'
render byoi    'local\nbyoi\nhttps://login.example.com\nclient-id\nclient-secret\n\n\n'
render bundled 'local\nbundled\n\n\n'

# 1. Mode detection, including pre-ADR-0086 files with no AUTH_MODE line.
for m in local byoi bundled; do
  check "$m install detected as $m" "$(lib "$WORK/$m.env" 'echo "mode=$INSTALL_MODE"')" "^mode=$m$"
done
check "lan install detected as local" "$(lib "$WORK/lan.env" 'echo "mode=$INSTALL_MODE"')" "^mode=local$"
without "$WORK/bundled.env" "$WORK/legacy-bundled.env" AUTH_MODE
check "no AUTH_MODE + active ZITADEL_MASTERKEY is bundled" \
  "$(lib "$WORK/legacy-bundled.env" 'echo "mode=$INSTALL_MODE"')" "^mode=bundled$"
without "$WORK/byoi.env" "$WORK/legacy-byoi.env" AUTH_MODE
check "no AUTH_MODE + no ZITADEL_MASTERKEY is BYOI" \
  "$(lib "$WORK/legacy-byoi.env" 'echo "mode=$INSTALL_MODE"')" "^mode=byoi$"

# 2. A fresh install of every mode has nothing missing.
for m in lan local byoi bundled; do
  check "$m install: no env key reported missing" \
    "$(lib "$WORK/$m.env" 'echo "missing=[$(missing_env_keys | tr "\n" " ")]"')" '^missing=\[\]$'
done

# 3. A genuine gap is still reported in every mode.
without "$WORK/local.env" "$WORK/local-gap.env" REDIS_URL WEB_ORIGIN
check "local install: a missing REDIS_URL and pinned WEB_ORIGIN are reported" \
  "$(lib "$WORK/local-gap.env" 'missing_env_keys | tr "\n" " "')" '(^| )REDIS_URL WEB_ORIGIN '
without "$WORK/byoi.env" "$WORK/byoi-gap.env" OIDC_ISSUER AUTH_ISSUER
check "BYOI install: a missing OIDC_ISSUER and AUTH_ISSUER are reported" \
  "$(lib "$WORK/byoi-gap.env" 'missing_env_keys | tr "\n" " "')" '(^| )AUTH_ISSUER OIDC_ISSUER '
without "$WORK/bundled.env" "$WORK/bundled-gap.env" ZITADEL_EXTERNALDOMAIN OIDC_JWKS_URI
check "bundled install: a missing ZITADEL_EXTERNALDOMAIN and OIDC_JWKS_URI are reported" \
  "$(lib "$WORK/bundled-gap.env" 'missing_env_keys | tr "\n" " "')" '(^| )OIDC_JWKS_URI ZITADEL_EXTERNALDOMAIN '

# 4. zitadel_db is dumped only on a bundled install, and restore commands match the dumps taken.
for m in lan local byoi; do
  check "$m install: only the app database is dumped" "$(backup "$WORK/$m.env")" \
    '^zitadel-dump=\[\]$' 'zitadel_db|restore point \(zitadel\)'
done
out=$(backup "$WORK/bundled.env")
check "bundled install: the app database is dumped and verified" "$out" '^log: exec db pg_restore$'
check "bundled install: zitadel_db is dumped and verified" "$out" '^log: exec zitadel_db pg_restore$'
check "bundled install: the zitadel restore command is printed" "$out" \
  'exec -T zitadel_db sh -c .pg_restore .*-zitadel\.dump$'

# 5. A failed dump of a database the install runs still aborts.
export FAKE_DC_DOWN=zitadel_db
check "bundled install: a failed zitadel_db dump aborts" "$(backup "$WORK/bundled.env")" \
  'zitadel database backup FAILED' '^zitadel-dump='
export FAKE_DC_DOWN=db
check "local install: a failed app dump aborts" "$(backup "$WORK/local.env")" \
  'app database backup FAILED' '^zitadel-dump='
unset FAKE_DC_DOWN

echo
if [ "$fail" -ne 0 ]; then
  echo "update-mode-aware: FAILED ($pass passed)"
  exit 1
fi
echo "update-mode-aware: all $pass checks passed"
