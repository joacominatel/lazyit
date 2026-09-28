#!/bin/sh
# =============================================================================
# reconfigure-preserves-secrets.sh — leave-behind smoke for `start.sh --reconfigure` (issue #1035,
# ADR-0087). Proves the non-trivial invariant: reconfigure re-renders infra/env/.env.prod while
# PRESERVING every secret byte-for-byte (never regenerating them) and never touching volumes.
#
# It is fully OFFLINE — no Docker daemon, no real ports, no real .env.prod. It uses start.sh's
# test seams (all NEVER set in a real deploy):
#   LAZYIT_ENV_FILE     -> point the script at a scratch env file (never the real one)
#   LAZYIT_SKIP_DOCKER  -> skip the docker/openssl prereq checks + host-port probes
#   LAZYIT_SKIP_BRINGUP -> render + write the env file, but do NOT invoke docker
#
# Run from anywhere:  sh infra/test/reconfigure-preserves-secrets.sh
# Exit 0 = secrets preserved; non-zero = a regression (secret changed / dropped).
# =============================================================================
set -eu

# Resolve the repo root from this script's own location (infra/test/x.sh -> ../../).
SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SELF_DIR/../.." && pwd)
cd "$REPO_ROOT"

WORK=$(mktemp -d)
ENVF="$WORK/.env.prod"
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT INT TERM

# Sentinel secrets — recognisable, correct-length values so the render validators pass.
S_PGPW="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef00000000"   # url-safe hex
S_DBURL="postgresql://lazyit:${S_PGPW}@db:5432/lazyit?schema=public"
S_MEILI="MEILIsentinelKEYsentinelKEYsentinel1234=="
S_AUTH="AUTHsentinelSECRETsentinelSECRETsentinelSECRET123="
S_WORKFLOW="1111111111111111111111111111111111111111111111111111111111111111"  # 64 hex
S_SESSION="2222222222222222222222222222222222222222222222222222222222222222"  # 64 hex
# Deliberately a 32-char RAW key, not 64 hex: the API accepts that encoding, and an operator who
# hand-added one before start.sh generated it must not have it rejected — or silently replaced, which
# would orphan the SMTP password already encrypted under it (issue #1269, ADR-0079).
S_SMTP="SMTPsentinelRAWkey32charsLong!!!"
# Same reasoning for the AI provider key's at-rest key (ADR-0097, issue #1322).
S_AI="AIsentinelRAWkey32charsLongxxxxx"
# And for the LDAP bind password's at-rest key (ADR-0091, issue #1271) — here the third encoding the API
# accepts, base64 of 32 bytes (44 chars, not 64): a presence check must not reject it, nor replace it.
S_DIR="RElSc2VudGluZWxCQVNFNjRrZXkzMmJ5dGVzTG9uZyE="

# A pre-existing local-auth install pinned to localhost (the "before").
cat >"$ENVF" <<EOF
AUTH_MODE=local
POSTGRES_PASSWORD=${S_PGPW}
DATABASE_URL=${S_DBURL}
MEILI_MASTER_KEY=${S_MEILI}
AUTH_SECRET=${S_AUTH}
WORKFLOW_SECRET_KEY=${S_WORKFLOW}
SESSION_SIGNING_SECRET=${S_SESSION}
SMTP_SECRET_KEY=${S_SMTP}
AI_SECRET_KEY=${S_AI}
DIRECTORY_SECRET_KEY=${S_DIR}
LAZYIT_SITE_ADDRESS=localhost
LAZYIT_HTTP_PORT=8080
LAZYIT_HTTPS_PORT=8443
WEB_ORIGIN=https://localhost:8443
EOF

# Reconfigure non-interactively (--yes → local mode) with the test seams. This rewrites $ENVF.
LAZYIT_ENV_FILE="$ENVF" LAZYIT_SKIP_DOCKER=1 LAZYIT_SKIP_BRINGUP=1 \
  sh infra/start.sh --reconfigure --yes >/dev/null 2>&1 \
  || { echo "FAIL: start.sh --reconfigure exited non-zero"; exit 1; }

# The rendered file must still carry EACH secret, byte-identical.
fail=0
assert_kv() { # KEY EXPECTED
  _got=$(grep -E "^$1=" "$ENVF" | head -n1 | cut -d= -f2- || true)
  if [ "$_got" != "$2" ]; then
    echo "FAIL: $1 was not preserved (expected '$2', got '${_got:-<missing>}')"
    fail=1
  fi
}
assert_kv POSTGRES_PASSWORD      "$S_PGPW"
assert_kv DATABASE_URL           "$S_DBURL"
assert_kv MEILI_MASTER_KEY       "$S_MEILI"
assert_kv AUTH_SECRET            "$S_AUTH"
assert_kv WORKFLOW_SECRET_KEY    "$S_WORKFLOW"
assert_kv SESSION_SIGNING_SECRET "$S_SESSION"
assert_kv SMTP_SECRET_KEY        "$S_SMTP"
assert_kv AI_SECRET_KEY          "$S_AI"
assert_kv DIRECTORY_SECRET_KEY   "$S_DIR"
assert_kv AUTH_MODE              "local"

