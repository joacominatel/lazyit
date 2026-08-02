#!/bin/sh
# lazyit reporting agent installer (ADR-0074 section 6).
#
# Served PUBLICLY from your own lazyit instance (same-origin, TLS-fronted). It carries NO secret:
# you pass the Service Account token (infra:report) yourself. It downloads the matching agent binary
# from your instance, installs it, writes /etc/lazyit-agent/config (chmod 600), and registers a
# systemd timer so the host keeps itself current in lazyit's PENDING tray.
#
#   curl -fsSL https://lazyit.example.com/install.sh | sh -s -- \
#     --url https://lazyit.example.com --token lzit_sa_xxx
#
# KEEPING THE TOKEN OUT OF `ps` AND SHELL HISTORY (#1137). `--token <value>` is visible in `ps` for
# every user on the box while the install runs, and it lands in root's history. Two safer forms:
#
#   LAZYIT_TOKEN=lzit_sa_xxx sh install.sh --url https://lazyit.example.com
#   sh install.sh --url https://lazyit.example.com --token-file /root/agent.token
#
# `--token-file -` reads the token from STDIN - which means it cannot be combined with the
# `curl ... | sh` pipe, because the pipe already IS this script's stdin. Download the script first.
#
# REMOVING IT AGAIN: `sh install.sh --uninstall`. Add `--keep-config` to keep this host's own limits
# for a later re-install; the SA token is destroyed either way.
#
# THE TIMER TICKS EVERY 5 MINUTES AND THAT NEVER CHANGES (ADR-0074 section 7 amendment, #1140). It is not
# the reporting cadence: the agent checks whether it is due and exits immediately when it is not.
# CADENCE is set centrally in lazyit (Settings -> Instance -> Reporting agents) and picked up on the next report, so
# changing it never rewrites a unit file, never needs `daemon-reload`, and never needs an SSH
# session. --interval is still accepted so existing automation does not break, but it is ignored.
#
# REQUIREMENTS. systemd, curl, and a glibc new enough for the binary this instance serves. Rather
# than hardcode a version that would go stale with every Bun bump, the installer RUNS the binary once
# before it writes a unit or arms a timer, and refuses with a clear message if the host cannot start
# it. The artifacts built from this repo today link no symbol newer than GLIBC_2.17.
#
# Re-running upgrades cleanly (idempotent). Requires root (systemd + /usr/local/bin + /etc).
set -eu

URL=""
TOKEN=""
TOKEN_FILE=""
# A PEM bundle to trust instead of trusting your internal CA system-wide (#1137). Used for THIS
# script's own downloads (curl --cacert) and written into the config so the agent uses it too.
CA_FILE=""
# The FIXED tick. Deliberately not configurable: the whole point of #1140 is that the schedule is one
# unchanging thing on every platform while the cadence is a server-side setting.
TICK="5min"
# Per-elapse de-phasing for the timer (#1137). See the [Timer] heredoc below for why it exists and
# what it costs.
JITTER="60s"
# Accepted and ignored (see the note above). Recorded in the config file only so an operator who set
# it can see what happened to it.
LEGACY_INTERVAL=""
UNINSTALL=0
KEEP_CONFIG=0
REQUIRE_CHECKSUM=0
FORCE_BASELINE=0

