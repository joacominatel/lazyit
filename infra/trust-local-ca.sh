#!/bin/sh
# =============================================================================
# lazyit — trust-local-ca.sh · trust (or untrust) Caddy's LOCAL internal-CA root.
#
# WHY THIS EXISTS
#   In a LOCAL prod-like deploy (./infra/start.sh with DEPLOY_MODE=local), Caddy serves HTTPS from
#   its OWN internal CA — not Let's Encrypt. Browsers don't trust that CA, so https://localhost:<port>
#   throws a certificate warning. This script extracts Caddy's CURRENT root CA from the running
#   container and installs it into your OS trust store so Chrome/Safari (and Firefox, via one toggle)
#   stop warning.
#
#   It is idempotent and — critically — removes any STALE "Caddy Local Authority" root FIRST. After a
#   prod volume reset, Caddy mints a NEW root with the SAME name but a new key; the leftover old root
#   collides by name and Firefox reports SEC_ERROR_BAD_SIGNATURE with NO "accept the risk" bypass.
#   Re-run this after any `down -v` / volume reset and the warning clears.
#
# NOT a start.sh step BY DESIGN
#   Installing a root into the OS trust store is a PRIVILEGED host mutation (sudo). start.sh is
#   deliberately non-privileged and never touches the host (ADR-0047 — it prints, you run). This is
#   also LOCAL-ONLY: a real domain uses Let's Encrypt (publicly trusted), so there is nothing to
#   trust. Hence a separate, re-runnable helper.
#
# Usage:
#   ./infra/trust-local-ca.sh            # extract Caddy's current local root + trust it
#   ./infra/trust-local-ca.sh --untrust  # remove the lazyit local root from the trust store
#   ./infra/trust-local-ca.sh --help
#
# Docs: docs/05-runbooks/docker-prod-like-first-boot.md · ADR-0047 (start.sh) · ADR-0026 (Caddy).
# =============================================================================
set -eu

# ---------- constants --------------------------------------------------------
COMPOSE_BASE="compose.yaml"
COMPOSE_PROD="infra/docker-compose.prod.yaml"
ENV_FILE="infra/env/.env.prod"
CA_NAME="Caddy Local Authority"                       # the Subject CN Caddy uses for its local root
CADDY_ROOT_IN_CONTAINER="/data/caddy/pki/authorities/local/root.crt"
OUT_DIR="infra/.local-ca"                             # where we drop the extracted cert (gitignored)
OUT_CERT="$OUT_DIR/lazyit-local-ca.crt"
LINUX_CA_PATH="/usr/local/share/ca-certificates/lazyit-local-ca.crt"

UNTRUST=0

# ---------- output helpers (stderr; stdout stays clean) ----------------------
info()  { printf '  %s\n'        "$*" >&2; }
step()  { printf '\n==> %s\n'    "$*" >&2; }
ok()    { printf '  [ ok ] %s\n' "$*" >&2; }
warn()  { printf '  [warn] %s\n' "$*" >&2; }
die()   { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
lazyit — trust-local-ca.sh · trust Caddy's local internal-CA root (local prod-like only)

USAGE
  ./infra/trust-local-ca.sh [--untrust] [--help]

WHAT IT DOES
  Extracts the CURRENT Caddy local root CA from the running prod stack and installs it into your OS
  trust store, after removing any stale "Caddy Local Authority" root (the cause of Firefox's
  SEC_ERROR_BAD_SIGNATURE after a volume reset). Re-run it any time the cert warning comes back.

OPTIONS
  --untrust   Remove the lazyit local root from the OS trust store (revert this script).
  --help,-h   Show this help.

NOTE
  Local prod-like only — a real domain uses Let's Encrypt and needs no trust step. Firefox keeps its
  own store: after trusting, set security.enterprise_roots.enabled = true in about:config (this
  script prints the reminder).
EOF
}

# ---------- docker compose wrapper (resolves the lazyit-prod project) ---------
dc() {
  docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_PROD" --profile prod --env-file "$ENV_FILE" "$@"
}

# =============================================================================
# extract_caddy_root — copy Caddy's current local root CA out of the running container.
# =============================================================================
extract_caddy_root() {
  step "Extracting Caddy's local root CA"
  command -v docker >/dev/null 2>&1 || die "docker not found."
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing — bring prod up first: ./infra/start.sh"

  _cid=$(dc ps -q caddy 2>/dev/null || true)
  [ -n "$_cid" ] || die "the caddy container isn't running. Bring prod up first: ./infra/start.sh"

  mkdir -p "$OUT_DIR"
  docker cp "$_cid:$CADDY_ROOT_IN_CONTAINER" "$OUT_CERT" >/dev/null 2>&1 \
    || die "couldn't read Caddy's root CA from the container ($CADDY_ROOT_IN_CONTAINER). Is Caddy fully up?"
  [ -s "$OUT_CERT" ] || die "extracted an empty cert — aborting."
  ok "current root CA saved to $OUT_CERT"
}