# ---------------------------------------------------------------------------
# Scenario 2 — a .env.prod written BEFORE SMTP_SECRET_KEY was generated (issue #1269). The key is absent,
# so nothing can be encrypted under it yet: reconfigure must MINT a valid 64-hex key (so the operator's
# first authenticated SMTP password save no longer 409s) while still preserving every other secret.
# ---------------------------------------------------------------------------
ENVF2="$WORK/.env.prod.legacy"
cat >"$ENVF2" <<EOF
AUTH_MODE=local
POSTGRES_PASSWORD=${S_PGPW}
DATABASE_URL=${S_DBURL}
MEILI_MASTER_KEY=${S_MEILI}
AUTH_SECRET=${S_AUTH}
WORKFLOW_SECRET_KEY=${S_WORKFLOW}
SESSION_SIGNING_SECRET=${S_SESSION}
LAZYIT_SITE_ADDRESS=localhost
LAZYIT_HTTP_PORT=8080
LAZYIT_HTTPS_PORT=8443
WEB_ORIGIN=https://localhost:8443
EOF

LAZYIT_ENV_FILE="$ENVF2" LAZYIT_SKIP_DOCKER=1 LAZYIT_SKIP_BRINGUP=1 \
  sh infra/start.sh --reconfigure --yes >/dev/null 2>&1 \
  || { echo "FAIL: start.sh --reconfigure (legacy file) exited non-zero"; exit 1; }

_minted=$(grep -E '^SMTP_SECRET_KEY=' "$ENVF2" | head -n1 | cut -d= -f2- || true)
case "$_minted" in
  [0-9a-f]*) [ "${#_minted}" -eq 64 ] || { echo "FAIL: minted SMTP_SECRET_KEY is ${#_minted} chars, not 64"; fail=1; } ;;
  *) echo "FAIL: no SMTP_SECRET_KEY was added to a legacy .env.prod (got '${_minted:-<missing>}')"; fail=1 ;;
esac
# AI_SECRET_KEY (ADR-0097) is absent from the same legacy file, so it is minted the same way.
_minted_ai=$(grep -E '^AI_SECRET_KEY=' "$ENVF2" | head -n1 | cut -d= -f2- || true)
case "$_minted_ai" in
  [0-9a-f]*) [ "${#_minted_ai}" -eq 64 ] || { echo "FAIL: minted AI_SECRET_KEY is ${#_minted_ai} chars, not 64"; fail=1; } ;;
  *) echo "FAIL: no AI_SECRET_KEY was added to a legacy .env.prod (got '${_minted_ai:-<missing>}')"; fail=1 ;;
esac
[ "$_minted_ai" != "$_minted" ] || { echo "FAIL: AI_SECRET_KEY reuses SMTP_SECRET_KEY's value"; fail=1; }
# DIRECTORY_SECRET_KEY (ADR-0091, issue #1271) is absent too, so it is minted the same way, on its own axis.
_minted_dir=$(grep -E '^DIRECTORY_SECRET_KEY=' "$ENVF2" | head -n1 | cut -d= -f2- || true)
case "$_minted_dir" in
  [0-9a-f]*) [ "${#_minted_dir}" -eq 64 ] || { echo "FAIL: minted DIRECTORY_SECRET_KEY is ${#_minted_dir} chars, not 64"; fail=1; } ;;
  *) echo "FAIL: no DIRECTORY_SECRET_KEY was added to a legacy .env.prod (got '${_minted_dir:-<missing>}')"; fail=1 ;;
esac
[ "$_minted_dir" != "$_minted" ] && [ "$_minted_dir" != "$_minted_ai" ] \
  || { echo "FAIL: DIRECTORY_SECRET_KEY reuses another at-rest key's value"; fail=1; }
# The other secrets must survive the same render untouched.
_w2=$(grep -E '^WORKFLOW_SECRET_KEY=' "$ENVF2" | head -n1 | cut -d= -f2- || true)
[ "$_w2" = "$S_WORKFLOW" ] || { echo "FAIL: WORKFLOW_SECRET_KEY changed while adding SMTP_SECRET_KEY"; fail=1; }


