#!/bin/sh
# =============================================================================
# start-adds-missing-keys.sh — leave-behind smoke for start.sh on an EXISTING install (ADR-0047
# amendment 2026-09-26). Proves that re-running ./infra/start.sh over a populated deploy (the
# `git pull` + start.sh upgrade path):
#   - APPENDS a missing allowlisted key (SMTP_SECRET_KEY, AI_SECRET_KEY, DIRECTORY_SECRET_KEY) exactly
#     once, 64 hex, each on its own axis,
#   - leaves every existing byte of .env.prod untouched (the old file is a byte prefix of the new one),
#   - backs the old file up first (mode 600) and keeps .env.prod at mode 600,
#   - never prints a generated value,
#   - is idempotent (a second run writes nothing and takes no second backup),
#   - PRESERVES an already-present key verbatim, whatever its encoding,
#   - NEVER generates a non-allowlisted key (WORKFLOW_SECRET_KEY, MEILI_MASTER_KEY, …) — only reports it,
#   - REFUSES an install still wired to the removed bundled Zitadel (ADR-0102 §7) on any of its signals,
#     writing nothing and running no docker command beyond the read-only probes — while a BYOI or a
#     local install next to a leftover Zitadel volume is NOT refused,
#   - writes nothing under --dry-run.
#
# Fully OFFLINE, via start.sh's test seams (NEVER set in a real deploy): LAZYIT_ENV_FILE,
# LAZYIT_SKIP_DOCKER, LAZYIT_SKIP_BRINGUP. The volume-signal scenarios run without LAZYIT_SKIP_DOCKER
# against a fake `docker` on PATH that logs every call. Needs openssl, like start.sh itself.
#
# Run from anywhere:  sh infra/test/start-adds-missing-keys.sh
# =============================================================================
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)
cd "$REPO_ROOT"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

fail=0
flunk() { echo "FAIL: $*"; fail=1; }

S_PGPW="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef00000000"
S_WORKFLOW="1111111111111111111111111111111111111111111111111111111111111111"
S_SESSION="2222222222222222222222222222222222222222222222222222222222222222"
S_MASTER="0123456789abcdef0123456789abcdef"
S_SMTP="SMTPsentinelRAWkey32charsLong!!!"   # a 32-char RAW key the API accepts — must survive verbatim
S_DIR="RElSc2VudGluZWxCQVNFNjRrZXkzMmJ5dGVzTG9uZyE="  # base64 of 32 bytes (44 chars) — also accepted, also verbatim

# run_start <envfile> <logfile> [extra flags] — an existing-install run of start.sh, docker-free.
run_start() {
  _f=$1; _log=$2; shift 2
  LAZYIT_ENV_FILE="$_f" LAZYIT_SKIP_DOCKER=1 LAZYIT_SKIP_BRINGUP=1 \
    sh infra/start.sh --yes "$@" >"$_log" 2>&1
}
# run_start_fake_docker <envfile> <logfile> <volumes> — the same run, through the fake docker below.
run_start_fake_docker() {
  _f=$1; _log=$2; _vols=$3
  : >"$WORK/docker.calls"
  PATH="$WORK/bin:$PATH" FAKE_DOCKER_VOLUMES="$_vols" FAKE_DOCKER_LOG="$WORK/docker.calls" \
    LAZYIT_ENV_FILE="$_f" LAZYIT_SKIP_BRINGUP=1 \
    sh infra/start.sh --yes >"$_log" 2>&1
}
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1 $2" in
  "volume ls")      for _v in $FAKE_DOCKER_VOLUMES; do printf '%s\n' "$_v"; done ;;
  "volume inspect") exit 1 ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/docker"
# Only the read-only probes start.sh makes before bring-up may reach docker.
docker_calls_read_only() {
  ! grep -vxE 'info|compose version|volume ls -q|volume inspect .*' "$WORK/docker.calls" >/dev/null
}
val() { grep -E "^$2=" "$1" | head -n1 | cut -d= -f2- || true; }
count() { grep -cE "^$2=" "$1" || true; }
perm() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
backups() { ls "$1".bak-* 2>/dev/null | wc -l | tr -d ' '; }
is_hex64() { case "$1" in *[!0-9a-f]*|'') return 1 ;; esac; [ "${#1}" -eq 64 ]; }