BIN_PATH="/usr/local/bin/lazyit-agent"
CONFIG_DIR="/etc/lazyit-agent"
CONFIG_FILE="$CONFIG_DIR/config"
STATE_DIR="/var/lib/lazyit-agent"
SERVICE="/etc/systemd/system/lazyit-agent.service"
TIMER="/etc/systemd/system/lazyit-agent.timer"

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
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --token-file=*) TOKEN_FILE="${1#*=}"; shift ;;
    --ca-file) CA_FILE="${2:-}"; shift 2 ;;
    --ca-file=*) CA_FILE="${1#*=}"; shift ;;
    --interval) LEGACY_INTERVAL="${2:-}"; shift 2 ;;
    --interval=*) LEGACY_INTERVAL="${1#*=}"; shift ;;
    --baseline) FORCE_BASELINE=1; shift ;;
    --require-checksum) REQUIRE_CHECKSUM=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --keep-config) KEEP_CONFIG=1; shift ;;
    -h|--help)
      echo "Usage: install.sh --url <base-url> (--token <token> | --token-file <path>)"
      echo "       install.sh --uninstall [--keep-config]"
      echo "  --url <base-url>     your lazyit instance, scheme + host + port and nothing else:"
      echo "                       e.g. https://lazyit.example.com  (NOT .../install.sh - this"
      echo "                       script appends /api/agent/download to whatever you pass)"
      echo "  --token-file <path>  read the token from a file ('-' = stdin; not usable with curl | sh)"
      echo "                       LAZYIT_TOKEN in the environment works too, and keeps it out of ps."
      echo "  --ca-file <path>     PEM bundle to trust, instead of trusting your CA system-wide;"
      echo "                       used for this download AND written into the agent's config"
      echo "  --baseline           force the pre-AVX2 x86-64 build (auto-detected otherwise)"
      echo "  --require-checksum   fail if this instance publishes no sha256 for the binary"
      echo "  --uninstall          stop and remove the agent, its units, its state and its token"
      echo "  --keep-config        with --uninstall: keep this host's own limits (never the token)"
      echo "  --interval <dur>     accepted for compatibility and IGNORED - the reporting cadence"
      echo "                       is set centrally in lazyit (Settings -> Instance -> Reporting agents)."
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# --- uninstall -------------------------------------------------------------
# "I will not deploy something I can't cleanly remove" is a reasonable position, and until #1137 the
# answer was four files and two units by hand. Everything below is idempotent and never fails on a
# partial install: a host that only got as far as the binary uninstalls just as cleanly as one that
# has been reporting for a year.
if [ "$UNINSTALL" = "1" ]; then
  [ "$(id -u)" = "0" ] || die "--uninstall must run as root (removes /usr/local/bin, /etc and systemd units)"

  # Disarm FIRST. Deleting the binary out from under an armed timer does not stop the timer; it just
  # turns every tick into a failed unit and a journal line, on a host somebody believes is clean.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now lazyit-agent.timer >/dev/null 2>&1 || true
    systemctl stop lazyit-agent.service >/dev/null 2>&1 || true
  fi
  rm -f "$SERVICE" "$TIMER"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    # Clears the 'not-found' unit entries the removal above leaves behind in systemd's state.
    systemctl reset-failed lazyit-agent.timer lazyit-agent.service >/dev/null 2>&1 || true
  fi
  rm -f "$BIN_PATH"
  # The policy + last-success cache (#1140). Local to the host and meaningless without the agent.
  rm -rf "$STATE_DIR"

  # THE TOKEN NEVER SURVIVES AN UNINSTALL. It is a working credential for your instance, and leaving
  # it on a host somebody just decommissioned - and will hand to someone else, or wipe six months
  # from now - is the one outcome this path must not have. Revoking the Service Account in lazyit is
  # still the complete answer; this is the half the operator can do from the host.
  #
  # `--keep-config` is for the operator re-imaging a host that will get the agent back: it keeps the
  # LOCAL VETO (`LAZYIT_COLLECT_*=false`, `LAZYIT_MIN_INTERVAL`, ...), which is the host owner's
  # setting and is genuinely painful to lose, while still stripping the token and the URL.
  if [ "$KEEP_CONFIG" = "1" ] && [ -f "$CONFIG_FILE" ]; then
    KEPT="$(grep -Ev '^[[:space:]]*LAZYIT_(TOKEN|URL)=' "$CONFIG_FILE" || true)"
    umask 077
    printf '%s\n' "$KEPT" > "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    echo "lazyit-agent install: kept $CONFIG_FILE without its token or URL (--keep-config)."
  else
    rm -f "$CONFIG_FILE"
    rmdir "$CONFIG_DIR" 2>/dev/null || true
  fi

  echo "lazyit-agent install: uninstalled - binary, both systemd units, $STATE_DIR and the token are gone."
  echo "This host stops reporting immediately. Its entry in lazyit is untouched: discard it there if you"
  echo "want it off the map, and revoke the Service Account token if no other host uses it."
  exit 0
fi

[ "$KEEP_CONFIG" = "0" ] || die "--keep-config only means something with --uninstall"