# ---------------------------------------------------------------------------
# Scenario 3 — a FRESH guided install (issue #1322). AI_SECRET_KEY is optional and must never become an
# active key in the example (infra/update.sh would stop every existing instance), yet a fresh render must
# still write it ACTIVE (64 hex), exactly once, distinct from the other keys, and leave
# AI_WORKER_CONCURRENCY at its default (not active).
# ---------------------------------------------------------------------------
ENVF3="$WORK/.env.prod.fresh"
LAZYIT_ENV_FILE="$ENVF3" LAZYIT_SKIP_DOCKER=1 LAZYIT_SKIP_BRINGUP=1 \
  sh infra/start.sh --yes >"$WORK/fresh.log" 2>&1 \
  || { echo "FAIL: start.sh --yes (fresh render) exited non-zero"; exit 1; }
_fresh_ai=$(grep -E '^AI_SECRET_KEY=' "$ENVF3" | head -n1 | cut -d= -f2- || true)
case "$_fresh_ai" in
  [0-9a-f]*) [ "${#_fresh_ai}" -eq 64 ] || { echo "FAIL: fresh AI_SECRET_KEY is ${#_fresh_ai} chars, not 64"; fail=1; } ;;
  *) echo "FAIL: a fresh render has no active AI_SECRET_KEY (got '${_fresh_ai:-<missing>}')"; fail=1 ;;
esac
[ "$(grep -cE '^AI_SECRET_KEY=' "$ENVF3")" -eq 1 ] || { echo "FAIL: a fresh render has more than one AI_SECRET_KEY line"; fail=1; }
for _k in SMTP_SECRET_KEY WORKFLOW_SECRET_KEY SESSION_SIGNING_SECRET; do
  [ "$(grep -E "^$_k=" "$ENVF3" | head -n1 | cut -d= -f2-)" != "$_fresh_ai" ] \
    || { echo "FAIL: AI_SECRET_KEY reuses $_k's value"; fail=1; }
done
if grep -qE '^AI_WORKER_CONCURRENCY=' "$ENVF3"; then echo "FAIL: AI_WORKER_CONCURRENCY must stay at its default (commented)"; fail=1; fi
if grep -qE '^(AI_SECRET_KEY|AI_WORKER_CONCURRENCY)=' infra/env/.env.prod.example; then
  echo "FAIL: .env.prod.example carries an ACTIVE AI key — infra/update.sh would stop every existing instance"; fail=1
fi
# DIRECTORY_SECRET_KEY (ADR-0091, issue #1271) — the same contract as AI_SECRET_KEY: a fresh guided install
# writes it ACTIVE (64 hex), exactly once, on its own axis, never printed; the example keeps it commented.
_fresh_dir=$(grep -E '^DIRECTORY_SECRET_KEY=' "$ENVF3" | head -n1 | cut -d= -f2- || true)
case "$_fresh_dir" in
  [0-9a-f]*) [ "${#_fresh_dir}" -eq 64 ] || { echo "FAIL: fresh DIRECTORY_SECRET_KEY is ${#_fresh_dir} chars, not 64"; fail=1; } ;;
  *) echo "FAIL: a fresh render has no active DIRECTORY_SECRET_KEY (got '${_fresh_dir:-<missing>}')"; fail=1 ;;
esac
[ "$(grep -cE '^DIRECTORY_SECRET_KEY=' "$ENVF3")" -eq 1 ] || { echo "FAIL: a fresh render has more than one DIRECTORY_SECRET_KEY line"; fail=1; }
for _k in SMTP_SECRET_KEY AI_SECRET_KEY WORKFLOW_SECRET_KEY SESSION_SIGNING_SECRET; do
  [ "$(grep -E "^$_k=" "$ENVF3" | head -n1 | cut -d= -f2-)" != "$_fresh_dir" ] \
    || { echo "FAIL: DIRECTORY_SECRET_KEY reuses $_k's value"; fail=1; }
done
if [ -n "$_fresh_dir" ] && grep -qF "$_fresh_dir" "$WORK/fresh.log"; then
  echo "FAIL: the generated DIRECTORY_SECRET_KEY value was printed by start.sh"; fail=1
fi
if grep -qE '^DIRECTORY_SECRET_KEY=' infra/env/.env.prod.example; then
  echo "FAIL: .env.prod.example carries an ACTIVE DIRECTORY_SECRET_KEY — infra/update.sh would stop every existing instance"; fail=1
fi
grep -qE '^#[[:space:]]*DIRECTORY_SECRET_KEY=' infra/env/.env.prod.example \
  || { echo "FAIL: .env.prod.example has no commented DIRECTORY_SECRET_KEY placeholder (the render loop and the #1459 append both key off it)"; fail=1; }

[ "$fail" -eq 0 ] || { echo "reconfigure-preserves-secrets: FAILED"; exit 1; }
echo "reconfigure-preserves-secrets: OK — all secrets preserved across --reconfigure (SMTP_SECRET_KEY, AI_SECRET_KEY and DIRECTORY_SECRET_KEY added when absent; AI_SECRET_KEY and DIRECTORY_SECRET_KEY written on a fresh render)"