# ---------------------------------------------------------------------------
# Scenario 1 — a v1.11-era local-auth .env.prod: no SMTP_SECRET_KEY, no AI_SECRET_KEY, no
# DIRECTORY_SECRET_KEY, and (on purpose)
# no WORKFLOW_SECRET_KEY either — a key that must NEVER be generated for an existing install.
# ---------------------------------------------------------------------------
E1="$WORK/local/.env.prod"; mkdir -p "$WORK/local"
(umask 077; cat >"$E1" <<EOF
# operator comment that must survive
AUTH_MODE=local
POSTGRES_PASSWORD=${S_PGPW}
DATABASE_URL=postgresql://lazyit:${S_PGPW}@db:5432/lazyit?schema=public
MEILI_MASTER_KEY=MEILIsentinel==
AUTH_SECRET=AUTHsentinel=
SESSION_SIGNING_SECRET=${S_SESSION}
LAZYIT_SITE_ADDRESS=localhost
WEB_ORIGIN=https://localhost:8443
EOF
)
cp "$E1" "$WORK/e1.orig"

run_start "$E1" "$WORK/run1.log" || { cat "$WORK/run1.log"; flunk "start.sh (existing install) exited non-zero"; }

_smtp=$(val "$E1" SMTP_SECRET_KEY); _ai=$(val "$E1" AI_SECRET_KEY); _dir=$(val "$E1" DIRECTORY_SECRET_KEY)
is_hex64 "$_smtp" || flunk "SMTP_SECRET_KEY was not added as 64 hex (got '${_smtp:-<missing>}')"
is_hex64 "$_ai"   || flunk "AI_SECRET_KEY was not added as 64 hex (got '${_ai:-<missing>}')"
is_hex64 "$_dir"  || flunk "DIRECTORY_SECRET_KEY was not added as 64 hex (got '${_dir:-<missing>}')"
[ "$_smtp" != "$_ai" ] || flunk "AI_SECRET_KEY reuses SMTP_SECRET_KEY's value"
[ "$_dir" != "$_smtp" ] && [ "$_dir" != "$_ai" ] || flunk "DIRECTORY_SECRET_KEY reuses another at-rest key's value"
[ "$(count "$E1" SMTP_SECRET_KEY)" -eq 1 ] || flunk "SMTP_SECRET_KEY is not present exactly once"
[ "$(count "$E1" AI_SECRET_KEY)" -eq 1 ]   || flunk "AI_SECRET_KEY is not present exactly once"
[ "$(count "$E1" DIRECTORY_SECRET_KEY)" -eq 1 ] || flunk "DIRECTORY_SECRET_KEY is not present exactly once"
[ "$(count "$E1" WORKFLOW_SECRET_KEY)" -eq 0 ] || flunk "WORKFLOW_SECRET_KEY was GENERATED — it protects existing data and must never be"
grep -q 'WORKFLOW_SECRET_KEY' "$WORK/run1.log" || flunk "the missing, non-generatable WORKFLOW_SECRET_KEY was not reported to the operator"
# Existing bytes untouched: the original file is a byte prefix of the new one.
head -c "$(wc -c <"$WORK/e1.orig" | tr -d ' ')" "$E1" | cmp -s - "$WORK/e1.orig" \
  || flunk "existing lines of .env.prod were modified or reordered"
grep -qE '^# --- Added by infra/start.sh on [0-9-]+T[0-9:]+Z' "$E1" || flunk "no dated comment line above the appended keys"
[ "$(perm "$E1")" = "600" ] || flunk ".env.prod is mode $(perm "$E1"), not 600"
[ "$(backups "$E1")" -eq 1 ] || flunk "expected exactly one backup, found $(backups "$E1")"
_bak=$(ls "$E1".bak-* 2>/dev/null | head -n1 || true)
if [ -n "$_bak" ]; then
  cmp -s "$_bak" "$WORK/e1.orig" || flunk "the backup is not the original file"
  [ "$(perm "$_bak")" = "600" ] || flunk "the backup is mode $(perm "$_bak"), not 600"
fi
# Names printed, never values.
grep -q 'SMTP_SECRET_KEY' "$WORK/run1.log" || flunk "the added key names were not printed"
grep -q 'DIRECTORY_SECRET_KEY' "$WORK/run1.log" || flunk "the added DIRECTORY_SECRET_KEY name was not printed"
for _v in "$_smtp" "$_ai" "$_dir"; do
  if [ -n "$_v" ] && grep -qF "$_v" "$WORK/run1.log"; then flunk "a generated value was printed"; fi
done

# ---------------------------------------------------------------------------
# Scenario 2 — idempotent: a second run changes nothing and takes no second backup.
# ---------------------------------------------------------------------------
cp "$E1" "$WORK/e1.after1"
run_start "$E1" "$WORK/run2.log" || flunk "start.sh (second run) exited non-zero"
cmp -s "$E1" "$WORK/e1.after1" || flunk "a second run modified .env.prod (not idempotent)"
[ "$(backups "$E1")" -eq 1 ] || flunk "a second run took another backup"