# --- token -----------------------------------------------------------------
if [ -n "$TOKEN_FILE" ]; then
  [ -z "$TOKEN" ] || die "--token and --token-file are mutually exclusive - pass one"
  if [ "$TOKEN_FILE" = "-" ]; then
    # Reading stdin only works when the script is a FILE. Under `curl ... | sh` the pipe already is
    # stdin, so there is nothing here but the rest of this script.
    if [ -t 0 ]; then
      die "--token-file - reads stdin, but stdin is a terminal - pipe the token in, or pass a path"
    fi
    TOKEN="$(cat)"
  else
    [ -r "$TOKEN_FILE" ] || die "cannot read the token file: $TOKEN_FILE"
    TOKEN="$(cat "$TOKEN_FILE")"
  fi
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n')"
  [ -n "$TOKEN" ] || die "the token file is empty - nothing to authenticate with"
  # A Service Account token is one opaque word. Anything with whitespace in it is not one - and the
  # specific way to get here is `curl ... | sh -s -- --token-file -`, where stdin is the REST OF THIS
  # SCRIPT: `cat` happily reads it, the newlines are stripped above, and the installer would go on to
  # send a few kilobytes of shell as a bearer token and report a 401 the operator cannot explain.
  # Saying which mistake it is costs one test.
  case "$TOKEN" in
    *[[:space:]]*)
      die "what was read from ${TOKEN_FILE:-stdin} is not a token (it contains whitespace). If you ran this through 'curl ... | sh', stdin is this script itself - download the script and run it as a file, or use --token / LAZYIT_TOKEN." ;;
  esac
fi
# The environment is the third safe form: not in `ps`, not in history.
TOKEN="${TOKEN:-${LAZYIT_TOKEN:-}}"
URL="${URL:-${LAZYIT_URL:-}}"

[ -n "$URL" ] || die "--url is required (your lazyit instance, e.g. https://lazyit.example.com)"
[ -n "$TOKEN" ] || die "a token is required - pass --token, --token-file, or set LAZYIT_TOKEN (needs infra:report)"
URL="${URL%/}" # strip a trailing slash

# --- --url IS THE INSTANCE BASE URL, NOT THE ADDRESS OF THIS SCRIPT (#1166) ---
# Every request below is built as "$URL/api/...", so `--url https://host/install.sh` asks the server
# for https://host/install.sh/api/agent/download?arch=... . What reaches the operator is the download
# failure further down, which names the token as a likely cause - so they go and rotate a Service
# Account credential that was never wrong. It was a Windows operator who hit this first, on the
# identical shape in install.ps1; nothing about the mistake is Windows-specific. Checked HERE, before
# anything is downloaded, so the message names the real mistake and suggests the URL they meant.
case "$URL" in
  http://*|https://*) ;;
  *) die "--url must be your lazyit instance base URL, starting with http:// or https:// (e.g. https://lazyit.example.com). Got: $URL" ;;
esac
# Whatever follows scheme://host[:port]. `${URL#*://}` drops the scheme; a host with no path has no
# slash left in it, which is the ordinary case and yields an empty URL_PATH.
URL_HOSTPATH="${URL#*://}"
case "$URL_HOSTPATH" in
  */*) URL_PATH="/${URL_HOSTPATH#*/}" ;;
  *)   URL_PATH="" ;;
