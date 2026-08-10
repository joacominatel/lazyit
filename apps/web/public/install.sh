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
# AND OUT OF CURL'S `ps` LINE TOO, which for a long time this script only claimed. Both downloads
# below used to spell the credential as `-H "Authorization: Bearer $TOKEN"`, so every one of the
# three safe forms above handed it straight back: /proc/<pid>/cmdline is world-readable on Linux, and
# any unprivileged user polling it during an install - or during an upgrade, which is the run that
# gets repeated on every host in the estate - collected a live infra:report token. The header now
# goes in on curl's STDIN (`--config -`, see `auth_config` below), which is in neither `ps` nor
# /proc. That pipe is CURL's stdin, not this script's, so it does not collide with `--token-file -`.
#
# UPGRADING A HOST THAT IS ALREADY INSTALLED: `--keep-token` (#1208). Re-running this script is the
# documented upgrade path, and it used to demand the token on every run - which lazyit cannot hand
# back, because it stores only a hash and a prefix of it (ADR-0048). So an upgrade was copy-paste
# PLUS go and find a secret. `--keep-token` authenticates the run with the token in
# /etc/lazyit-agent/config, which this script wrote there itself, chmod 600, root-only:
#
#   sh install.sh --url https://lazyit.example.com --keep-token
#
# AN EXPLICIT FLAG, NOT AN IMPLICIT DEFAULT FOR A RE-RUN, and that is the whole decision. Implicit is
# friendlier by one word and wrong in the case that matters: `sh install.sh --url ... $TOKEN_VAR`
# with the variable misspelled, or a wrapper that stopped exporting LAZYIT_TOKEN, would stop being a
# loud "a token is required" and become a silent install with the OLD credential - so a host keeps
# reporting with a token somebody believes they replaced, and nobody finds out. Where the credential
# for a root install came from is not a thing to infer from the state of the disk. It is also what
# makes this greppable in an audit: a run either says --keep-token or it carries a token.
#
# UPGRADING WITHOUT REPEATING ANYTHING AT ALL: `--upgrade` (#1208). `--keep-token` closed the
# credential half and left the rest of the command to be supplied again - and the update command an
# admin is handed comes out of a browser, so `--url` in it is whatever ORIGIN that browser was on.
# On a fleet in the `lan` deployment mode of ADR-0087 that silently repoints every host it touches at
# one admin's address, and it carries no `--ca-file`, so a host installed against an internal CA
# fails its download on the very run that was supposed to be the easy one.
#
#   sh install.sh --upgrade
#
# `--upgrade` is `--keep-token` PLUS the rest: LAZYIT_URL and LAZYIT_CA_FILE come from
# /etc/lazyit-agent/config when they are not passed. Anything explicit still wins, so
# `--upgrade --url https://moved.example.com` retargets a host that really did move - the difference
# being that the retarget was TYPED rather than inherited from whoever generated the command.
#
# WHY A SECOND FLAG AND NOT A WIDER `--keep-token`. The name has to be true at the call site a year
# from now. `--keep-token` says token, and a host reading its own URL back off disk is not that.
# `--keep-config` was the other candidate and is already taken by --uninstall, where it means "keep
# the file when removing the agent"; one word for two different things in two different modes is the
# thing an operator misreads. `--upgrade` says what the run IS, which is also why it can be the whole
# command: no origin, no secret, nothing that differs between one host and the next.
#
# IT INHERITS --keep-token's POSTURE ON CREDENTIALS WHOLE - a hard error against --token,
# --token-file and LAZYIT_TOKEN, and no precedence rule. The URL and the CA are settings and take the
# ordinary flag-over-environment-over-file precedence; a credential is not, for the reason written
# above: quietly choosing between two of them is how a host ends up authenticating with the one that
# was just rotated away. Rotating a token on a host is therefore still the ordinary install form,
# `--url ... --token <new>`, and the refusal says so.
#
# HYPERVISOR HOSTS REPORT THEIR GUESTS, AND THE INSTALLER CONFIGURES NOTHING FOR IT (ADR-0095). On
# a Proxmox VE or libvirt/KVM host the agent inventories the guests running there (QEMU VMs, LXC
# containers) alongside the host's own facts. Detection lives in the AGENT and runs on every tick -
# so a host promoted to a hypervisor next month starts reporting guests with no re-install, and the
# banner this script prints ("Detected: Proxmox VE ...") is informational only, never stale
# authority. The one knob is negative: `--no-hypervisor` writes LAZYIT_COLLECT_HYPERVISOR=false
# into the config - a host-owner VETO the server's policy can never widen, exactly like every other
# LAZYIT_COLLECT_* key - and re-running this installer preserves it like every other local setting.
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
# Authenticate this run with the token already in the config file (#1208). See the header for why it
# is a flag and not the implicit default for a re-run.
KEEP_TOKEN=0
# Re-run this host from its own configuration: --keep-token, plus LAZYIT_URL and LAZYIT_CA_FILE off
# the disk when they are not passed (#1208). See the header for why it is its own flag.
UPGRADE=0
# What the two values above were taken from, so a failure names the file rather than a flag the
# operator never typed.
UPGRADE_URL=""
UPGRADE_CA=""
CA_SOURCE="--ca-file"
URL_SOURCE="--url"
# Accepted for compatibility and IGNORED: checksum verification is required by default since #1190.
# Kept so existing automation that passes --require-checksum keeps working unchanged.
REQUIRE_CHECKSUM=0
# The binary's sha256, obtained OUT OF BAND (#1190) - the escape hatch for an instance that
# publishes no digest, never a way to skip verification. See the integrity block below.
SHA256=""
# Plain http is an explicit decision, not a default (#1190) - see the gate below.
ALLOW_INSECURE_HTTP=0
FORCE_BASELINE=0
# Write the ADR-0095 hypervisor veto (LAZYIT_COLLECT_HYPERVISOR=false) into the config: this host
# never reports its guests, whatever lazyit's policy says. Without the flag nothing is configured -
# detection and collection are automatic, re-evaluated by the agent on every run.
NO_HYPERVISOR=0

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