# ---------------------------------------------------------------------------
# Scenario 3 — already-present keys (hand-added: SMTP in raw encoding, DIRECTORY as base64 of 32 bytes,
# neither 64 hex) are PRESERVED verbatim; only the missing AI key is appended. The file has NO trailing
# newline, so the last line must stay intact.
# ---------------------------------------------------------------------------
E3="$WORK/present/.env.prod"; mkdir -p "$WORK/present"
(umask 077; printf 'AUTH_MODE=local\nWORKFLOW_SECRET_KEY=%s\nSESSION_SIGNING_SECRET=%s\nSMTP_SECRET_KEY=%s\nDIRECTORY_SECRET_KEY=%s\nWEB_ORIGIN=https://localhost:8443' \
  "$S_WORKFLOW" "$S_SESSION" "$S_SMTP" "$S_DIR" >"$E3")
run_start "$E3" "$WORK/run3.log" || flunk "start.sh (present SMTP key) exited non-zero"
[ "$(val "$E3" SMTP_SECRET_KEY)" = "$S_SMTP" ] || flunk "an existing SMTP_SECRET_KEY was not preserved verbatim"
[ "$(count "$E3" SMTP_SECRET_KEY)" -eq 1 ] || flunk "a present SMTP_SECRET_KEY was duplicated"
[ "$(val "$E3" DIRECTORY_SECRET_KEY)" = "$S_DIR" ] || flunk "an existing (base64) DIRECTORY_SECRET_KEY was not preserved verbatim"
[ "$(count "$E3" DIRECTORY_SECRET_KEY)" -eq 1 ] || flunk "a present DIRECTORY_SECRET_KEY was duplicated"
[ "$(val "$E3" WORKFLOW_SECRET_KEY)" = "$S_WORKFLOW" ] || flunk "WORKFLOW_SECRET_KEY changed"
[ "$(val "$E3" WEB_ORIGIN)" = "https://localhost:8443" ] || flunk "the last line (no trailing newline) was damaged"
is_hex64 "$(val "$E3" AI_SECRET_KEY)" || flunk "AI_SECRET_KEY was not added next to a present SMTP key"

# ---------------------------------------------------------------------------
# Scenario 4 — installs still wired to the removed bundled Zitadel (ADR-0102 §7) are REFUSED before
# anything is written: non-zero exit, the runbook named, the file byte-identical, no backup.
# ---------------------------------------------------------------------------
# assert_refused <name> <envfile> <logfile>
assert_refused() {
  grep -q 'ADR-0102' "$3" || flunk "$1: the refusal does not name ADR-0102"
  grep -q 'docs/05-runbooks/migrate-off-bundled-zitadel.md' "$3" || flunk "$1: the refusal does not point at the migration runbook"
  grep -q 'nothing was changed' "$3" || flunk "$1: the refusal does not say nothing was changed"
  cmp -s "$2" "$WORK/$1.orig" || flunk "$1: .env.prod was modified by a refused run"
  [ "$(backups "$2")" -eq 0 ] || flunk "$1: a refused run took a backup"
  [ "$(count "$2" SMTP_SECRET_KEY)" -eq 0 ] || flunk "$1: a refused run appended keys"
}

# 4a — AUTH_MODE=oidc with an active ZITADEL_MASTERKEY.
E4="$WORK/oidc/.env.prod"; mkdir -p "$WORK/oidc"
(umask 077; cat >"$E4" <<EOF
AUTH_MODE=oidc
POSTGRES_PASSWORD=${S_PGPW}
WORKFLOW_SECRET_KEY=${S_WORKFLOW}
ZITADEL_MASTERKEY=${S_MASTER}
ZITADEL_EXTERNALDOMAIN=auth.localhost
WEB_ORIGIN=https://localhost:8443
EOF
)
cp "$E4" "$WORK/s4a.orig"
if run_start "$E4" "$WORK/run4a.log"; then flunk "4a: a bundled install (active ZITADEL_MASTERKEY) was not refused"; fi
assert_refused s4a "$E4" "$WORK/run4a.log"

# 4b — no master key, but the internal JWKS URL still points at the bundled container.
E4B="$WORK/oidc-jwks/.env.prod"; mkdir -p "$WORK/oidc-jwks"
(umask 077; printf 'AUTH_MODE=oidc\nWORKFLOW_SECRET_KEY=%s\nOIDC_ISSUER=https://auth.example.com\nOIDC_JWKS_URI=http://zitadel:8080/oauth/v2/keys\n' \
  "$S_WORKFLOW" >"$E4B")