esac
case "$URL_PATH" in
  /install.sh*|/install.ps1*)
    die "--url is your lazyit instance base URL, not the address of this script. You passed $URL; pass --url ${URL%%/install.*} instead. The installer appends /api/agent/download to it itself." ;;
  /api|/api/*)
    die "--url is your lazyit instance base URL, not an API endpoint. You passed $URL, and the installer would then ask for $URL/api/agent/download. Pass --url ${URL%%/api*}." ;;
  # ANY OTHER PATH IS A WARNING, NOT A REFUSAL, and that asymmetry is deliberate. lazyit sets no
  # Next.js basePath, so a path here is almost always the same mistake in a different shape - but a
  # reverse proxy that strips a prefix really can mount an instance under one, and re-running this
  # script is the documented UPGRADE path. Refusing outright would break a deployment that works
  # today; the two branches above are the only two shapes that can never be a valid base URL.
  ?*)
    echo "lazyit-agent install: --url carries a path ($URL_PATH) and lazyit is served from the root of its origin, so this is usually a mistake - pass just the scheme, host and port. Continuing, in case your reverse proxy really does mount lazyit under that path." >&2 ;;
esac

[ "$(id -u)" = "0" ] || die "must run as root (installs to /usr/local/bin, /etc and systemd)"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

# The private CA, if there is one. Unquoted below on purpose - this is how POSIX sh passes two
# arguments from one variable - so the path must not contain spaces.
CURL_CA=""
if [ -n "$CA_FILE" ]; then
  [ -r "$CA_FILE" ] || die "cannot read --ca-file: $CA_FILE"
  case "$CA_FILE" in
    *" "*) die "--ca-file must not contain spaces: $CA_FILE" ;;
  esac
  CURL_CA="--cacert $CA_FILE"
fi

# --- arch ------------------------------------------------------------------
MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64)
    ARCH="x64"
    # THE DEFAULT x86-64 BUILD ASSUMES AVX2 (Haswell, 2013). A pre-Haswell host - or a vSphere
    # cluster whose EVC baseline masks the flag - dies with SIGILL, and the vMotion shape of this is
    # nasty: the agent runs happily for months, the VM moves onto older silicon, and it starts
    # crashing with no change on the host to explain it. So pick the baseline artifact whenever the
    # flag is not there, and let --baseline force it for a cluster that may migrate later.
    if [ "$FORCE_BASELINE" = "1" ]; then
      ARCH="x64-baseline"
    elif [ -r /proc/cpuinfo ] && ! grep -q '^flags.*[[:space:]]avx2\([[:space:]]\|$\)' /proc/cpuinfo; then
      ARCH="x64-baseline"
      echo "lazyit-agent install: this CPU reports no AVX2 - installing the baseline x86-64 build."
    fi
    ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "unsupported architecture: $MACHINE (only x86_64 and aarch64 are built)" ;;
esac

# --- download the binary (token-gated) -------------------------------------
echo "lazyit-agent install: downloading agent ($ARCH) from $URL ..."
TMP_BIN="$(mktemp)"
trap 'rm -f "$TMP_BIN"' EXIT
# --max-redirs 0 makes a 3xx a hard curl failure instead of a followed redirect (issue #980): if
# --url points at an origin with no /api routing (e.g. the raw web port :3000, no Caddy in front),
# the unauthenticated request 302s to /login - curl must not silently download that HTML.
if ! curl -fsSL --max-redirs 0 $CURL_CA -H "Authorization: Bearer $TOKEN" \
  "$URL/api/agent/download?arch=$ARCH" -o "$TMP_BIN"; then
  if [ "$ARCH" = "x64-baseline" ]; then
    # Deliberately NOT falling back to the ordinary x64 build. The baseline build was chosen because
    # this CPU reports no AVX2 (or because --baseline said so), and the x64 build would take SIGILL
    # on such a host - trading a clear install error now for a crash later is a bad trade.
    die "download failed for the baseline x86-64 build, and this installer will not substitute the ordinary x64 build (it needs AVX2 and would crash on a host that asked for baseline). An instance that predates the baseline artifact does not carry it: upgrade lazyit, then re-run."
  fi
  die "download failed - check the URL, the token (needs infra:report), and that the binary is bundled in this build"
fi
[ -s "$TMP_BIN" ] || die "downloaded an empty file - aborting"

# Belt-and-braces: require the download to actually be a Linux ELF binary (magic 7f 45 4c 46)
# before installing + arming the timer. Catches anything that slipped through as a 200 (HTML/JSON
# error page, a misrouted proxy response, ...) that --max-redirs above wouldn't catch.
MAGIC="$(od -An -tx1 -N4 "$TMP_BIN" | tr -d ' \n')"
[ "$MAGIC" = "7f454c46" ] || die "downloaded file is not a Linux executable - is --url your lazyit HTTPS origin (the Caddy front), not the raw web port :3000?"

# --- integrity: the digest the instance published --------------------------
# TLS plus four bytes of ELF magic answers "did the bytes arrive intact from the origin I dialled".
# It does not answer "are these the bytes the build produced" - and this file becomes root on every
# host in the estate. Comparing against a digest generated at BUILD time and shipped beside the
# binary raises the bar: swapping the binary in the API container now also requires swapping the
# digest, so the mismatch is visible here instead of nowhere.
#
# STATED HONESTLY: this is a checksum, not a signature. Anyone who can write both files defeats it,
# and it is not meant to survive that. ADR-0074 defers cosign as an enterprise ask; this is the part
# that costs nothing and catches the ordinary cases - a corrupted layer, a half-written volume, a
# caching proxy serving a stale artifact, and a tamper that missed one of the two files.
EXPECTED=""
if EXPECTED="$(curl -fsSL --max-redirs 0 $CURL_CA -H "Authorization: Bearer $TOKEN" \
  "$URL/api/agent/checksum?arch=$ARCH" 2>/dev/null)"; then
  EXPECTED="$(printf '%s' "$EXPECTED" | tr -d '[:space:]')"
else
  EXPECTED=""
fi
# Anything that is not exactly 64 lowercase hex characters is not a digest - an error page that
# arrived as a 200 must read as "no digest published", never as an expectation to compare against.
case "$EXPECTED" in
  *[!0-9a-f]*) EXPECTED="" ;;
esac
[ "${#EXPECTED}" = "64" ] || EXPECTED=""

SUM_TOOL=""
if command -v sha256sum >/dev/null 2>&1; then
  SUM_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SUM_TOOL="shasum -a 256"
fi

if [ -n "$EXPECTED" ] && [ -n "$SUM_TOOL" ]; then
  ACTUAL="$($SUM_TOOL "$TMP_BIN" | cut -d' ' -f1)"
  [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch - the binary this instance served is not the one it published a digest for (expected $EXPECTED, got $ACTUAL). Nothing installed. Re-run; if it persists, treat the instance as suspect."
  echo "lazyit-agent install: sha256 verified."
elif [ "$REQUIRE_CHECKSUM" = "1" ]; then
  if [ -z "$SUM_TOOL" ]; then
    die "--require-checksum was passed but this host has neither sha256sum nor shasum"
  fi
  die "--require-checksum was passed but this instance published no sha256 for $ARCH (an instance older than this installer does not)"
else
  if [ -z "$EXPECTED" ]; then
    echo "lazyit-agent install: note - this instance published no sha256 for the binary, so TLS and the ELF check are the only integrity check. Pass --require-checksum to make this fatal." >&2
  else
    echo "lazyit-agent install: note - no sha256sum/shasum on this host, so the published digest could not be checked." >&2
  fi
fi

install -m 755 "$TMP_BIN" "$BIN_PATH"

# --- can this host actually RUN it? ----------------------------------------
# The agent embeds the Bun runtime, so it has a floor on the host's glibc and kernel. Rather than
# hardcode a version - which would be wrong the moment Bun moves, in whichever direction - ask the
# binary. `--help` prints and exits: no network, no /etc, no state, and it fails exactly when the
# dynamic loader or the kernel cannot start the executable.
#
# This runs BEFORE any unit is written, because the alternative is the failure mode this replaces: a
# host that looks installed, has a timer armed, and silently never reports, with the only clue a
# "GLIBC_x.y not found" buried in a journal nobody is reading. The binary is removed again so the
# host is left exactly as it was found.
if ! "$BIN_PATH" --help >/dev/null 2>&1; then
  rm -f "$BIN_PATH"
  die "the agent binary will not start on this host. That is almost always glibc or the kernel being too old for the embedded Bun runtime (run '$BIN_PATH --help' by hand to see the loader's message). Nothing has been installed and no timer was armed."
fi

# --- config (chmod 600 - it holds the token) -------------------------------
mkdir -p "$CONFIG_DIR"
umask 077
# Built before the heredoc rather than inside it: a command substitution that legitimately produces
# nothing must not look like a failure to `set -e`.
LEGACY_NOTE=""
if [ -n "$LEGACY_INTERVAL" ]; then
  LEGACY_NOTE="# --interval $LEGACY_INTERVAL was passed and IGNORED: reporting cadence is set in lazyit
# (Settings -> Instance -> Reporting agents), not here. To make THIS host report LESS often than lazyit asks,
# uncomment the LAZYIT_MIN_INTERVAL line below - a floor, never a shorter interval."
fi

# CARRY THIS HOST'S OWN SETTINGS ACROSS A RE-INSTALL (#1140). Re-running the installer is the
# documented upgrade path and it rewrites this file - but since #1140 the file is also the ONLY place
# the host's local VETO lives (`LAZYIT_COLLECT_*=false`, `LAZYIT_MIN_INTERVAL`, `LAZYIT_SOFTWARE_MAX`,
# `LAZYIT_EXCLUDE_*`), and since #1137 the only place its proxy and CA live too. Truncating it would
# silently re-enable collection the host's owner turned off - or cut a proxied host off the network -
# on the upgrade path, with nothing on screen to say so, and on a self-hosted product that owner is
# frequently not the person running the upgrade. So: everything is carried over EXCEPT the three keys
# the installer owns (URL, TOKEN, and the ignored legacy INTERVAL), which the flags supply fresh.
#
# Merging rather than moving the veto to a file the installer never touches, because this file is
# where every existing host already keeps it - the template below has invited exactly that since
# #1140 - and a second file would orphan those settings on the very upgrade this is protecting.
#
# The pattern is deliberately wider than `LAZYIT_*`: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` live
# here too since #1137, under the names every other tool on the host already uses.
#
# BOTH CASES, because the agent reads both. `networkFrom` honours `https_proxy` exactly as it honours
# `HTTPS_PROXY` - the lowercase spelling is the one curl and Bun prefer, so it is the one an operator
# is most likely to have copied off a working host - and a pattern that matched only the UPPERCASE
# half would silently DELETE a working proxy on the upgrade path. Same erasure as the local veto in
# #1160, one key over.
#
# `LAZYIT_CA_FILE` joins the owned set ONLY when --ca-file was passed. Passing it means "this is the
# CA now", so keeping the old line as well would write the key twice and leave which one wins to the
# parser; not passing it leaves whatever the host already had, like every other kept setting. The
# lowercase spelling is owned alongside it for the same reason it is kept alongside it: the agent
# reads it, so leaving it behind would make an unrelated file the winner.
OWNED='LAZYIT_(URL|TOKEN|INTERVAL)='
CA_NOTE=""
if [ -n "$CA_FILE" ]; then
  OWNED='(LAZYIT_(URL|TOKEN|INTERVAL|CA_FILE)|lazyit_ca_file)='
  CA_NOTE="LAZYIT_CA_FILE=$CA_FILE"
fi

PRESERVED=""
if [ -f "$CONFIG_FILE" ]; then
  KEPT="$(grep -E '^[[:space:]]*(LAZYIT_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|lazyit_ca_file)=' "$CONFIG_FILE" 2>/dev/null \
    | grep -Ev "^[[:space:]]*$OWNED" || true)"
  if [ -n "$KEPT" ]; then
    PRESERVED="# --- kept from this host's previous config (its own limits - the installer does not own these) ---
$KEPT
# --- end kept ---"
  fi
fi

cat > "$CONFIG_FILE" <<EOF
# lazyit reporting agent config (ADR-0074). Holds your instance URL + SA token. chmod 600.
LAZYIT_URL=$URL
LAZYIT_TOKEN=$TOKEN
$CA_NOTE
$LEGACY_NOTE
$PRESERVED
#
# What this HOST refuses to do, whatever lazyit's policy says (#1140). These VETO the server's
# policy and can never widen it: a collector switched off here cannot be switched back on remotely.
# Uncomment what you need - re-running this installer keeps whatever you set here.
#LAZYIT_COLLECT_HARDWARE=false
#LAZYIT_COLLECT_DISKS=false
#LAZYIT_COLLECT_NICS=false
#LAZYIT_COLLECT_SOFTWARE=false
#LAZYIT_COLLECT_CONTAINERS=false
#LAZYIT_MIN_INTERVAL=3600
#LAZYIT_SOFTWARE_MAX=500
#LAZYIT_EXCLUDE_NICS=veth*,docker*
#LAZYIT_EXCLUDE_MOUNTPOINTS=/var/lib/docker/*,/snap/*
#LAZYIT_EXCLUDE_SOFTWARE=linux-image-*
#
# How this host reaches your instance (#1137). A systemd unit starts with an almost-empty
# environment, so a proxy set in /etc/environment or a shell profile does NOT reach the timer -
# set it here. LAZYIT_CA_FILE is a PEM bundle the AGENT trusts, instead of trusting your internal
# CA system-wide. Kept across a re-install like everything else above.
#HTTPS_PROXY=http://proxy.example.com:3128
#NO_PROXY=lazyit.example.com,.internal
#LAZYIT_CA_FILE=/etc/pki/ca-trust/source/anchors/internal-root.pem
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
# Hard ceiling on a single run (#1133). The agent bounds each collector itself, but a child stuck
# in uninterruptible I/O (a degraded NFS mount, a wedged BMC) can outlive a SIGKILL. Without this,
# the unit sits in 'activating' forever - and OnUnitActiveSec only re-arms once a unit goes
# INACTIVE, so the timer would never fire again and the host would look OFFLINE when only the
# agent was stuck. systemd reaps the whole cgroup; the next tick starts clean.
RuntimeMaxSec=120

# SANDBOXING (#1137). The agent runs as root because dmidecode does, but "needs root" is not "needs
# everything root can do". Each line below costs the agent nothing it actually uses - it reads /proc,
# /sys, /etc and the package databases, runs dmidecode against /dev/mem, and writes only $STATE_DIR.
# ProtectSystem=full leaves /var writable while making /usr, /boot and /etc read-only, so the agent
# cannot rewrite its own binary or its own config; strict would break $STATE_DIR and is not used.
#
# Deliberately ABSENT: PrivateDevices=yes, which would take /dev/mem away and silently cost every
# host its serial number, manufacturer and model - the facts clone detection depends on. Whatever
# else is added here later, that one stays out.
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes

# PRIORITY (#1137). \`rpm -qa\` on a 3000-package host is real CPU and real I/O, and this agent runs
# on database and application servers whose actual job is not being inventoried. Nothing here has a
# deadline: the run is a one-shot with a 5-minute tick behind it and a server-set cadence in front,
# so yielding to every other process on the box costs the report nothing anyone can perceive.
#
# WHAT THESE TWO LINES COST, AND WHY THEY SHIPPED WHEN THEY DID. Deprioritising the run makes
# \`dpkg-query\`/\`rpm -qa\` more likely to hit the agent's 10 s per-command collect budget - on exactly
# the busy servers that motivated the directives. That used to be a DATA-LOSS risk and not a latency
# one: a collect that timed out yielded no package list, and an absent \`software\` key on the wire was
# read by the server as DELETE, not as "unchanged". Three correct decisions composing into a wiped
# inventory: deprioritise -> time out -> omit -> wipe.
#
# #1142/#1163 landed FIRST and replaced that reading, which is why these two lines are here at all. A
# collect that cannot enumerate now says \`softwareState: unavailable\` (see \`collectSoftware\` in
# apps/agent/src/collect.ts) and the server PRESERVES the list it holds; only an explicit \`disabled\`
# clears it. The chain ends at "omit". What is left is an invariant, not a merge order: an absent
# package list must never again be given the meaning "delete".
Nice=19
IOSchedulingClass=idle
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=lazyit reporting agent timer (fixed 5-minute tick; cadence is set in lazyit)

[Timer]
OnBootSec=2min
# THE TICK, NOT THE CADENCE (#1140). The agent exits immediately on a tick that is inside its
# server-set reporting interval, so this value never has to change - which is exactly the point:
# moving a fleet from 5 minutes to 24 hours is a setting in lazyit, not an SSH session and a
# daemon-reload on every host. Leave it alone.
OnUnitActiveSec=$TICK
Persistent=true
# DE-PHASING, which the agent's own jitter deliberately does not do (#1137). The per-machine offset
# in agentPolicyDue() absorbs scheduler slack; it cannot spread an estate, because it is only ever
# evaluated ON a tick and the ticks themselves are what a patch-and-reboot window aligns. This is the
# layer where the ticks live. Every elapse is delayed by 0-$JITTER, so hosts that came back together
# drift apart instead of POSTing a full inventory in the same second and running into the per-token
# report limit (#1134). The cost is bounded and small: a report already lands at the first tick at or
# after its due instant, so it can be up to one tick late; this adds at most $JITTER on top. Against
# the default staleness cutoff of three reporting intervals, both are far inside tolerance.
RandomizedDelaySec=$JITTER

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now lazyit-agent.timer >/dev/null 2>&1 || die "failed to enable the timer"

# --- one immediate report --------------------------------------------------
# --force, because the agent would otherwise honour the interval it just cached and a re-install
# would print nothing useful. An installer that cannot tell you whether the token works is worse
# than one that reports once more than strictly necessary.
echo "lazyit-agent install: sending the first report ..."
if "$BIN_PATH" report --once --force; then
  echo
  echo "lazyit-agent install: done. The timer ticks every $TICK; how often this host actually"
  echo "reports is set centrally in lazyit (Settings -> Instance -> Reporting agents) and picked up on the next report."
  echo "This host now appears in lazyit's infra topology PENDING tray - confirm it there to track it as an asset."
  echo "Diagnostics: 'lazyit-agent test' checks the URL, token and network; 'lazyit-agent show' prints"
  echo "the report it would send. Removal: re-run this script with --uninstall."
else
  die "the first report failed - check the URL/token; the timer is installed and will retry. 'lazyit-agent test' says which part failed."
fi