# The value the config file on STDIN assigns to $1, or nothing at all when it assigns none (#1208).
#
# PURE ON PURPOSE: stdin and a key in, one word out, no path of its own and no root. That is what
# lets the contract test in apps/agent run THIS function over a corpus of real config files instead
# of a copy of it - the same reason install.ps1's two PATH functions take their input as parameters.
#
# ONE EXTRACTOR FOR ALL THREE KEYS the re-run forms read back (TOKEN, URL, CA_FILE). Three copies
# with the same intent are three chances to disagree about a file a host actually has, and the one
# that disagreed would be found the way the padded key below was found: on a host that had been
# reporting for months.
#
# IT HAS TO AGREE WITH THE AGENT'S OWN PARSER (`readConfigFile` in apps/agent/src/config.ts) on every
# point where a hand-edited file can differ from the one this script writes, because the whole
# promise of --keep-token is "the credential this host is ALREADY using": the LAST assignment wins
# (the agent assigns key by key as it reads), the value is trimmed, and one matching pair of
# surrounding quotes is stripped. Reading a different token than the agent reads would install
# cleanly, report once with the wrong credential, and then fail on every tick.
#
# WHITESPACE IS ALLOWED AROUND THE KEY for the same reason, and it is not hypothetical: the agent
# trims the key before it compares (`line.slice(0, eq).trim()`), so `LAZYIT_TOKEN =lzit_sa_...` -
# a hand edit, or a config-management template that pads its assignments - authenticates every tick,
# while a pattern demanding `=` immediately after the key answered "this host has no token" and
# refused the upgrade. `_` is not whitespace, so LAZYIT_TOKEN_FILE is still a different key.
#
# CR is dropped because a config that has been through a Windows editor comes back with CRLF, and a
# trailing carriage return inside a bearer token is a 401 with nothing in the message to explain it.
# `CV_` prefixed globals rather than locals: POSIX sh has no `local`.
config_value() {
  CV_KEY="$1"
  CV_LINE="$(grep -E "^[[:space:]]*$CV_KEY[[:space:]]*=" | tail -n 1 || true)"
  [ -n "$CV_LINE" ] || return 0
  # Only the FIRST '=' separates the key from the value - a token is opaque and may contain one.
  CV_VALUE="${CV_LINE#*=}"
  CV_VALUE="$(printf '%s' "$CV_VALUE" | tr -d '\r')"
  CV_VALUE="${CV_VALUE#"${CV_VALUE%%[![:space:]]*}"}"
  CV_VALUE="${CV_VALUE%"${CV_VALUE##*[![:space:]]}"}"
  case "$CV_VALUE" in
    \"*\") CV_VALUE="${CV_VALUE#\"}"; CV_VALUE="${CV_VALUE%\"}" ;;
    \'*\') CV_VALUE="${CV_VALUE#\'}"; CV_VALUE="${CV_VALUE%\'}" ;;
  esac
  printf '%s' "$CV_VALUE"
}

# The Authorization header for $1, as a curl config file on STDOUT (#1208 review).
#
# WHY THIS EXISTS AT ALL. `-H "Authorization: Bearer $TOKEN"` is an ARGUMENT, and arguments are
# public: /proc/<pid>/cmdline is world-readable on Linux, so the credential was legible to every user
# on the box for the length of both downloads. `curl --config -` reads the same options from stdin,
# which is not. See the header for the whole argument.
#
# PURE, and for the usual reason: the token comes in as a parameter, one config line goes out, so the
# contract test can run THIS function over a corpus rather than a copy of it.
#
# THE ESCAPING IS NOT DECORATION. curl gives `\` and `"` a meaning inside a quoted config value, so a
# token carrying either would be sent mangled or truncated - a 401 with nothing in it to explain why.
# The remaining shape, a newline ending the line and letting whatever follows be read as another curl
# option, is closed one layer up: a token containing ANY whitespace is refused outright.
auth_config() {
  printf 'header = "Authorization: Bearer %s"\n' \
    "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# What hypervisor this host is, for the banner below (ADR-0095): "proxmox", "libvirt", or nothing.
#
# PURE ON PURPOSE, like its two siblings above: the mounts table comes in on stdin and the two
# probes ("does /dev/kvm exist", "is virsh on PATH") come in as parameters, so the contract test in
# apps/agent runs THIS function over fixtures instead of a copy of it.
#
# Proxmox is recognised by the pmxcfs cluster filesystem: /etc/pve mounted with a fuse type, which
# every PVE node has whether or not it is clustered. A directory merely CALLED /etc/pve on an
# ordinary filesystem is not it, and neither is a mountpoint that only starts with the name - the
# pattern demands the whole path segment and the fuse type after it. libvirt needs BOTH probes:
# /dev/kvm alone is any machine with virtualization exposed (most laptops), and virsh alone is a
# client package. Best-effort by design: the AGENT's own per-run detection is the authority, this
# only feeds one informational line, and every caller tolerates an empty answer.
hypervisor_kind() {
  HK_KVM="${1:-0}"
  HK_VIRSH="${2:-0}"
  if grep -q '^[^ ][^ ]* /etc/pve fuse' 2>/dev/null; then
    printf 'proxmox'
  elif [ "$HK_KVM" = "1" ] && [ "$HK_VIRSH" = "1" ]; then
    printf 'libvirt'
  fi
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
    --no-hypervisor) NO_HYPERVISOR=1; shift ;;
    --sha256) SHA256="${2:-}"; shift 2 ;;
    --sha256=*) SHA256="${1#*=}"; shift ;;
    --allow-insecure-http) ALLOW_INSECURE_HTTP=1; shift ;;
    --require-checksum) REQUIRE_CHECKSUM=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --keep-config) KEEP_CONFIG=1; shift ;;
    --keep-token) KEEP_TOKEN=1; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    -h|--help)
      echo "Usage: install.sh --url <base-url> (--token <token> | --token-file <path> | --keep-token)"
      echo "       install.sh --upgrade          (re-run an installed host from its own config)"
      echo "       install.sh --uninstall [--keep-config]"
      echo "  --url <base-url>     your lazyit instance, scheme + host + port and nothing else:"
      echo "                       e.g. https://lazyit.example.com  (NOT .../install.sh - this"
      echo "                       script appends /api/agent/download to whatever you pass)"
      echo "  --token-file <path>  read the token from a file ('-' = stdin; not usable with curl | sh)"
      echo "                       LAZYIT_TOKEN in the environment works too. Both keep the token out"
      echo "                       of ps and of root's history; --token keeps it out of neither."
      echo "  --keep-token         re-run over an existing install, authenticating with the token"
      echo "                       already in $CONFIG_FILE - nothing is typed and nothing"
      echo "                       reaches ps. Refuses --token/--token-file/LAZYIT_TOKEN alongside it."
      echo "  --upgrade            a re-run that needs no arguments at all: --keep-token, plus this"
      echo "                       host's own LAZYIT_URL and LAZYIT_CA_FILE when they are not passed."
      echo "  --ca-file <path>     PEM bundle to trust, instead of trusting your CA system-wide;"
      echo "                       used for this download AND written into the agent's config"
      echo "  --baseline           force the pre-AVX2 x86-64 build (auto-detected otherwise)"
      echo "  --no-hypervisor      write LAZYIT_COLLECT_HYPERVISOR=false into the config: this host"
      echo "                       never reports its hypervisor guests (Proxmox VE / libvirt), whatever"
      echo "                       lazyit's policy says. Without it nothing is configured - the agent"
      echo "                       detects the role itself, on every run (ADR-0095)."
      echo "  --sha256 <hex>       the binary's sha256, obtained OUT OF BAND - the escape hatch when"
      echo "                       an older instance publishes no digest. Verification itself is"
      echo "                       required by default and a mismatch is always fatal."
      echo "  --allow-insecure-http  allow a plain-http --url. CLEARTEXT: the binary (which will run"
      echo "                       as root) and the SA token are both exposed to anyone on the"
      echo "                       network path - the token on every report, not only today."
      echo "  --require-checksum   accepted for compatibility and IGNORED - checksum verification"
      echo "                       is required by default now."
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
  # REFUSED RATHER THAN IGNORED (#1208). `--keep-config` keeps this host's own limits through an
  # uninstall; nothing keeps the TOKEN, and that is the point of the block further down. Accepting
  # `--keep-token` here - even as a harmless no-op - would let an operator finish an uninstall
  # believing a live credential survived on a host they are decommissioning, or that it did not.
  [ "$UPGRADE" = "0" ] || die "--upgrade has no meaning with --uninstall: there is nothing to re-run and nothing to carry forward. --keep-config keeps this host's own limits; the token NEVER survives an uninstall."
  [ "$KEEP_TOKEN" = "0" ] || die "--keep-token has no meaning with --uninstall: the token NEVER survives an uninstall. --keep-config keeps this host's own limits, never the credential."
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
  #
  # The key may carry whitespace before its `=`, because the AGENT accepts that spelling and so a
  # host can really have one. A pattern that missed `LAZYIT_TOKEN =` would leave a working credential
  # on a decommissioned host, inside the file the operator was told keeps only their own limits.
  if [ "$KEEP_CONFIG" = "1" ] && [ -f "$CONFIG_FILE" ]; then
    KEPT="$(grep -Ev '^[[:space:]]*LAZYIT_(TOKEN|URL)[[:space:]]*=' "$CONFIG_FILE" || true)"
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
# THE RE-RUN FORM (#1208), resolved FIRST so that a second token source is refused before anything
# else is read - `--keep-token --token-file /gone` must name the contradiction, not the missing file.
#
# A HARD ERROR FOR EVERY OTHER SOURCE, INCLUDING THE ENVIRONMENT, and no precedence rule anywhere.
# Two token sources on one root install is an operator who believes something about this run that is
# not true, and quietly picking one is how a host ends up authenticating with the credential that was
# just rotated away - the failure this flag exists to prevent, arriving through the flag itself.
# LAZYIT_TOKEN is included even though it is ambient rather than typed: it is the form the docs
# recommend for keeping a token out of `ps`, so it is exactly the one that would be left set in a
# root shell from the install before this one.
#
# `--upgrade` CONTAINS `--keep-token` rather than competing with it: it is the same read of the same
# file, plus the settings. Everything below therefore has one name for whichever flag the operator
# actually typed, so a run that said --upgrade is never answered about a flag it did not pass.
if [ "$UPGRADE" = "1" ]; then
  KEEP_TOKEN=1
  RERUN_FLAG="--upgrade"
