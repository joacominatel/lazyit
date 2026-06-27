#!/bin/sh
# lazyit reporting agent installer (ADR-0074 §6).
#
# Served PUBLICLY from your own lazyit instance (same-origin, TLS-fronted). It carries NO secret:
# you pass the Service Account token (infra:report) yourself. It downloads the matching agent binary
# from your instance, installs it, writes /etc/lazyit-agent/config (chmod 600), and registers a
# systemd timer so the host keeps itself current in lazyit's PENDING tray.
#
#   curl -fsSL https://lazyit.example.com/install.sh | sh -s -- \
#     --url https://lazyit.example.com --token lzit_sa_xxx [--interval 15m]
#
# Re-running upgrades cleanly (idempotent). Requires root (systemd + /usr/local/bin + /etc).
set -eu

URL=""
TOKEN=""
INTERVAL="15m"

die() {
  echo "lazyit-agent install: $1" >&2
  exit 1
}

# --- args ------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --url=*) URL="${1#*=}"; shift ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: install.sh --url <url> --token <token> [--interval <dur>]"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$URL" ] || die "--url is required (your lazyit instance, e.g. https://lazyit.example.com)"
[ -n "$TOKEN" ] || die "--token is required (a Service Account token holding infra:report)"
URL="${URL%/}" # strip a trailing slash

[ "$(id -u)" = "0" ] || die "must run as root (installs to /usr/local/bin, /etc and systemd)"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

# --- arch ------------------------------------------------------------------
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "unsupported architecture: $MACHINE (only x86_64 and aarch64 are built)" ;;
esac

BIN_PATH="/usr/local/bin/lazyit-agent"
CONFIG_DIR="/etc/lazyit-agent"
CONFIG_FILE="$CONFIG_DIR/config"
SERVICE="/etc/systemd/system/lazyit-agent.service"
TIMER="/etc/systemd/system/lazyit-agent.timer"

# --- download the binary (token-gated) -------------------------------------
echo "lazyit-agent install: downloading agent ($ARCH) from $URL ..."
TMP_BIN="$(mktemp)"
trap 'rm -f "$TMP_BIN"' EXIT
if ! curl -fsSL -H "Authorization: Bearer $TOKEN" \
  "$URL/api/agent/download?arch=$ARCH" -o "$TMP_BIN"; then
  die "download failed — check the URL, the token (needs infra:report), and that the binary is bundled in this build"
fi
[ -s "$TMP_BIN" ] || die "downloaded an empty file — aborting"

install -m 755 "$TMP_BIN" "$BIN_PATH"

# --- config (chmod 600 — it holds the token) -------------------------------
mkdir -p "$CONFIG_DIR"
umask 077
cat > "$CONFIG_FILE" <<EOF
# lazyit reporting agent config (ADR-0074). Holds your instance URL + SA token. chmod 600.
LAZYIT_URL=$URL
LAZYIT_TOKEN=$TOKEN
LAZYIT_INTERVAL=$INTERVAL
EOF
chmod 600 "$CONFIG_FILE"

# --- systemd oneshot service + timer ---------------------------------------
cat > "$SERVICE" <<EOF
[Unit]
Description=lazyit reporting agent (one-shot inventory report)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN_PATH report --once
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=lazyit reporting agent timer (periodic inventory report)

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now lazyit-agent.timer >/dev/null 2>&1 || die "failed to enable the timer"

# --- one immediate report --------------------------------------------------
echo "lazyit-agent install: sending the first report ..."
if "$BIN_PATH" report --once; then
  echo
  echo "lazyit-agent install: done. The agent reports every $INTERVAL."
  echo "This host now appears in lazyit's infra topology PENDING tray — confirm it there to track it as an asset."
else
  die "the first report failed — check the URL/token; the timer is installed and will retry"
fi
