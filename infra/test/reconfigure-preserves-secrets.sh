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
# The other secrets must survive the same render untouched.
_w2=$(grep -E '^WORKFLOW_SECRET_KEY=' "$ENVF2" | head -n1 | cut -d= -f2- || true)
[ "$_w2" = "$S_WORKFLOW" ] || { echo "FAIL: WORKFLOW_SECRET_KEY changed while adding SMTP_SECRET_KEY"; fail=1; }

[ "$fail" -eq 0 ] || { echo "reconfigure-preserves-secrets: FAILED"; exit 1; }
echo "reconfigure-preserves-secrets: OK — all secrets preserved across --reconfigure (and SMTP_SECRET_KEY added when absent)"
