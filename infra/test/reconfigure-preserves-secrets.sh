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

# A pre-existing local-auth install pinned to localhost (the "before").
cat >"$ENVF" <<EOF
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
assert_kv AUTH_MODE              "local"

[ "$fail" -eq 0 ] || { echo "reconfigure-preserves-secrets: FAILED"; exit 1; }
echo "reconfigure-preserves-secrets: OK — all secrets preserved across --reconfigure"