else
  RERUN_FLAG="--keep-token"
fi

if [ "$KEEP_TOKEN" = "1" ]; then
  [ -z "$TOKEN" ] || die "$RERUN_FLAG and --token are mutually exclusive - pass one. $RERUN_FLAG means 'authenticate with the token this host already has'; passing another one says the opposite. To ROTATE the credential on a host, install it the ordinary way: --url <base-url> --token <new>."
  [ -z "$TOKEN_FILE" ] || die "$RERUN_FLAG and --token-file are mutually exclusive - pass one. $RERUN_FLAG means 'authenticate with the token this host already has'; passing a file says the opposite."
  [ -z "${LAZYIT_TOKEN:-}" ] || die "$RERUN_FLAG and LAZYIT_TOKEN in the environment both supply a token - pass one. Unset LAZYIT_TOKEN to re-use what is on this host, or drop $RERUN_FLAG to install with the one in the environment."
  # NEVER A SILENT UNAUTHENTICATED OR UNCONFIGURED INSTALL: no readable config is fatal here, and the
  # message names root FIRST because the file is chmod 600 and "I forgot sudo" is the likelier of the
  # two ways to arrive at it - the other being a first install, which has nothing to re-use by
  # definition and needs --url and a token of its own.
  [ -r "$CONFIG_FILE" ] || die "$RERUN_FLAG re-runs this host from the settings it already has, and $CONFIG_FILE cannot be read. If the agent IS installed here, re-run this as root - that file is chmod 600. If it is not, this is a first install and there is nothing to re-use: pass --url plus --token, --token-file, or LAZYIT_TOKEN."
  TOKEN="$(config_value LAZYIT_TOKEN < "$CONFIG_FILE")"
  [ -n "$TOKEN" ] || die "$CONFIG_FILE has no LAZYIT_TOKEN line, so there is no token on this host to re-use. Pass --token, --token-file, or set LAZYIT_TOKEN. Note that lazyit cannot show you an existing token a second time (it stores only a hash and a prefix), so this may need a fresh one from Settings -> Instance -> Reporting agents."
  # The same guard --token-file applies, one source over: a Service Account token is one opaque word,
  # and a hand-edited config that split it across a space would otherwise be sent as a bearer token
  # and come back 401 with nothing to say which of the two files was wrong.
  case "$TOKEN" in
    *[[:space:]]*)
      die "the LAZYIT_TOKEN line in $CONFIG_FILE is not a token (it contains whitespace). Fix that file, or pass --token / --token-file for this run." ;;
  esac
  echo "lazyit-agent install: authenticating with the token already in $CONFIG_FILE ($RERUN_FLAG); nothing was passed on the command line."

  # THE SETTINGS HALF, and only under --upgrade. Read here, applied further down, so the precedence
  # stays the one every other setting in this script has: an explicit flag, then the environment,
  # then this file.
  #
  # THE LOWERCASE CA SPELLING IS TRIED FIRST because that is how the AGENT resolves it - `networkFrom`
  # in apps/agent/src/net.ts prefers `lazyit_ca_file` over `LAZYIT_CA_FILE` when a host carries both,
  # measured against curl and Bun rather than recalled. Reading the other one here would have this
  # script download over one trust anchor and the agent report over another, which is a failure that
  # only shows up on the next tick, on somebody else's shift.
  if [ "$UPGRADE" = "1" ]; then
    UPGRADE_URL="$(config_value LAZYIT_URL < "$CONFIG_FILE")"
    UPGRADE_CA="$(config_value lazyit_ca_file < "$CONFIG_FILE")"
    [ -n "$UPGRADE_CA" ] || UPGRADE_CA="$(config_value LAZYIT_CA_FILE < "$CONFIG_FILE")"
  fi