cp "$E4B" "$WORK/s4b.orig"
if run_start "$E4B" "$WORK/run4b.log"; then flunk "4b: a bundled install (OIDC_JWKS_URI at zitadel:8080) was not refused"; fi
assert_refused s4b "$E4B" "$WORK/run4b.log"

# 4c — only the leftover Zitadel DB volume and no OIDC_CLIENT_ID (the sidecar used to supply it).
E4C="$WORK/oidc-vol/.env.prod"; mkdir -p "$WORK/oidc-vol"
(umask 077; printf 'AUTH_MODE=oidc\nWORKFLOW_SECRET_KEY=%s\nOIDC_ISSUER=https://auth.example.com\n' "$S_WORKFLOW" >"$E4C")
cp "$E4C" "$WORK/s4c.orig"
if run_start_fake_docker "$E4C" "$WORK/run4c.log" "lazyit-prod_db_data lazyit-prod_zitadel_db_data lazyit-prod_zitadel_secrets"; then
  flunk "4c: a bundled install (zitadel_db_data volume, no OIDC_CLIENT_ID) was not refused"
fi
assert_refused s4c "$E4C" "$WORK/run4c.log"
docker_calls_read_only || flunk "4c: a refused run invoked docker beyond the read-only probes: $(tr '\n' ';' <"$WORK/docker.calls")"

# 4d — a BYOI install next to the same leftover volume is NOT refused (it has its own client).
E4D="$WORK/byoi/.env.prod"; mkdir -p "$WORK/byoi"
(umask 077; printf 'AUTH_MODE=oidc\nWORKFLOW_SECRET_KEY=%s\nOIDC_ISSUER=https://login.example.com\nOIDC_JWKS_URI=https://login.example.com/keys\nOIDC_CLIENT_ID=lazyit\nWEB_ORIGIN=https://lazyit.example.com\n' \
  "$S_WORKFLOW" >"$E4D")
run_start_fake_docker "$E4D" "$WORK/run4d.log" "lazyit-prod_db_data lazyit-prod_zitadel_db_data" \
  || { cat "$WORK/run4d.log"; flunk "4d: a BYOI install was refused"; }
is_hex64 "$(val "$E4D" SMTP_SECRET_KEY)" || flunk "4d: SMTP_SECRET_KEY was not added on a BYOI install"
grep -q 'existing deploy auth mode: byoi' "$WORK/run4d.log" || flunk "4d: the install was not detected as BYOI"
docker_calls_read_only || flunk "4d: start.sh invoked docker beyond the read-only probes: $(tr '\n' ';' <"$WORK/docker.calls")"

# 4e — a local-auth install never used the IdP: a stray Zitadel volume does not refuse it.
E4E="$WORK/local-vol/.env.prod"; mkdir -p "$WORK/local-vol"
(umask 077; printf 'AUTH_MODE=local\nWORKFLOW_SECRET_KEY=%s\nSESSION_SIGNING_SECRET=%s\nWEB_ORIGIN=https://localhost:8443\n' \
  "$S_WORKFLOW" "$S_SESSION" >"$E4E")
run_start_fake_docker "$E4E" "$WORK/run4e.log" "lazyit-prod_db_data lazyit-prod_zitadel_db_data" \
  || { cat "$WORK/run4e.log"; flunk "4e: a local install with a leftover Zitadel volume was refused"; }

# ---------------------------------------------------------------------------
# Scenario 5 — --dry-run writes nothing (and takes no backup), but names what it would add.
# ---------------------------------------------------------------------------
E5="$WORK/dry/.env.prod"; mkdir -p "$WORK/dry"
(umask 077; printf 'AUTH_MODE=local\nWORKFLOW_SECRET_KEY=%s\n' "$S_WORKFLOW" >"$E5")
cp "$E5" "$WORK/e5.orig"
run_start "$E5" "$WORK/run5.log" --dry-run || flunk "start.sh --dry-run exited non-zero"
cmp -s "$E5" "$WORK/e5.orig" || flunk "--dry-run modified .env.prod"
[ "$(backups "$E5")" -eq 0 ] || flunk "--dry-run took a backup"
grep -q 'would append' "$WORK/run5.log" || flunk "--dry-run did not say what it would add"
grep 'would append' "$WORK/run5.log" | grep -q 'DIRECTORY_SECRET_KEY' || flunk "--dry-run did not name DIRECTORY_SECRET_KEY"

[ "$fail" -eq 0 ] || { echo "start-adds-missing-keys: FAILED"; exit 1; }
echo "start-adds-missing-keys: OK — missing allowlisted keys appended once (backup, 600, names only), existing keys and lines untouched, non-allowlisted keys never generated, bundled-Zitadel leftovers refused with nothing changed, idempotent, dry-run writes nothing"