# =============================================================================
# macOS trust store (System keychain) — used by Chrome + Safari directly.
# =============================================================================
macos_remove_stale() {
  # Delete EVERY cert named "$CA_NAME" from the System keychain (idempotent no-op if none). This is
  # what clears the name-collision that produces SEC_ERROR_BAD_SIGNATURE after a volume reset.
  _removed=0
  while :; do
    _h=$(security find-certificate -a -c "$CA_NAME" -Z /Library/Keychains/System.keychain 2>/dev/null \
          | awk '/SHA-1 hash:/{print $NF; exit}')
    [ -n "$_h" ] || break
    sudo security delete-certificate -Z "$_h" /Library/Keychains/System.keychain >/dev/null 2>&1 || break
    _removed=$((_removed + 1))
  done
  [ "$_removed" -gt 0 ] && ok "removed $_removed stale '$CA_NAME' root(s) from the System keychain" || true
}

macos_trust() {
  step "Trusting the root in the macOS System keychain (sudo)"
  macos_remove_stale
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$OUT_CERT" \
    || die "failed to add the trusted cert (needs an admin password)."
  ok "trusted. Chrome and Safari will accept https://localhost now."
}

macos_untrust() {
  step "Removing the lazyit local root from the macOS System keychain (sudo)"
  macos_remove_stale
  ok "removed (if it was present)."
}

# =============================================================================
# Linux trust store (update-ca-certificates) — Debian/Ubuntu family.
# =============================================================================
linux_trust() {
  step "Trusting the root via update-ca-certificates (sudo)"
  command -v update-ca-certificates >/dev/null 2>&1 \
    || die "update-ca-certificates not found. On non-Debian distros, add $OUT_CERT to your trust store manually."
  sudo cp "$OUT_CERT" "$LINUX_CA_PATH"
  sudo update-ca-certificates >/dev/null || die "update-ca-certificates failed."
  ok "trusted. Chromium/Chrome will accept https://localhost now."
}

linux_untrust() {
  step "Removing the lazyit local root (sudo)"
  if [ -f "$LINUX_CA_PATH" ]; then
    sudo rm -f "$LINUX_CA_PATH"
    sudo update-ca-certificates --fresh >/dev/null 2>&1 || sudo update-ca-certificates >/dev/null 2>&1 || true
    ok "removed."
  else
    ok "nothing to remove ($LINUX_CA_PATH not present)."
  fi
}

# =============================================================================
# firefox_note — Firefox keeps its OWN NSS store; the OS trust store isn't enough.
# =============================================================================
firefox_note() {
  cat >&2 <<'EOF'

  FIREFOX (keeps its own trust store, separate from the OS):
    1. Open about:config
    2. Set  security.enterprise_roots.enabled = true   (Firefox then reads the OS trust store)
    3. Fully restart Firefox.
    If a stale error sticks: Settings -> Privacy & Security -> Certificates -> View Certificates
    -> Servers -> delete the localhost entry, then reload.
EOF
}

# =============================================================================
# MAIN
# =============================================================================
main() {
  for arg in "$@"; do
    case "$arg" in
      --untrust)  UNTRUST=1 ;;
      -h|--help)  usage; exit 0 ;;
      *) usage; die "unknown option: $arg" ;;
    esac
  done

  # Run from the repo root (resolve from this script's own location: infra/ -> repo root is ../).
  SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
  cd "$REPO_ROOT" || die "cannot cd to the repo root ($REPO_ROOT)"
  [ -f "$COMPOSE_BASE" ] || die "not at the repo root: $COMPOSE_BASE not found."

  _os=$(uname -s 2>/dev/null || echo unknown)

  if [ "$UNTRUST" -eq 1 ]; then
    case "$_os" in
      Darwin) macos_untrust ;;
      Linux)  linux_untrust ;;
      *) die "unsupported OS '$_os' for automatic untrust." ;;
    esac
    info "Done. Re-run without --untrust to trust again."
    exit 0
  fi

  extract_caddy_root
  case "$_os" in
    Darwin) macos_trust ;;
    Linux)  linux_trust ;;
    *) die "unsupported OS '$_os'. The extracted cert is at $OUT_CERT — add it to your trust store manually." ;;
  esac
  firefox_note

  cat >&2 <<EOF

  What this cert is: the root of Caddy's INTERNAL certificate authority, generated locally on this
  machine (in the caddy_data volume). It only signs certificates for your local prod-like deploy —
  it is NOT a public CA and means nothing to anyone else. Trusting it just tells THIS machine's
  browsers that your own local Caddy is legit. A real-domain deploy uses Let's Encrypt instead and
  needs none of this. Extracted copy kept at: $OUT_CERT

  Now open:  https://localhost:8443    (https, not http)
EOF
}

main "$@"