fi

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

# THE SETTINGS THE HOST ALREADY HAS, LAST (#1208). Flag, then environment, then the file - the same
# order the agent's own config resolution uses, so "the explicit one wins" needs no exception here.
# Nothing is re-used silently: what came off the disk is printed, by key, before anything is
# downloaded or written.
if [ "$UPGRADE" = "1" ]; then
  UPGRADE_KEPT=""
  if [ -z "$URL" ]; then
    URL="$UPGRADE_URL"
    if [ -n "$URL" ]; then
      UPGRADE_KEPT="LAZYIT_URL=$URL"
      URL_SOURCE="LAZYIT_URL in $CONFIG_FILE (re-used by --upgrade)"
    fi
  fi
  if [ -z "$CA_FILE" ] && [ -n "$UPGRADE_CA" ]; then
    CA_FILE="$UPGRADE_CA"
    CA_SOURCE="LAZYIT_CA_FILE in $CONFIG_FILE (re-used by --upgrade)"
    UPGRADE_KEPT="${UPGRADE_KEPT:+$UPGRADE_KEPT, }LAZYIT_CA_FILE=$CA_FILE"
    # Named HERE rather than left to curl, because "certificate verify failed" on an upgrade sends an
    # operator looking at their instance's certificate, and the answer is a file that moved on this
    # host. Checked before the root test below for the same reason the --url guard is: an argument
    # this script can see is wrong should be named before a privilege it cannot see is missing.
    [ -r "$CA_FILE" ] || die "$CA_SOURCE names a PEM bundle that cannot be read: $CA_FILE. Restore it, or pass --ca-file with the path it moved to."
  fi
  [ -z "$UPGRADE_KEPT" ] || echo "lazyit-agent install: --upgrade re-used this host's own $UPGRADE_KEPT from $CONFIG_FILE."
  # A config with a token but no URL. Refused by name: the generic "--url is required" below would be
  # true and useless, because the operator did not think they were supplying one.
  [ -n "$URL" ] || die "--upgrade re-runs this host on the URL it already has, and $CONFIG_FILE has no LAZYIT_URL line. Pass --url <base-url> for this run (the agent has been unable to report without one)."
fi

[ -n "$URL" ] || die "--url is required (your lazyit instance, e.g. https://lazyit.example.com)"
[ -n "$TOKEN" ] || die "a token is required - pass --token, --token-file, --keep-token or --upgrade (a re-run over an existing install), or set LAZYIT_TOKEN (needs infra:report)"
# ONE GUARD FOR EVERY SOURCE, and it is not only about a 401. The token is handed to curl as a config
# file (`auth_config` above), where a newline would end the header line and let whatever followed it
# be read as another curl option. --token-file and the config file each check their own shape and say
# which file was wrong; this is the backstop that also covers --token and LAZYIT_TOKEN.
case "$TOKEN" in
  *[[:space:]]*)
    die "the token contains whitespace, so it is not a Service Account token - a token is one opaque word. Check what --token or LAZYIT_TOKEN was given." ;;
esac
URL="${URL%/}" # strip a trailing slash

# --- --url IS THE INSTANCE BASE URL, NOT THE ADDRESS OF THIS SCRIPT (#1166) ---
# Every request below is built as "$URL/api/...", so `--url https://host/install.sh` asks the server
# for https://host/install.sh/api/agent/download?arch=... . What reaches the operator is the download
# failure further down, which names the token as a likely cause - so they go and rotate a Service
# Account credential that was never wrong. It was a Windows operator who hit this first, on the
# identical shape in install.ps1; nothing about the mistake is Windows-specific. Checked HERE, before
# anything is downloaded, so the message names the real mistake and suggests the URL they meant.
#
# THE SCHEME IS COMPARED CASE-INSENSITIVELY. RFC 3986 section 3.1 makes the scheme case-insensitive,
# curl accepts HTTPS:// exactly as it accepts https://, and install.ps1 spells this check with
# -notmatch, which is case-insensitive by default. A case-sensitive `case` here made the two
# installers disagree about one input: HTTPS://host installed on Windows and died on Linux.
case "$URL" in
  *://*) URL_SCHEME="$(printf '%s' "${URL%%://*}" | tr '[:upper:]' '[:lower:]')" ;;
  *)     URL_SCHEME="" ;;
esac
case "$URL_SCHEME" in
  http|https) ;;
  *) die "--url must be your lazyit instance base URL, starting with http:// or https:// (e.g. https://lazyit.example.com). Got: $URL" ;;
esac
# Split into origin and path, and check the PATH from here on. Matching patterns against the whole
# URL string is what made the first version of this guard suggest a BROKEN replacement: on
# https://api.example.com/api, `${URL%%/api*}` strips from the /api inside the HOST and answers
# `https:/`. A suggestion is pasted, so a wrong one is worse than none.
# `${URL#*://}` drops the scheme; a host with no path has no slash left in it, which is the ordinary
# case and yields an empty URL_PATH.
URL_HOSTPATH="${URL#*://}"
URL_ORIGIN="${URL%%://*}://${URL_HOSTPATH%%/*}"
case "$URL_HOSTPATH" in
  */*) URL_PATH="/${URL_HOSTPATH#*/}" ;;
  *)   URL_PATH="" ;;
esac

# THIS SCRIPT'S NAME ANYWHERE IN THE PATH, not only as the first segment. A reverse proxy that
# strips a prefix serves it at https://it.example.com/lazyit/install.sh, and copying that address
# out of the browser is precisely how the mistake gets made - in the one deployment shape the
# warning branch below exists to protect. Matching the trailing slash too keeps the filename a
# COMPLETE path segment, so /install.shed is not mistaken for this script and refused wrongly.
URL_IS_SCRIPT=0
URL_SCRIPT_PREFIX=""
case "$URL_PATH/" in
  */install.sh/*)  URL_IS_SCRIPT=1; URL_SCRIPT_PREFIX="$URL_PATH/"; URL_SCRIPT_PREFIX="${URL_SCRIPT_PREFIX%%/install.sh/*}" ;;
  */install.ps1/*) URL_IS_SCRIPT=1; URL_SCRIPT_PREFIX="$URL_PATH/"; URL_SCRIPT_PREFIX="${URL_SCRIPT_PREFIX%%/install.ps1/*}" ;;
esac
if [ "$URL_IS_SCRIPT" = "1" ]; then
  die "--url is your lazyit instance base URL, not the address of this script. You passed $URL; pass --url $URL_ORIGIN$URL_SCRIPT_PREFIX instead. The installer appends /api/agent/download to it itself."
fi
# /api only at the START of the path. Under a prefix mount, /lazyit/api falls through to the warning
# below rather than being refused - deliberately, since that is the shape a stripping proxy makes.
case "$URL_PATH" in
  /api|/api/*)
    die "--url is your lazyit instance base URL, not an API endpoint. You passed $URL, and the installer would then ask for $URL/api/agent/download. Pass --url $URL_ORIGIN." ;;
esac
# ANY OTHER PATH IS A WARNING, NOT A REFUSAL, and that asymmetry is deliberate. lazyit sets no
# Next.js basePath, so a path here is almost always the same mistake in a different shape - but a
# reverse proxy that strips a prefix really can mount an instance under one, and re-running this
# script is the documented UPGRADE path. Refusing outright would break a deployment that works
# today; the two branches above are the only two shapes that can never be a valid base URL.
if [ -n "$URL_PATH" ]; then
  echo "lazyit-agent install: --url carries a path ($URL_PATH) and lazyit is served from the root of its origin, so this is usually a mistake - pass just the scheme, host and port. Continuing, in case your reverse proxy really does mount lazyit under that path." >&2
fi

# --- plain http is an explicit decision, not a default (#1190) --------------
# ADR-0087 accepts that a self-hosted LAN instance may have no TLS at all, so http stays POSSIBLE -
# but never silent. Everything on a cleartext channel is readable and replaceable by anyone on the
# network path: the binary this script installs to run as root, its sha256 (fetched over the SAME
# channel, so a matching digest proves nothing against an on-path attacker - pass --sha256 from
# somewhere else if you can), and the Service Account token, which is persisted into the config WITH
# this URL and therefore crosses the network in cleartext again on every report this host ever
# sends. The scheme was lowercased above, so HTTP:// lands here exactly like http://.
#
# AND `--upgrade` DOES NOT INHERIT THE DECISION (#1208 review). A host installed with
# --allow-insecure-http carries `LAZYIT_URL=http://...` in its config, so a re-run that re-used it
# would arrive here with a cleartext URL nobody typed - and letting the file answer "yes, cleartext
# is acceptable" on the operator's behalf is exactly the fail-open #1190 closed, one input over. The
# gate bites on the RESOLVED url whatever supplied it; `$URL_SOURCE` names which that was, so the
# refusal does not tell an operator about a `--url` they did not pass. Settings are re-used; an
# acceptance of exposure is not a setting.
if [ "$URL_SCHEME" = "http" ]; then
  if [ "$ALLOW_INSECURE_HTTP" != "1" ]; then
    die "$URL_SOURCE uses plain http, and everything on this channel crosses the network in CLEARTEXT: an on-path attacker can replace the binary this host will run as root, and the Service Account token is saved with this URL, so it is exposed again on every report this host ever sends. Use https (see --ca-file for an internal CA), or pass --allow-insecure-http if you accept BOTH exposures on this network."
  fi
  echo "lazyit-agent install: WARNING - --allow-insecure-http: installing over plain http. The binary this host will run as root and the Service Account token BOTH cross the network in cleartext, the token on every report from now on, not only today. Anyone on the network path can take root on this host. Move to https when you can." >&2
fi

# --- hypervisor detection banner (ADR-0095) ---------------------------------
# INFORMATIONAL ONLY. The AGENT re-detects the hypervisor role on every run, so this banner can
# never become stale authority - it exists so the operator learns, at the one moment they are
# looking, that this host's guests are about to be inventoried and how to say no. Best-effort and
# never fatal by construction: every probe tolerates its own absence (no /proc/mounts on this
# kernel, no /dev/kvm, no virsh on PATH), and an empty answer prints nothing at all.
HV_KVM=0
if [ -e /dev/kvm ]; then HV_KVM=1; fi
HV_VIRSH=0
if command -v virsh >/dev/null 2>&1; then HV_VIRSH=1; fi
HV_KIND="$(cat /proc/mounts 2>/dev/null | hypervisor_kind "$HV_KVM" "$HV_VIRSH")" || HV_KIND=""
if [ "$HV_KIND" = "proxmox" ]; then
  if [ "$NO_HYPERVISOR" = "1" ]; then
    echo "lazyit-agent install: Detected: Proxmox VE - hypervisor guest collection is disabled by --no-hypervisor (the config gets LAZYIT_COLLECT_HYPERVISOR=false)."
  else
    echo "lazyit-agent install: Detected: Proxmox VE - this host's guests (QEMU VMs, LXC containers) will be inventoried. Disable with --no-hypervisor."
  fi
elif [ "$HV_KIND" = "libvirt" ]; then
  if [ "$NO_HYPERVISOR" = "1" ]; then
    echo "lazyit-agent install: Detected: libvirt/KVM - hypervisor guest collection is disabled by --no-hypervisor (the config gets LAZYIT_COLLECT_HYPERVISOR=false)."
  else
    echo "lazyit-agent install: Detected: libvirt/KVM - this host's guests (QEMU/KVM virtual machines) will be inventoried. Disable with --no-hypervisor."
  fi
fi

[ "$(id -u)" = "0" ] || die "must run as root (installs to /usr/local/bin, /etc and systemd)"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

# The private CA, if there is one. Unquoted below on purpose - this is how POSIX sh passes two
# arguments from one variable - so the path must not contain spaces.
# `$CA_SOURCE` is "--ca-file" for a flag and names the config file when --upgrade re-used one, so a
# host whose bundle moved is told about the file it has rather than about a flag nobody typed.
CURL_CA=""
if [ -n "$CA_FILE" ]; then
  [ -r "$CA_FILE" ] || die "cannot read $CA_SOURCE: $CA_FILE"
  case "$CA_FILE" in
    *" "*) die "$CA_SOURCE must not contain spaces: $CA_FILE" ;;
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
#
# The credential goes in on curl's STDIN, never in its arguments - see `auth_config` above and the
# header. The pipe is CURL's stdin and not this script's, so `--token-file -` is unaffected.
if ! auth_config "$TOKEN" | curl -fsSL --max-redirs 0 $CURL_CA --config - \
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
#
# REQUIRED BY DEFAULT, AND IT CANNOT FAIL OPEN (#1190). The first shape of this check degraded ANY
# error fetching the digest to a note unless --require-checksum was passed - so an attacker who
# could 404 one route stripped the verification entirely. A check the party being checked can switch
# off is not a check. The one escape hatch is --sha256: a digest obtained OUT OF BAND, for an
# instance older than this installer, which publishes none. --require-checksum stays accepted and
# now means nothing.
if [ -n "$SHA256" ]; then
  EXPECTED="$(printf '%s' "$SHA256" | tr '[:upper:]' '[:lower:]')"
  case "$EXPECTED" in
    *[!0-9a-f]*) die "--sha256 must be the binary's sha256 as 64 hex characters. Got: $SHA256" ;;
  esac
  [ "${#EXPECTED}" = "64" ] || die "--sha256 must be the binary's sha256 as 64 hex characters. Got: $SHA256"
  echo "lazyit-agent install: verifying against the sha256 passed with --sha256 (out of band)."
else
  # The credential goes in on curl's STDIN here too (#1208 review). This fetch is REQUIRED, so it is
  # the one that runs on every install and every upgrade - which makes it the one whose argv an
  # unprivileged user polling /proc/<pid>/cmdline was most reliably able to catch.
  if ! EXPECTED="$(auth_config "$TOKEN" | curl -fsSL --max-redirs 0 $CURL_CA --config - \
    "$URL/api/agent/checksum?arch=$ARCH" 2>/dev/null)"; then
    die "could not fetch the sha256 this instance publishes for $ARCH, and checksum verification is REQUIRED - a fetch that fails open is a check an attacker strips by failing it. Nothing installed. An instance older than this installer publishes no digest: upgrade lazyit, or pass --sha256 <digest> obtained OUT OF BAND."
  fi
  EXPECTED="$(printf '%s' "$EXPECTED" | tr -d '[:space:]')"
  # Anything that is not exactly 64 lowercase hex characters is not a digest - an error page that
  # arrived as a 200 must never become an expectation to compare against, and since #1190 it must
  # never quietly become "no digest published" either.
  VALID=1
  case "$EXPECTED" in
    *[!0-9a-f]*) VALID=0 ;;
  esac
  [ "${#EXPECTED}" = "64" ] || VALID=0
  if [ "$VALID" != "1" ]; then
    die "what this instance answered for $ARCH is not a sha256 digest, and checksum verification is REQUIRED. Nothing installed. Upgrade lazyit, or pass --sha256 <digest> obtained out of band."
  fi
fi

SUM_TOOL=""
if command -v sha256sum >/dev/null 2>&1; then
  SUM_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SUM_TOOL="shasum -a 256"
fi
# A host that cannot hash cannot verify, and "cannot verify" is a hard stop now - lacking a tool
# must not reopen the fail-open path the paragraph above closed.
if [ -z "$SUM_TOOL" ]; then
  die "checksum verification is required and this host has neither sha256sum nor shasum - install one (coreutils, or perl's shasum) and re-run"
fi

ACTUAL="$($SUM_TOOL "$TMP_BIN" | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch - the binary this instance served is not the one it published a digest for (expected $EXPECTED, got $ACTUAL). Nothing installed. Re-run; if it persists, treat the instance as suspect."
echo "lazyit-agent install: sha256 verified."

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
# `--keep-token` AND `--upgrade` (#1208) CHANGE NOTHING HERE, deliberately. They change where TOKEN,
# URL and CA_FILE came FROM, not who owns those keys: the old lines are still dropped from the kept
# set and written back once at the top of the file below, so a re-run cannot leave two of them and
# hand the parser the choice - and the host owner's veto crosses the upgrade exactly as it did
# before. A re-used value being written back where a passed one would go is the whole point: the file
# comes out of an upgrade in one canonical shape, whoever supplied what.
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
# `LAZYIT_CA_FILE` joins the owned set ONLY when there is a CA in play - passed with --ca-file, or
# re-used off this host by --upgrade. Either way it means "this is the CA now", so keeping the old
# line as well would write the key twice and leave which one wins to the parser; with no CA at all
# the host keeps whatever it had, like every other kept setting. The lowercase spelling is owned
# alongside it for the same reason it is kept alongside it: the agent reads it, so leaving it behind
# would make an unrelated line the winner - which for a value --upgrade just READ off that same
# lowercase line would be a loop with no exit.
#
# BOTH PATTERNS ALLOW WHITESPACE BEFORE THE `=`, and they have to move together. The agent trims the
# key before it compares, so `LAZYIT_COLLECT_SOFTWARE =false` is a live veto on that host - a keep
# pattern that missed it would DELETE the host owner's setting on the upgrade path, which is the
# erasure of #1160 in a different shape. And an owned pattern that missed `LAZYIT_TOKEN =` would let
# a stale credential through into the kept block BELOW the fresh one, where last-assignment-wins
# hands the agent the old token. Either half alone is a bug; the pair is the fix.
OWNED='LAZYIT_(URL|TOKEN|INTERVAL)[[:space:]]*='
CA_NOTE=""
if [ -n "$CA_FILE" ]; then
  OWNED='(LAZYIT_(URL|TOKEN|INTERVAL|CA_FILE)|lazyit_ca_file)[[:space:]]*='
  CA_NOTE="LAZYIT_CA_FILE=$CA_FILE"
fi

# The ADR-0095 hypervisor veto line: the commented invitation every other collector gets, or the
# ACTIVE veto when --no-hypervisor said so. Either way it is written BELOW the kept block, so on a
# re-run WITH the flag it beats whatever an older config carried - the agent reads the LAST
# assignment - while without the flag the commented form assigns nothing and a kept veto stays the
# live one. The key is deliberately NOT in OWNED above: the merge must never clobber a host owner's
# existing LAZYIT_COLLECT_HYPERVISOR=false with this template on the upgrade path.
HYPERVISOR_LINE="#LAZYIT_COLLECT_HYPERVISOR=false"
if [ "$NO_HYPERVISOR" = "1" ]; then
  HYPERVISOR_LINE="LAZYIT_COLLECT_HYPERVISOR=false"
fi

PRESERVED=""
if [ -f "$CONFIG_FILE" ]; then
  KEPT="$(grep -E '^[[:space:]]*(LAZYIT_[A-Z0-9_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|lazyit_ca_file)[[:space:]]*=' "$CONFIG_FILE" 2>/dev/null \
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
$HYPERVISOR_LINE
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
