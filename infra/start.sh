#!/bin/sh
# =============================================================================
# lazyit — start.sh  ·  guided, idempotent, NON-DESTRUCTIVE first-deploy bootstrap.
#
# For the self-hosted operator (an IT generalist who barely knows Docker). It is a THIN
# wrapper over the existing infra assets — it writes NO application logic and changes NO
# contract. It only:
#
#   DETECT  → docker + daemon, compose v2, openssl, repo root, free Caddy ports, resources,
#             and (critically) whether an install already exists.
#   ASK     → ~6 questions that cannot be detected or safely defaulted.
#   GENERATE→ infra/env/.env.prod, rendered from infra/env/.env.prod.example (ADR-0028) with
#             real random secrets (openssl), the operator's answers, atomic write, chmod 600.
#   UP      → the canonical prod bring-up (compose.yaml + the thin prod override + --profile prod).
#   POINT   → print the URL and the single CTA: open https://<host>/setup.
#
# IT STOPS AT THE WATER'S EDGE (does NOT duplicate existing assets):
#   - the in-app /setup wizard creates the first ADMIN  → the script NEVER creates a user.
#   - the zitadel-bootstrap sidecar does ALL Zitadel plumbing (ADR-0043) → the script NEVER
#     calls a Zitadel API nor generates OIDC client creds.
#
# SAFETY (the non-negotiable core):
#   - IDEMPOTENT + NON-DESTRUCTIVE. If an install is detected (infra/env/.env.prod exists OR a
#     lazyit-prod_* volume is present), generation is SKIPPED and we go straight to `up`.
#   - ZITADEL_MASTERKEY (the unrotatable DR linchpin) is NEVER regenerated and existing secrets
#     are NEVER overwritten. There is NO teardown / down -v / volume rm path anywhere here.
#
# Decisions that are PRINT-ONLY by design (the script never auto-edits compose/Caddyfile):
#   BYOI (bring-your-own-IdP), external Postgres, and TLS/HSTS for a real domain. The script
#   prints the exact manual instruction; the operator applies it.
#
# Usage:
#   ./infra/start.sh                 # interactive guided bootstrap (recommended)
#   ./infra/start.sh --reconfigure   # re-run the host/ports/mode questions on an EXISTING install
#                                    #   and re-render .env.prod, PRESERVING every secret. The
#                                    #   supported "my LAN IP changed / switch network mode" path.
#   ./infra/start.sh --yes           # non-interactive localhost defaults (smoke test)
#   ./infra/start.sh --dry-run       # do everything EXCEPT write the file and run docker
#   ./infra/start.sh --help
#
# NETWORK / TLS MODE (chosen at Q1, ADR-0087). Three modes, orthogonal to AUTH_MODE:
#   lan   — plain HTTP, HOST-AGNOSTIC (LAZYIT_SITE_ADDRESS=:80 → Caddy serves any Host on the
#           published port, no TLS). Survives a DHCP IP change. REQUIRES AUTH_MODE=local (a
#           trusted-LAN downgrade: the session travels unencrypted — the secret vault stays E2E
#           encrypted regardless). The easy pick for a small team on a LAN.
#   local — localhost + Caddy internal-CA HTTPS on the high ports (unchanged prod-like default).
#   real  — public FQDN + optional Let's Encrypt (unchanged).
#
# Docs: docs/05-runbooks/docker-prod-like-first-boot.md · docs/05-runbooks/deploy-self-hosted.md
#       ADR-0047 (this script) · ADR-0028 (secrets) · ADR-0025 (containerization) · ADR-0043 (Zitadel).
# =============================================================================
set -eu

# ---------- constants --------------------------------------------------------
ENV_EXAMPLE="infra/env/.env.prod.example"
# ENV_FILE is overridable via LAZYIT_ENV_FILE for the leave-behind test
# (infra/test/reconfigure-preserves-secrets.sh) so it can point at a scratch file and never touch
# a real deploy's .env.prod. Defaults to the canonical path for every real invocation.
ENV_FILE="${LAZYIT_ENV_FILE:-infra/env/.env.prod}"
COMPOSE_BASE="compose.yaml"
COMPOSE_PROD="infra/docker-compose.prod.yaml"
COMPOSE_OIDC="infra/docker-compose.oidc.yaml"   # OIDC overlay (bundled Zitadel); ADR-0086
PROD_PROJECT="lazyit-prod"        # the prod compose project name (volumes are lazyit-prod_*)

# Resource floor (WARN only, never hard-fail) — the runbook minimum for a small team.
MIN_RAM_MB=4096
MIN_DISK_MB=20480

# Zitadel FirstInstance default org when ZITADEL_FIRSTINSTANCE_ORG_NAME is unset (upstream default).
# Console loginname = {ZITADEL_ADMIN_USERNAME}@{org_slug}.{ZITADEL_EXTERNALDOMAIN}.
ZITADEL_DEFAULT_ORG_SLUG=zitadel

# ---------- helpers ----------------------------------------------------------
# Full Zitadel console loginname (username@org.{external domain}) for operator messaging.
zitadel_console_login() {
  _user="${1:?}"; _extdomain="${2:?}"
  printf '%s@%s.%s' "$_user" "$ZITADEL_DEFAULT_ORG_SLUG" "$_extdomain"
}

# ---------- flags ------------------------------------------------------------
ASSUME_YES=0
DRY_RUN=0
RECONFIGURE=0                     # --reconfigure: re-render an EXISTING .env.prod, preserving secrets

# ---------- defaults the questions fill in (localhost prod-like smoke test) ---
DEPLOY_MODE="local"               # lan | local | real  (network/TLS axis, ADR-0087)
DOMAIN="localhost"                # FQDN or localhost
SITE_ADDRESS="localhost"          # Caddy site address (LAZYIT_SITE_ADDRESS); ":80" in lan mode (any-host HTTP)
WEB_ORIGIN_VAL="https://localhost:8443"  # UNSET (empty) in lan mode — the app derives origin from the request Host
WEB_ORIGIN_DISPLAY="https://localhost:8443"  # human-facing URL for the banner (lan has no fixed origin)
# AUTH_TRUST_HOST (ADR-0087): render_env_file emits it =true in lan mode (keyed off DEPLOY_MODE), unset
# otherwise. It is the contract that makes the api reflect the request Origin + the web trust the Host.
AUTH_SUBDOMAIN="auth.localhost"   # ZITADEL_EXTERNALDOMAIN
ISSUER_URL="https://auth.localhost:8443"
ZITADEL_ADMIN_USERNAME="admin"
TLS_EMAIL=""                      # set only for a real domain with Let's Encrypt
HTTP_PORT="8080"
HTTPS_PORT="8443"
IDP_MODE="local"                  # local | bundled | byoi  (ADR-0086 — local is the default)
AUTH_MODE_VAL="local"             # derived: local -> "local"; bundled/byoi -> "oidc"
BYOI_ISSUER=""
BYOI_CLIENT_ID=""
BYOI_CLIENT_SECRET=""
PG_MODE="internal"                # internal | external
EXTERNAL_DATABASE_URL=""
ENABLE_BACKUP=0

# Secrets (filled by generate_secrets); declared here so `set -u` never trips.
MASTERKEY=""
POSTGRES_PASSWORD=""
ZITADEL_DB_PASSWORD=""
MEILI_MASTER_KEY=""
AUTH_SECRET=""
WORKFLOW_SECRET_KEY=""
SMTP_SECRET_KEY=""                # instance SMTP password at-rest key (ADR-0079); own axis, never reuse another key
SESSION_SIGNING_SECRET=""         # local-mode HMAC session key (ADR-0086); generated always, written in local mode
ZITADEL_ADMIN_PASSWORD=""
DATABASE_URL_VAL=""

# =============================================================================
# Output helpers — all status goes to stderr so stdout stays clean.
# =============================================================================
info()  { printf '  %s\n'        "$*" >&2; }
step()  { printf '\n==> %s\n'    "$*" >&2; }
ok()    { printf '  [ ok ] %s\n' "$*" >&2; }
warn()  { printf '  [warn] %s\n' "$*" >&2; }
die()   { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
lazyit — start.sh · guided first-deploy bootstrap

USAGE
  ./infra/start.sh [--reconfigure] [--yes] [--dry-run] [--help]

WHAT IT DOES
  Detects your environment, asks ~6 questions, generates infra/env/.env.prod with real
  random secrets (chmod 600), and brings the prod stack up. Then it points you at the
  in-app /setup wizard to create the first ADMIN. It is idempotent and non-destructive:
  if an install already exists it skips generation and just brings the stack up.

OPTIONS
  --reconfigure                  Re-run the network-mode / host / ports questions on an EXISTING
                                 install and re-render infra/env/.env.prod, PRESERVING every secret
                                 already in the file (ZITADEL_MASTERKEY, WORKFLOW/SESSION/AUTH
                                 secrets, DB creds — read back, never regenerated) and touching NO
                                 volumes. Use it when your LAN IP changed (DHCP) or to switch
                                 network mode (e.g. localhost-HTTPS -> host-agnostic LAN HTTP).
                                 AUTH_MODE stays immutable (local<->oidc is refused, per ADR-0086).
  --yes, -y, --non-interactive   Accept localhost defaults for every question (smoke test).
  --dry-run                      Run all checks + prompts and PRINT what would happen, but
                                 do NOT write infra/env/.env.prod and do NOT run docker.
  --help, -h                     Show this help and exit.

THE ~6 QUESTIONS (interactive mode only)
  1. Network / TLS mode   — 'lan' plain-HTTP host-agnostic (trusted LAN), 'local' localhost
                            internal-CA HTTPS, or 'real' public FQDN + TLS (ADR-0087). lan implies
                            AUTH_MODE=local and prints an unencrypted-session warning.
  2. Public domain (FQDN) — real mode only (-> auth.{domain}; hosts-file note printed).
  3. TLS                  — real mode: Caddy internal CA vs Let's Encrypt (-> ACME email).
  4. Host ports for Caddy — lan/local default 8080; real offers 80/443.
  5. Authentication       — local/real: built-in accounts (DEFAULT) vs bundled Zitadel OIDC vs
                            BYOI (ADR-0086). lan forces built-in accounts.
  6. Postgres             — bundled internal db (default) vs external (prints the manual step).
     (+ a yes/no: enable the opt-in backup sidecar now.)

BOUNDARY
  This script does NOT create any user (that is the in-app /setup wizard) and does NOT call
  any Zitadel API or generate OIDC creds (that is the zitadel-bootstrap sidecar). It only
  renders the env file and invokes the existing prod compose. It never tears anything down.
EOF
}

# ---------- prompt helpers ---------------------------------------------------
# ask "<prompt>" "<default>"  -> echoes the answer (or the default in non-interactive mode).
ask() {
  _prompt=$1; _default=$2
  if [ "$ASSUME_YES" -eq 1 ]; then
    printf '%s' "$_default"; return 0
  fi
  if [ -n "$_default" ]; then
    printf '%s [%s]: ' "$_prompt" "$_default" >&2
  else
    printf '%s: ' "$_prompt" >&2
  fi
  IFS= read -r _ans || _ans=""
  [ -z "$_ans" ] && _ans=$_default
  printf '%s' "$_ans"
}

# ask_yn "<prompt>" "<y|n default>" -> returns 0 for yes, 1 for no.
ask_yn() {
  _prompt=$1; _default=$2
  if [ "$ASSUME_YES" -eq 1 ]; then
    [ "$_default" = "y" ] && return 0 || return 1
  fi
  _ans=$(ask "$_prompt (y/n)" "$_default")
  case "$_ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- input validation for operator free-text -------------------------
# Every free-text answer is written verbatim into .env.prod (KEY=value lines) and flows toward
# the docker invocation. An embedded NEWLINE would inject a rogue KEY=value line; control chars,
# `$()`, backticks and other shell metacharacters are an injection risk. We reject them at the
# prompt. POSIX-sh, minimal, no bashisms.
#
# has_ctrl_or_newline <value> -> 0 (true) if the value contains a newline/CR or any other
# control character (everything below 0x20 plus DEL). We COUNT bytes before vs after stripping
# the printable set: if the count drops, a control char (incl. \n, \r, \t) was present. Counting
# via `wc -c` inside the pipe is essential — capturing with $() would itself eat trailing newlines
# and miss a newline-only residue.
has_ctrl_or_newline() {
  _v=$1
  # Count the bytes that REMAIN after deleting the printable set. Any survivor is a control char.
  _ctrl=$(printf '%s' "$_v" | tr -d '[:print:]' | wc -c | tr -d ' ')
  [ "$_ctrl" -ne 0 ]
}

# ask_text "<prompt>" "<default>" "<validator-fn>" "<error hint>"
#   Prompts (honouring --yes), then rejects newline/control chars ALWAYS and, if a validator fn
#   is given, re-prompts until the value passes. In non-interactive mode a bad default aborts
#   (it cannot prompt). The validated answer is echoed on stdout.
ask_text() {
  _p=$1; _d=$2; _vfn=$3; _hint=$4
  while :; do
    _val=$(ask "$_p" "$_d")
    if has_ctrl_or_newline "$_val"; then
      if [ "$ASSUME_YES" -eq 1 ]; then
        die "value for '$_p' contains a newline or control character — refusing (it could inject an env line)."
      fi
      warn "that value contains a newline or control character — not allowed (it could inject an extra env line). Try again."
      continue
    fi
    if [ -n "$_vfn" ] && ! "$_vfn" "$_val"; then
      if [ "$ASSUME_YES" -eq 1 ]; then
        die "value for '$_p' is invalid: ${_hint}. Got '$_val'."
      fi
      warn "invalid: ${_hint}. Try again."
      continue
    fi
    printf '%s' "$_val"
    return 0
  done
}

# Validators — return 0 when the value is acceptable. Kept deliberately strict-but-simple.
valid_fqdn() {
  # Hostname charset only: letters, digits, dot, hyphen. Non-empty. (We allow "localhost" too.)
  _h=$1
  [ -n "$_h" ] || return 1
  case "$_h" in
    *[!A-Za-z0-9.-]*) return 1 ;;   # any char outside the hostname set -> reject
    .*|*.|-*|*-)      return 1 ;;   # no leading/trailing dot or hyphen
    *..*)             return 1 ;;   # no empty label
    *) return 0 ;;
  esac
}
valid_email() {
  # Basic shape: <local>@<domain>.<tld>, no spaces, exactly one '@', a dot in the domain.
  # An EMPTY value is allowed (the ACME email is optional — skip it intentionally).
  _e=$1
  [ -n "$_e" ] || return 0
  case "$_e" in
    *[![:graph:]]*) return 1 ;;     # only printable, no spaces
    *@*@*)          return 1 ;;     # at most one '@'
    *@*.*)          return 0 ;;     # local@domain.tld
    *)              return 1 ;;
  esac
}
valid_port() {
  # Numeric, 1..65535.
  _pn=$1
  case "$_pn" in ''|*[!0-9]*) return 1 ;; esac
  [ "$_pn" -ge 1 ] && [ "$_pn" -le 65535 ]
}
valid_issuer_url() {
  # https URL with a hostname charset host. Must start https:// (OIDC issuers are TLS).
  _u=$1
  case "$_u" in
    https://*) : ;;
    *) return 1 ;;
  esac
  _rest=${_u#https://}
  [ -n "$_rest" ] || return 1
  # host[:port][/path] — restrict the host[:port] segment to a safe charset; allow a path tail.
  _hostport=${_rest%%/*}
  case "$_hostport" in
    *[!A-Za-z0-9.:-]*) return 1 ;;
    *) return 0 ;;
  esac
}
valid_database_url() {
  # postgresql://user:pass@host:port/db?... — we only assert the scheme + an '@host' and reject
  # control chars (already handled). Password may contain symbols, so we DON'T charset-restrict it;
  # the newline/control-char gate is the security boundary here.
  _du=$1
  case "$_du" in
    postgresql://*@*|postgres://*@*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- host-port availability (Caddy only; DB/Meili/Zitadel are internal) ----
port_in_use() {
  _p=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${_p}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${_p}" -sTCP:LISTEN -P -n >/dev/null 2>&1
  else
    return 1   # no probe tool -> assume free (best-effort)
  fi
}

# check_free_port "<name>" "<port>" -> echoes a free port (prompts for an alternate if busy).
check_free_port() {
  _name=$1; _port=$2
  # Test mode (LAZYIT_SKIP_DOCKER) never binds a host port, so skip the availability probe entirely
  # (keeps the offline leave-behind test deterministic regardless of what's listening on the box).
  if [ "${LAZYIT_SKIP_DOCKER:-0}" = 1 ]; then printf '%s' "$_port"; return 0; fi
  if port_in_use "$_port"; then
    warn "host port ${_port} (Caddy ${_name}) appears to be IN USE."
    if [ "$ASSUME_YES" -eq 1 ]; then
      die "port ${_port} is busy and --yes can't prompt for an alternate. Free it or run interactively."
    fi
    _alt=$(ask "   pick an alternate ${_name} port" "$_port")
    case "$_alt" in ''|*[!0-9]*) die "alternate port must be numeric (got '$_alt')." ;; esac
    printf '%s' "$_alt"
  else
    ok "host port ${_port} (Caddy ${_name}) is free"
    printf '%s' "$_port"
  fi
}

# =============================================================================
# generate_secrets — openssl, never weak, never reused. Sets the secret globals.
# =============================================================================
generate_secrets() {
  step "Generating secrets"

  # ZITADEL_MASTERKEY must be EXACTLY 32 chars (16 hex bytes -> 32 hex chars). Assert before use.
  MASTERKEY=$(openssl rand -hex 16)
  if [ "${#MASTERKEY}" -ne 32 ]; then
    die "internal error: generated ZITADEL_MASTERKEY is ${#MASTERKEY} chars, expected exactly 32. Aborting (a wrong length is a guaranteed Zitadel first-boot failure)."
  fi
  ok "ZITADEL_MASTERKEY generated (exactly 32 chars — verified)"

  # POSTGRES_PASSWORD is substituted VERBATIM into DATABASE_URL (postgresql://lazyit:<pw>@db:5432/...),
  # so it MUST be URL-safe: a base64 '/' (or any of : @ ? #) terminates the URL authority early and
  # Prisma rejects it with "P1013: invalid port number in database URL" — failing the migrate job
  # (~40% of base64 passwords contain a '/'). hex is fully URL-safe and keeps 192 bits of entropy.
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  # ZITADEL_DB_PASSWORD is passed as a discrete Postgres field (never embedded in a URL), so base64
  # is fine here — but hex keeps the secret recipe uniform and avoids a future URL-embedding footgun.
  ZITADEL_DB_PASSWORD=$(openssl rand -hex 24)
  # Guard the invariant for whoever edits the recipe next: POSTGRES_PASSWORD goes inside DATABASE_URL,
  # so it must carry none of the URL-authority delimiters (/ : @ ? #). Fail loud rather than emit an
  # env file that only breaks later at the migrate step with an opaque Prisma P1013.
  case "$POSTGRES_PASSWORD" in
    *[/:@?\#]*) die "internal error: POSTGRES_PASSWORD contains a URL-unsafe character — it would break DATABASE_URL (Prisma P1013). Use a URL-safe generator (openssl rand -hex)." ;;
  esac
  MEILI_MASTER_KEY=$(openssl rand -base64 24)
  AUTH_SECRET=$(openssl rand -base64 33)
  ok "POSTGRES_PASSWORD / ZITADEL_DB_PASSWORD / MEILI_MASTER_KEY / AUTH_SECRET generated"

  # WORKFLOW_SECRET_KEY — AES-256-GCM master key for the Applications Workflow Engine's encrypted
  # connector-credential store (WorkflowSecret, ADR-0054). Must be EXACTLY 32 bytes -> 64 hex chars
  # (openssl rand -hex 32). The engine FAILS LOUD at boot if it is missing/wrong length, and it is the
  # THIRD unrotatable DR linchpin (alongside ZITADEL_MASTERKEY + POSTGRES_PASSWORD): a DB restore
  # without the matching key yields undecryptable connector credentials. See docs/05-runbooks/backups.md.
  WORKFLOW_SECRET_KEY=$(openssl rand -hex 32)
  if [ "${#WORKFLOW_SECRET_KEY}" -ne 64 ]; then
    die "internal error: generated WORKFLOW_SECRET_KEY is ${#WORKFLOW_SECRET_KEY} chars, expected exactly 64 (32 hex bytes). Aborting (a wrong length fails the engine's boot check)."
  fi
  ok "WORKFLOW_SECRET_KEY generated (exactly 64 hex chars — verified)"

  # SMTP_SECRET_KEY — AES-256-GCM master key for the instance SMTP PASSWORD at rest (SmtpSettings,
  # ADR-0079). Its OWN key axis, never WORKFLOW_SECRET_KEY reused ("one key per subsystem"). Must decode
  # to EXACTLY 32 bytes -> 64 hex chars (openssl rand -hex 32). Unlike WORKFLOW_SECRET_KEY it is OPTIONAL
  # at boot (the API starts fine without it and outbound email is simply unavailable) — but a guided
  # install that omits it 409s the FIRST time an admin saves an authenticated SMTP password, forcing a
  # hand-edit + api recreate. So we mint it up front. NOT a DR linchpin: losing it costs one re-typed
  # SMTP password, no data loss. See docs/05-runbooks/backups.md.
  SMTP_SECRET_KEY=$(openssl rand -hex 32)
  if [ "${#SMTP_SECRET_KEY}" -ne 64 ]; then
    die "internal error: generated SMTP_SECRET_KEY is ${#SMTP_SECRET_KEY} chars, expected exactly 64 (32 hex bytes). Aborting (a wrong length makes every SMTP password write fail with a 409)."
  fi
  ok "SMTP_SECRET_KEY generated (exactly 64 hex chars — verified)"

  # SESSION_SIGNING_SECRET — HMAC key the API signs/verifies the first-party local session token with
  # (ADR-0086 §4). Required ONLY in local mode; the boot-config refine demands >= 32 chars and fails loud
  # at boot otherwise (mirrors WORKFLOW_SECRET_KEY). openssl rand -hex 32 -> 64 hex chars. Generated in
  # EVERY mode (cheap, uniform recipe); render_env_file writes it active in local mode, commented in OIDC.
  # NOT a hard DR linchpin — rotating it only forces re-login (no data loss), unlike ZITADEL_MASTERKEY /
  # WORKFLOW_SECRET_KEY. See docs/05-runbooks/backups.md.
  SESSION_SIGNING_SECRET=$(openssl rand -hex 32)
  if [ "${#SESSION_SIGNING_SECRET}" -ne 64 ]; then
    die "internal error: generated SESSION_SIGNING_SECRET is ${#SESSION_SIGNING_SECRET} chars, expected exactly 64 (32 hex bytes). Aborting (local-mode boot asserts >= 32)."
  fi
  ok "SESSION_SIGNING_SECRET generated (exactly 64 hex chars — verified)"

  # Zitadel console admin password — random, complexity-compliant (upper+lower+digit+symbol),
  # surfaced ONCE at the end. base64 gives upper/lower/digit; append a guaranteed symbol + Aa1.
  ZITADEL_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '\n')_Aa1!"
  ok "Zitadel console admin password generated (shown once, at the end)"

  # The app DATABASE_URL must embed POSTGRES_PASSWORD identically (internal mode). For external
  # mode the operator gave us a full URL — use it verbatim.
  if [ "$PG_MODE" = "internal" ]; then
    DATABASE_URL_VAL="postgresql://lazyit:${POSTGRES_PASSWORD}@db:5432/lazyit?schema=public"
  else
    DATABASE_URL_VAL="$EXTERNAL_DATABASE_URL"
  fi
}

# =============================================================================
# render_env_file [template] — read the template, rewrite ONLY owned keys, validate, chmod 600, atomic mv.
# =============================================================================
# Reading line-by-line preserves every comment + ordering and avoids `sed` on base64 secrets
# (which contain / + =). Values are written with printf (no shell interpolation of the value).
# The template defaults to the committed example (fresh install). For --reconfigure it is the EXISTING
# .env.prod, so any operator customisation to NON-owned keys (backup cron, import size, …) is preserved
# — only the owned network/secret keys are rewritten (secrets from the globals hydrated by load_existing_env).
render_env_file() {
  _template="${1:-$ENV_EXAMPLE}"
  step "Rendering $ENV_FILE (template: $_template)"

  _tmp="${ENV_FILE}.tmp.$$"
  trap 'rm -f "$_tmp" 2>/dev/null || true' EXIT INT TERM

  # Track whether the template carried an AUTH_TRUST_HOST line; if not (a file predating ADR-0087) and we
  # need it active (lan mode), append it after the loop so lan reconfigure of an OLD file still works.
  _saw_auth_trust=0

  # Same trick for SMTP_SECRET_KEY (ADR-0079): a .env.prod written before this key was generated has no
  # line to rewrite, so append it after the loop. Fresh renders take the loop branch (the example ships it).
  _saw_smtp_key=0

  # Create the temp file with mode 600 FROM CREATION — BEFORE a single secret is written.
  # A plain `: >"$_tmp"` honours the shell umask (022 -> 644), leaving the full secret set
  # (incl. the unrotatable ZITADEL_MASTERKEY) world-readable in a world-traversable dir for
  # the whole render+validate window. The (umask 077; ...) subshell makes it 600 at birth so
  # the file is never group/world-readable for even an instant (ADR-0028).
  (umask 077; : >"$_tmp") || die "cannot create the temp env file ($_tmp)."
  # Verify the create-time mode is 600 before we trust it with secrets (defensive; a non-600
  # mode would mean umask did not apply and we must NOT proceed to write secrets).
  _tmpperm=$(stat -c '%a' "$_tmp" 2>/dev/null || stat -f '%Lp' "$_tmp" 2>/dev/null || echo "?")
  if [ "$_tmpperm" != "600" ]; then
    chmod 600 "$_tmp" 2>/dev/null || true
    _tmpperm=$(stat -c '%a' "$_tmp" 2>/dev/null || stat -f '%Lp' "$_tmp" 2>/dev/null || echo "?")
    [ "$_tmpperm" = "600" ] || die "refusing to write secrets: temp env file is mode '$_tmpperm', not 600."
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      POSTGRES_PASSWORD=*)      printf 'POSTGRES_PASSWORD=%s\n'      "$POSTGRES_PASSWORD"   >>"$_tmp" ;;
      DATABASE_URL=*)           printf 'DATABASE_URL=%s\n'           "$DATABASE_URL_VAL"    >>"$_tmp" ;;
      # WEB_ORIGIN (ADR-0087). lan mode: UNSET (commented) — WEB_ORIGIN unset + AUTH_TRUST_HOST=true is
      #     the contract that tells the api to reflect the request Origin (CORS) and the web to derive
      #     its origin from the Host, so a DHCP IP change needs no re-pin. local/real: the pinned origin.
      "# WEB_ORIGIN="*|WEB_ORIGIN=*)
        if [ "$DEPLOY_MODE" = "lan" ]; then printf '# WEB_ORIGIN=  # unset in lan mode (origin derived from the request Host; see AUTH_TRUST_HOST)\n' >>"$_tmp"
        else printf 'WEB_ORIGIN=%s\n' "$WEB_ORIGIN_VAL" >>"$_tmp"; fi ;;
      # AUTH_TRUST_HOST (ADR-0087). lan mode: "true" — api CORS reflects the request Origin and the web
      #     sets NextAuth trustHost (WEB_ORIGIN is unset). local/real: UNSET (the pinned WEB_ORIGIN is the
      #     single allowed origin). Only ever safe because api/web sit BEHIND Caddy (never exposed direct).
      "# AUTH_TRUST_HOST="*|AUTH_TRUST_HOST=*)
        _saw_auth_trust=1
        if [ "$DEPLOY_MODE" = "lan" ]; then printf 'AUTH_TRUST_HOST=true\n' >>"$_tmp"
        else printf '# AUTH_TRUST_HOST=  # unset (set to true only in lan mode — origin comes from the Host)\n' >>"$_tmp"; fi ;;
      LAZYIT_SITE_ADDRESS=*)    printf 'LAZYIT_SITE_ADDRESS=%s\n'    "$SITE_ADDRESS"        >>"$_tmp" ;;
      LAZYIT_HTTP_PORT=*)       printf 'LAZYIT_HTTP_PORT=%s\n'       "$HTTP_PORT"           >>"$_tmp" ;;
      LAZYIT_HTTPS_PORT=*)      printf 'LAZYIT_HTTPS_PORT=%s\n'      "$HTTPS_PORT"          >>"$_tmp" ;;
      MEILI_MASTER_KEY=*)       printf 'MEILI_MASTER_KEY=%s\n'       "$MEILI_MASTER_KEY"    >>"$_tmp" ;;
      LAZYIT_DOMAIN=*)          printf 'LAZYIT_DOMAIN=%s\n'          "$DOMAIN"              >>"$_tmp" ;;
      # --- Auth mode (ADR-0086). EXPLICIT-REQUIRED at boot; we ALWAYS write it. local -> "local"
      #     (built-in accounts, no IdP); bundled/byoi -> "oidc".
      AUTH_MODE=*)              printf 'AUTH_MODE=%s\n'              "$AUTH_MODE_VAL"       >>"$_tmp" ;;
      # SESSION_SIGNING_SECRET — required ONLY in local mode (boot asserts >= 32 chars). Active in local;
      #     commented (genuinely UNSET) in OIDC/BYOI where it is unused. Example ships it commented.
      "# SESSION_SIGNING_SECRET="*|SESSION_SIGNING_SECRET=*)
        if [ "$IDP_MODE" = "local" ]; then printf 'SESSION_SIGNING_SECRET=%s\n' "$SESSION_SIGNING_SECRET" >>"$_tmp"
        else printf '# SESSION_SIGNING_SECRET=  # unset (only needed when AUTH_MODE=local)\n' >>"$_tmp"; fi ;;
      # --- Bundled-Zitadel-only keys. When NO bundled Zitadel runs (BYOI or local mode), these MUST be
      #     unset/omitted (a stale bundled value here is wrong + misleading). We comment them out so the
      #     file stays self-documenting but the var is genuinely UNSET.
      ZITADEL_DB_PASSWORD=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# ZITADEL_DB_PASSWORD=  # unset (no bundled Zitadel DB)\n' >>"$_tmp"
        else printf 'ZITADEL_DB_PASSWORD=%s\n' "$ZITADEL_DB_PASSWORD" >>"$_tmp"; fi ;;
      ZITADEL_MASTERKEY=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# ZITADEL_MASTERKEY=  # unset (no bundled Zitadel)\n' >>"$_tmp"
        else printf 'ZITADEL_MASTERKEY=%s\n' "$MASTERKEY" >>"$_tmp"; fi ;;
      ZITADEL_EXTERNALDOMAIN=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# ZITADEL_EXTERNALDOMAIN=  # unset (no bundled Zitadel; your IdP advertises its own issuer)\n' >>"$_tmp"
        else printf 'ZITADEL_EXTERNALDOMAIN=%s\n' "$AUTH_SUBDOMAIN" >>"$_tmp"; fi ;;
      ZITADEL_ADMIN_PASSWORD=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# ZITADEL_ADMIN_PASSWORD=  # unset (no bundled Zitadel console)\n' >>"$_tmp"
        else printf 'ZITADEL_ADMIN_PASSWORD=%s\n' "$ZITADEL_ADMIN_PASSWORD" >>"$_tmp"; fi ;;
      # --- Internal Zitadel server-to-server URLs. Bundled: keep (containers reach zitadel:8080).
      #     BYOI/local: the bundled container is absent, so the example's http://zitadel:8080 default is
      #     stale; comment it out (BYOI falls back to the external issuer; local has no OIDC at all).
      OIDC_JWKS_URI=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# OIDC_JWKS_URI=  # unset (no internal zitadel:8080; BYOI derives it from your issuer)\n' >>"$_tmp"
        else printf '%s\n' "$line" >>"$_tmp"; fi ;;
      AUTH_INTERNAL_ISSUER=*)
        if [ "$IDP_MODE" != "bundled" ]; then printf '# AUTH_INTERNAL_ISSUER=  # unset (no internal zitadel:8080; BYOI uses the external issuer)\n' >>"$_tmp"
        else printf '%s\n' "$line" >>"$_tmp"; fi ;;
      # --- External OIDC issuer + its AUTH mirror. Written for OIDC (bundled/BYOI); commented in local
      #     mode (AUTH_MODE=local has no IdP — an active issuer here would be misleading/unused).
      OIDC_ISSUER=*)
        if [ "$IDP_MODE" = "local" ]; then printf '# OIDC_ISSUER=  # unset in local mode (AUTH_MODE=local — no OIDC IdP)\n' >>"$_tmp"
        else printf 'OIDC_ISSUER=%s\n' "$ISSUER_URL" >>"$_tmp"; fi ;;
      AUTH_ISSUER=*)
        if [ "$IDP_MODE" = "local" ]; then printf '# AUTH_ISSUER=  # unset in local mode (AUTH_MODE=local — no OIDC IdP)\n' >>"$_tmp"
        else printf 'AUTH_ISSUER=%s\n' "$ISSUER_URL" >>"$_tmp"; fi ;;
      AUTH_SECRET=*)            printf 'AUTH_SECRET=%s\n'            "$AUTH_SECRET"         >>"$_tmp" ;;
      WORKFLOW_SECRET_KEY=*)    printf 'WORKFLOW_SECRET_KEY=%s\n'    "$WORKFLOW_SECRET_KEY" >>"$_tmp" ;;
      # SMTP_SECRET_KEY (ADR-0079) — always written ACTIVE. On --reconfigure the value comes from
      #     load_existing_env, which PRESERVES an already-present key verbatim (regenerating it would
      #     orphan the SMTP password already encrypted under it) and only mints one when absent.
      "# SMTP_SECRET_KEY="*|SMTP_SECRET_KEY=*)
        _saw_smtp_key=1
        printf 'SMTP_SECRET_KEY=%s\n' "$SMTP_SECRET_KEY" >>"$_tmp" ;;
      *) printf '%s\n' "$line" >>"$_tmp" ;;
    esac
  done <"$_template"

  # Reconfigure of a file predating ADR-0087 (no AUTH_TRUST_HOST line) into lan mode: the loop couldn't
  # toggle a line that wasn't there, so append it now (lan needs it active). The example ships the line,
  # so a fresh render always takes the loop branch and never reaches here.
  if [ "$DEPLOY_MODE" = "lan" ] && [ "$_saw_auth_trust" -eq 0 ]; then
    printf 'AUTH_TRUST_HOST=true\n' >>"$_tmp"
  fi

  # Reconfigure of a file predating SMTP_SECRET_KEY (ADR-0079): the loop had no line to rewrite, so append
  # the key now. The value is whatever load_existing_env resolved — a preserved hand-added key, or a fresh
  # one when the file carried none. Never regenerated over a present value.
  if [ "$_saw_smtp_key" -eq 0 ]; then
    printf '\n# --- Instance SMTP password at-rest key (ADR-0079) — added by start.sh ---\n' >>"$_tmp"
    printf '# AES-256-GCM master key for the SMTP password stored in Settings -> Instance -> SMTP. Its OWN\n' >>"$_tmp"
    printf '# key axis. Losing it costs only a re-typed SMTP password (not a DR linchpin).\n' >>"$_tmp"
    printf 'SMTP_SECRET_KEY=%s\n' "$SMTP_SECRET_KEY" >>"$_tmp"
  fi

  # BYOI: append explicit OIDC/AUTH client overrides (explicit env always wins over the file).
  if [ "$IDP_MODE" = "byoi" ]; then
    {
      printf '\n# --- BYOI overrides (added by start.sh) — your own IdP, no bundled Zitadel ---\n'
      [ -n "$BYOI_CLIENT_ID" ]     && printf 'OIDC_CLIENT_ID=%s\n'     "$BYOI_CLIENT_ID"
      [ -n "$BYOI_CLIENT_SECRET" ] && printf 'OIDC_CLIENT_SECRET=%s\n' "$BYOI_CLIENT_SECRET"
      [ -n "$BYOI_CLIENT_ID" ]     && printf 'AUTH_CLIENT_ID=%s\n'     "$BYOI_CLIENT_ID"
      [ -n "$BYOI_CLIENT_SECRET" ] && printf 'AUTH_CLIENT_SECRET=%s\n' "$BYOI_CLIENT_SECRET"
    } >>"$_tmp"
  fi

  # ---------- validate the rendered file BEFORE it goes live ----------
  # No CHANGE_ME on an ACTIVE line (commented BYOI placeholder examples on '#' lines are fine).
  if grep -v '^[[:space:]]*#' "$_tmp" | grep -q 'CHANGE_ME'; then
    die "render failed: a CHANGE_ME placeholder survived on an active line. Aborting (the env file would be invalid)."
  fi
  # AUTH_MODE must be present + match the chosen mode (ADR-0086 — it is explicit-required at boot).
  _am=$(grep -E '^AUTH_MODE=' "$_tmp" | head -n1 | cut -d= -f2-)
  [ "$_am" = "$AUTH_MODE_VAL" ] || die "render check failed: AUTH_MODE in the file is '$_am', expected '$AUTH_MODE_VAL'."
  case "$_am" in local|oidc) : ;; *) die "render check failed: AUTH_MODE '$_am' is not one of local|oidc." ;; esac
  # ZITADEL_MASTERKEY length is asserted only in BUNDLED mode (BYOI/local leave it intentionally unset).
  if [ "$IDP_MODE" = "bundled" ]; then
    _rk=$(grep -E '^ZITADEL_MASTERKEY=' "$_tmp" | head -n1 | cut -d= -f2-)
    [ "${#_rk}" -eq 32 ] || die "render check failed: ZITADEL_MASTERKEY in the file is ${#_rk} chars, not 32."
  else
    # No-bundled-Zitadel guard (BYOI + local): the bundled-Zitadel keys must NOT survive as active lines.
    if grep -E '^(ZITADEL_EXTERNALDOMAIN|ZITADEL_MASTERKEY|ZITADEL_DB_PASSWORD|ZITADEL_ADMIN_PASSWORD)=' "$_tmp" >/dev/null 2>&1; then
      die "render check failed ($IDP_MODE): a bundled-Zitadel key is still active — it must be unset without the bundled IdP."
    fi
    if grep -E '^(OIDC_JWKS_URI|AUTH_INTERNAL_ISSUER)=.*zitadel:8080' "$_tmp" >/dev/null 2>&1; then
      die "render check failed ($IDP_MODE): an internal zitadel:8080 URL survived — it must be unset without the bundled IdP."
    fi
  fi
  # Local mode: SESSION_SIGNING_SECRET must be an ACTIVE line >= 32 chars, and NO OIDC issuer may survive.
  # OIDC modes (bundled/byoi): SESSION_SIGNING_SECRET must NOT be active (it is unused there).
  if [ "$IDP_MODE" = "local" ]; then
    _ss=$(grep -E '^SESSION_SIGNING_SECRET=' "$_tmp" | head -n1 | cut -d= -f2-)
    [ "${#_ss}" -ge 32 ] || die "render check failed: SESSION_SIGNING_SECRET in the file is ${#_ss} chars, must be >= 32 in local mode."
    if grep -E '^(OIDC_ISSUER|AUTH_ISSUER)=' "$_tmp" >/dev/null 2>&1; then
      die "render check failed (local): an OIDC/AUTH issuer is still active — it must be unset in local mode (AUTH_MODE=local)."
    fi
  else
    if grep -E '^SESSION_SIGNING_SECRET=' "$_tmp" >/dev/null 2>&1; then
      die "render check failed ($IDP_MODE): SESSION_SIGNING_SECRET is active — it is only used in local mode and must be unset here."
    fi
  fi
  # Network/TLS mode contract (ADR-0087). lan: LAZYIT_SITE_ADDRESS is PORT-ONLY (:80 → any-host HTTP),
  # AUTH_TRUST_HOST=true is active, WEB_ORIGIN is NOT active, and AUTH_MODE must be local (Zitadel bakes
  # a fixed externalDomain → cannot be host-agnostic). local/real: WEB_ORIGIN active, AUTH_TRUST_HOST unset.
  _sa=$(grep -E '^LAZYIT_SITE_ADDRESS=' "$_tmp" | head -n1 | cut -d= -f2-)
  if [ "$DEPLOY_MODE" = "lan" ]; then
    case "$_sa" in
      :[0-9]*) : ;;   # port-only site address (":80", ":8080", …) → host-agnostic plain HTTP, no TLS
      *) die "render check failed (lan): LAZYIT_SITE_ADDRESS='$_sa' is not a port-only ':<port>' value — lan mode needs a port-only Caddy site address for host-agnostic HTTP." ;;
    esac
    [ "$_am" = "local" ] || die "render check failed (lan): AUTH_MODE is '$_am', but lan mode REQUIRES local auth (Zitadel/OIDC bakes a fixed externalDomain and cannot be host-agnostic)."
    grep -qE '^AUTH_TRUST_HOST=true$' "$_tmp" || die "render check failed (lan): AUTH_TRUST_HOST must be an active 'true' line (the api/web derive the origin from the request Host)."
    if grep -qE '^WEB_ORIGIN=' "$_tmp"; then die "render check failed (lan): WEB_ORIGIN is active — it must be UNSET in lan mode (the origin is derived from the Host)."; fi
  else
    if grep -qE '^AUTH_TRUST_HOST=' "$_tmp"; then die "render check failed ($DEPLOY_MODE): AUTH_TRUST_HOST is active — it must be UNSET outside lan mode (WEB_ORIGIN is the single allowed origin)."; fi
    grep -qE '^WEB_ORIGIN=' "$_tmp" || die "render check failed ($DEPLOY_MODE): WEB_ORIGIN must be an active line (the pinned public origin)."
  fi
  _hp=$(grep -E '^LAZYIT_HTTP_PORT='  "$_tmp" | head -n1 | cut -d= -f2-)
  _sp=$(grep -E '^LAZYIT_HTTPS_PORT=' "$_tmp" | head -n1 | cut -d= -f2-)
  case "$_hp" in ''|*[!0-9]*) die "render check failed: LAZYIT_HTTP_PORT is not numeric ('$_hp')." ;; esac
  case "$_sp" in ''|*[!0-9]*) die "render check failed: LAZYIT_HTTPS_PORT is not numeric ('$_sp')." ;; esac
  # WORKFLOW_SECRET_KEY must be 64 hex chars (32 bytes) — a wrong length fails the engine's boot check.
  _wsk=$(grep -E '^WORKFLOW_SECRET_KEY=' "$_tmp" | head -n1 | cut -d= -f2-)
  [ "${#_wsk}" -eq 64 ] || die "render check failed: WORKFLOW_SECRET_KEY in the file is ${#_wsk} chars, not 64 (32 hex bytes)."
  # SMTP_SECRET_KEY must be an ACTIVE line — an absent key 409s the first authenticated SMTP password save.
  # On a FRESH render it is ours (openssl rand -hex 32) so we assert the exact 64 chars. On --reconfigure it
  # may be an operator's hand-added key, and the API accepts three encodings (64 hex, base64 of 32 bytes, or
  # a 32-char raw string) — asserting 64 there would refuse to reconfigure a perfectly working install, so
  # we only require it to be present and let the API do the decode-length check at write time.
  _ssk=$(grep -E '^SMTP_SECRET_KEY=' "$_tmp" | head -n1 | cut -d= -f2-)
  if [ "$RECONFIGURE" -eq 1 ]; then
    [ -n "$_ssk" ] || die "render check failed: SMTP_SECRET_KEY is missing/empty in the rendered file."
  else
    [ "${#_ssk}" -eq 64 ] || die "render check failed: SMTP_SECRET_KEY in the file is ${#_ssk} chars, not 64 (32 hex bytes)."
  fi
  if [ "$PG_MODE" = "internal" ]; then
    _du=$(grep -E '^DATABASE_URL=' "$_tmp" | head -n1 | cut -d= -f2-)
    case "$_du" in
      *":${POSTGRES_PASSWORD}@db:5432/"*) : ;;
      *) die "render check failed: DATABASE_URL password does not match POSTGRES_PASSWORD." ;;
    esac
  fi
  ok "rendered file validated (no stray CHANGE_ME, MASTERKEY=32, WORKFLOW_SECRET_KEY=64, SMTP_SECRET_KEY present, ports numeric, DB password matches)"

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY RUN: NOT writing $ENV_FILE and NOT running docker."
    info "Rendered file would carry these non-secret keys (secrets are masked):"
    grep -E '^(AUTH_MODE|AUTH_TRUST_HOST|WEB_ORIGIN|LAZYIT_SITE_ADDRESS|LAZYIT_DOMAIN|LAZYIT_HTTP_PORT|LAZYIT_HTTPS_PORT|ZITADEL_EXTERNALDOMAIN|OIDC_ISSUER|AUTH_ISSUER)=' "$_tmp" \
      | sed 's/^/    /' >&2 || true
    rm -f "$_tmp" 2>/dev/null || true
    trap - EXIT INT TERM
    return 0
  fi

  # Go live: the temp is already 600 (created under umask 077); re-assert defensively, then
  # atomically move it into place. mv preserves the source mode, so .env.prod inherits 600.
  chmod 600 "$_tmp"
  mv "$_tmp" "$ENV_FILE"
  trap - EXIT INT TERM   # temp is now the real file; cancel the cleanup trap.

  _perm=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "?")
  if [ "$_perm" = "600" ]; then
    ok "$ENV_FILE written, chmod 600 verified"
  else
    warn "$ENV_FILE written but permissions are '$_perm' (expected 600). Run: chmod 600 $ENV_FILE"
  fi
}

# =============================================================================
# _read_env KEY — echo the value of an ACTIVE (uncommented) KEY= line in $ENV_FILE (empty if absent).
# Same read pattern the idempotency probe already uses; kept as a helper for load_existing_env.
# =============================================================================
_read_env() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# =============================================================================
# load_existing_env — for --reconfigure. Read the CURRENT .env.prod and hydrate the secret + topology
# globals so render_env_file re-emits them UNCHANGED. Secrets are NEVER regenerated. Only AUTH_MODE=local
# installs are reconfigurable (OIDC/Zitadel bakes a fixed externalDomain/issuer at first boot and cannot
# be re-homed safely — ADR-0086/0087). See docs/05-runbooks/deploy-self-hosted.md.
# =============================================================================
load_existing_env() {
  step "Reading existing secrets from $ENV_FILE (reconfigure — secrets are PRESERVED, never regenerated)"

  AUTH_MODE_VAL=$(_read_env AUTH_MODE)
  case "$AUTH_MODE_VAL" in
    local) : ;;
    oidc)  die "this install uses OIDC auth (AUTH_MODE=oidc). --reconfigure is supported only for local-auth installs: an OIDC deploy bakes a fixed IdP externalDomain/issuer at first boot and cannot be re-homed by re-rendering env (ADR-0086/0087). To change host/ports, edit $ENV_FILE by hand and follow docs/05-runbooks/deploy-self-hosted.md." ;;
    *)     die "cannot read a valid AUTH_MODE from $ENV_FILE (got '${AUTH_MODE_VAL:-<unset>}'). Refusing to reconfigure a file I don't understand — restore it from your off-host backup first." ;;
  esac
  IDP_MODE="local"

  # Secrets — hydrate globals VERBATIM from the file; render_env_file writes exactly these back.
  POSTGRES_PASSWORD=$(_read_env POSTGRES_PASSWORD)
  DATABASE_URL_VAL=$(_read_env DATABASE_URL)
  MEILI_MASTER_KEY=$(_read_env MEILI_MASTER_KEY)
  AUTH_SECRET=$(_read_env AUTH_SECRET)
  WORKFLOW_SECRET_KEY=$(_read_env WORKFLOW_SECRET_KEY)
  SESSION_SIGNING_SECRET=$(_read_env SESSION_SIGNING_SECRET)
  SMTP_SECRET_KEY=$(_read_env SMTP_SECRET_KEY)

  # Postgres topology from the DATABASE_URL host (internal `@db:5432` vs an external/managed URL).
  case "$DATABASE_URL_VAL" in
    *@db:5432/*) PG_MODE="internal" ;;
    *)           PG_MODE="external"; EXTERNAL_DATABASE_URL="$DATABASE_URL_VAL" ;;
  esac

  # Fail loud if a DR-critical secret is missing rather than silently blank it on re-render.
  [ -n "$WORKFLOW_SECRET_KEY" ]    || die "WORKFLOW_SECRET_KEY missing from $ENV_FILE — refusing to reconfigure (unrotatable DR linchpin; restore the file from backup first)."
  [ -n "$AUTH_SECRET" ]            || die "AUTH_SECRET missing from $ENV_FILE — refusing to reconfigure."
  [ -n "$SESSION_SIGNING_SECRET" ] || die "SESSION_SIGNING_SECRET missing from $ENV_FILE — AUTH_MODE=local needs it; refusing to reconfigure."
  [ -n "$MEILI_MASTER_KEY" ]       || die "MEILI_MASTER_KEY missing from $ENV_FILE — refusing to reconfigure."
  if [ "$PG_MODE" = "internal" ]; then
    [ -n "$POSTGRES_PASSWORD" ]    || die "POSTGRES_PASSWORD missing from $ENV_FILE — refusing to reconfigure."
  fi

  # SMTP_SECRET_KEY (ADR-0079) is the one key we may MINT here: a .env.prod rendered before it existed
  # carries none, and without it the first authenticated SMTP password save 409s. Present => PRESERVE it
  # verbatim (regenerating would orphan the SMTP password already encrypted under it — the operator would
  # have to re-enter it with no warning). Absent => nothing can be encrypted under it yet, so a fresh key
  # is free. Never validated for length here: the API accepts 64-hex, base64-of-32 and 32-char raw keys.
  if [ -n "$SMTP_SECRET_KEY" ]; then
    ok "SMTP_SECRET_KEY found in $ENV_FILE — PRESERVED verbatim (never regenerated; it decrypts the stored SMTP password)"
  else
    SMTP_SECRET_KEY=$(openssl rand -hex 32)
    if [ "${#SMTP_SECRET_KEY}" -ne 64 ]; then
      die "internal error: generated SMTP_SECRET_KEY is ${#SMTP_SECRET_KEY} chars, expected exactly 64 (32 hex bytes)."
    fi
    info "SMTP_SECRET_KEY was absent from $ENV_FILE (file predates ADR-0079 wiring) — a fresh 64-hex key was generated. Nothing was encrypted under it, so nothing is lost; an SMTP password saved earlier could never have been stored."
  fi

  ok "preserved secrets loaded (WORKFLOW_SECRET_KEY, AUTH_SECRET, SESSION_SIGNING_SECRET, MEILI_MASTER_KEY, DB creds) — none regenerated"
  info "existing topology: AUTH_MODE=local, Postgres=${PG_MODE}"
}

# =============================================================================
# bring_up — print the print-only manual steps, then run the canonical prod bring-up.
# =============================================================================
bring_up() {
  step "Bringing the stack up"

  # Print-only manual steps (the script NEVER auto-edits compose/Caddyfile — by decision).
  if [ "$IDP_MODE" = "byoi" ]; then
    info "BYOI: AUTH_MODE=oidc with your own IdP. The bundled Zitadel services are opt-in (profiles:[oidc]) and are NOT started — no --profile oidc, no manual 'profiles: [never]' edit needed. Your OIDC_* values are in $ENV_FILE."
  fi
  if [ "$IDP_MODE" = "local" ]; then
    info "local mode: AUTH_MODE=local. No Zitadel is started; the API signs sessions with SESSION_SIGNING_SECRET (in $ENV_FILE). Create the first admin at /setup."
  fi
  if [ "$PG_MODE" = "external" ]; then
    warn "External Postgres selected — DATABASE_URL points at your managed DB. Do NOT start the bundled 'db' service:"
    info "  bring services up explicitly WITHOUT 'db' (e.g. 'up -d migrate api web caddy ...'), or set 'profiles: [never]' on db in an overlay."
  fi
  if [ -n "$TLS_EMAIL" ]; then
    warn "Let's Encrypt: you gave an ACME email ($TLS_EMAIL). Uncomment 'email $TLS_EMAIL' (and, for a public domain, 'import hsts') in infra/caddy/Caddyfile to enable publicly-trusted certs (print-only — the script does not edit the Caddyfile)."
  fi

  # Version identity (ADR-0083): bake the checkout's git tag into the api/web images. compose maps
  # LAZYIT_VERSION/LAZYIT_GIT_SHA -> the APP_VERSION/GIT_SHA build args -> ENV -> GET /instance/version.
  # `git describe` reads v1.4.2 on a clean tag, the honest v1.4.2-3-gabc1234 off-tag, or a bare short
  # sha before any tag exists; a non-git dir (e.g. a tarball) falls back to dev/unknown. Read-only.
  LAZYIT_VERSION=$(git describe --tags --always 2>/dev/null || echo dev)
  LAZYIT_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  export LAZYIT_VERSION LAZYIT_GIT_SHA
  info "building version: $LAZYIT_VERSION ($LAZYIT_GIT_SHA)"

  # The canonical prod bring-up. OIDC with the BUNDLED Zitadel adds the oidc overlay + --profile oidc
  # (ADR-0086 — the zitadel* services are profiles:[oidc], and the overlay carries the api/web ->
  # zitadel-bootstrap dependency). local mode and BYOI stay on plain --profile prod: local has no IdP,
  # and BYOI reaches your own external issuer (no bundled Zitadel, no bootstrap sidecar).
  set -- docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_PROD"
  if [ "$IDP_MODE" = "bundled" ]; then
    set -- "$@" -f "$COMPOSE_OIDC" --profile prod --profile oidc
  else
    set -- "$@" --profile prod
  fi
  [ "$ENABLE_BACKUP" -eq 1 ] && set -- "$@" --profile backup
  set -- "$@" --env-file "$ENV_FILE" up -d --build

  info "running: $*"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY RUN: not executing the docker command above."
  elif [ "${LAZYIT_SKIP_BRINGUP:-0}" = 1 ]; then
    # Test-only seam (infra/test/reconfigure-preserves-secrets.sh): render + write, but do NOT invoke
    # docker. NEVER set it in a real deploy.
    warn "LAZYIT_SKIP_BRINGUP=1 — env rendered/written but NOT bringing docker up (test mode)."
  else
    "$@" || die "docker compose up failed. Inspect with the same 'docker compose ... logs' invocation (swap 'up -d --build' for 'logs')."
    if [ "$IDP_MODE" = "bundled" ]; then
      ok "stack is coming up (db -> migrate; zitadel -> zitadel-bootstrap -> api -> web -> caddy)"
    else
      ok "stack is coming up (db -> migrate -> api -> web -> caddy)"
    fi
  fi
}

# =============================================================================
# print_post_up_guidance — the final, operator-facing guidance.
# =============================================================================
print_post_up_guidance() {
  cat >&2 <<EOF

============================================================================
  lazyit is bootstrapping. A few things to know:
============================================================================

  Public URL:        $WEB_ORIGIN_DISPLAY

  NEXT STEP — create the first ADMIN in the in-app wizard:
      open  $WEB_ORIGIN_DISPLAY/setup
  (The first sign-in routes you to /setup; it creates the first ADMIN. This
   script does NOT create any user — that is the wizard's job.)
EOF

  if [ "$RECONFIGURE" -eq 1 ]; then
    cat >&2 <<EOF

  Existing browser sessions from before this reconfigure are now stale — they will
  401 and self-heal to /login on their next request. No action needed; just sign in again.
EOF
  fi

  if [ "$DEPLOY_MODE" = "lan" ]; then
    cat >&2 <<EOF

  LAN (host-agnostic HTTP) notes:
   - Plain HTTP on a trusted LAN — the login session is NOT encrypted in transit. Use only on a
     network you trust; never expose this deploy to the public internet. (The secret vault stays
     end-to-end encrypted regardless.)
   - Caddy answers for ANY host on port ${HTTP_PORT}: reach it at http://<this-host>:${HTTP_PORT}
     using this machine's LAN IP or hostname. If the IP changes (DHCP), the URL just follows —
     no reconfigure needed. To change the port or switch mode later:
         ./infra/start.sh --reconfigure
   - Auth: local built-in accounts (AUTH_MODE=local) — sign in at http://<this-host>:${HTTP_PORT}/login after /setup.
EOF
  fi

  if [ "$DEPLOY_MODE" = "local" ]; then
    cat >&2 <<EOF

  LOCAL prod-like notes:
   - Caddy uses its INTERNAL CA -> your browser warns until you trust it.
EOF
    if [ "$IDP_MODE" = "bundled" ]; then
      cat >&2 <<EOF
   - OIDC / Zitadel console URL: ${ISSUER_URL} (host port ${HTTPS_PORT}, not :443).
   - The OIDC login redirects through auth.localhost:${HTTPS_PORT}. Most resolvers map
     *.localhost to 127.0.0.1 automatically; if yours does not, add:
         echo "127.0.0.1 auth.localhost" | sudo tee -a /etc/hosts
EOF
    else
      info "   - Auth: local built-in accounts (AUTH_MODE=local) — sign in at ${WEB_ORIGIN_VAL}/login after /setup."
    fi
  fi

  if [ -n "$ZITADEL_ADMIN_PASSWORD" ] && [ "$IDP_MODE" = "bundled" ]; then
    _zitadel_login="$(zitadel_console_login "$ZITADEL_ADMIN_USERNAME" "$AUTH_SUBDOMAIN")"
    cat >&2 <<EOF

  Zitadel console admin (shown ONCE — store it in your password manager now):
      login:    ${_zitadel_login}
      password: $ZITADEL_ADMIN_PASSWORD
      console:  ${ISSUER_URL}/ui/console
  (Zitadel asks for username@domain — use the full login above, not just "${ZITADEL_ADMIN_USERNAME}".
   You normally never need this — the zitadel-bootstrap sidecar wires OIDC automatically.
   It is only for emergency IdP administration.)
EOF
  fi

  if [ "$IDP_MODE" = "bundled" ]; then
    cat >&2 <<EOF

  CRITICAL — back up infra/env/.env.prod OFF-HOST, encrypted:
   it holds the UNROTATABLE ZITADEL_MASTERKEY + WORKFLOW_SECRET_KEY (the DR linchpins)
   plus the DB password and AUTH_SECRET. Lose it and a restored backup is
   undecryptable — nobody can log in. The backup sidecar does NOT copy it.
EOF
  else
    cat >&2 <<EOF

  CRITICAL — back up infra/env/.env.prod OFF-HOST, encrypted:
   it holds the UNROTATABLE WORKFLOW_SECRET_KEY (the DR linchpin) plus the DB password,
   AUTH_SECRET and (local mode) SESSION_SIGNING_SECRET. Lose WORKFLOW_SECRET_KEY and a
   restored backup has undecryptable connector credentials. SESSION_SIGNING_SECRET is
   only rotatable-at-the-cost-of-re-login (not a data-loss linchpin). The backup sidecar
   does NOT copy this file.
EOF
  fi

  # The exact compose invocation for this deploy's mode (bundled adds the oidc overlay + profile).
  if [ "$IDP_MODE" = "bundled" ]; then
    _dc="docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD -f $COMPOSE_OIDC --profile prod --profile oidc --env-file $ENV_FILE"
  else
    _dc="docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD --profile prod --env-file $ENV_FILE"
  fi
  cat >&2 <<EOF

  Useful commands:
      DC="$_dc"
      \$DC ps                 # watch services converge (migrate exits 0)
EOF
  if [ "$IDP_MODE" = "bundled" ]; then
    cat >&2 <<EOF
      \$DC logs -f zitadel-bootstrap   # the zero-touch OIDC provisioner (must exit 0)
EOF
  fi
  cat >&2 <<EOF
      \$DC logs -f api
============================================================================
EOF
}

# =============================================================================
# ask_questions — the ~6 questions (interactive) or accept defaults (--yes).
# =============================================================================
ask_questions() {
  step "A few questions (press Enter to accept the [default])"

  # --- Q1. network / TLS mode (ADR-0087): lan | local | real ---
  # lan  = plain-HTTP host-agnostic on a trusted LAN (Caddy serves any Host, no TLS); implies local auth.
  # local = localhost + Caddy internal-CA HTTPS on high ports (unchanged prod-like default).
  # real  = public FQDN + optional Let's Encrypt (unchanged).
  # Interactive default is lan (the easy pick for a small team — CEO), but it is always an EXPLICIT
  # choice with the unencrypted-session warning shown. --yes keeps the historical localhost smoke test.
  if [ "$ASSUME_YES" -eq 1 ]; then _q1_default="local"; else _q1_default="lan"; fi
  _mode=$(ask "1) Network mode — 'lan' plain-HTTP host-agnostic (trusted LAN), 'local' localhost HTTPS, or 'real' public FQDN?" "$_q1_default")
  case "$_mode" in
    lan|LAN|Lan)           DEPLOY_MODE="lan" ;;
    real|REAL|r|R)         DEPLOY_MODE="real" ;;
    local|LOCAL|Local|l|L) DEPLOY_MODE="local" ;;
    *) warn "unrecognized choice '$_mode' — defaulting to $_q1_default."; DEPLOY_MODE="$_q1_default" ;;
  esac

  if [ "$DEPLOY_MODE" = "lan" ]; then
    # Host-agnostic plain HTTP on a trusted LAN. Caddy listens on container :80 for ANY Host (a port-only
    # site address disables auto-TLS — verified with `caddy validate`); the operator's chosen HTTP host
    # port publishes it via the EXISTING compose ${LAZYIT_HTTP_PORT}:80 mapping (ponytail: no mode-specific
    # compose port block). WEB_ORIGIN stays unset + AUTH_TRUST_HOST=true, so a DHCP IP change needs no
    # re-pin. lan REQUIRES local auth (Zitadel bakes a fixed externalDomain — see ADR-0086/0087).
    DOMAIN="localhost"
    SITE_ADDRESS=":80"
    AUTH_SUBDOMAIN="auth.localhost"
    IDP_MODE="local"; AUTH_MODE_VAL="local"
    HTTP_PORT=$(ask_text "2) HTTP host port for lazyit (plain HTTP, reachable at http://<this-host>:<port>)" "8080" \
      valid_port "a port number 1-65535")
    # ponytail: HTTPS is unused in lan mode, but the compose ${LAZYIT_HTTPS_PORT}:443 mapping still
    # publishes it (compose port lists can't be conditionally dropped). 8443 is bound-but-idle; the
    # check_free_port below keeps a busy 8443 from failing the bring-up.
    HTTPS_PORT="8443"
    warn "LAN mode: the login session travels UNENCRYPTED over your network — use ONLY on a trusted LAN, never over the public internet. The secret vault stays end-to-end encrypted regardless (ADR-0087)."
    info "lan mode: AUTH_MODE=local (built-in accounts). Caddy answers for ANY host on the published HTTP port — survives a DHCP IP change. Reconfigure later with: ./infra/start.sh --reconfigure"
  elif [ "$DEPLOY_MODE" = "local" ]; then
    # Local prod-like: everything pinned to localhost on high ports.
    DOMAIN="localhost"
    SITE_ADDRESS="localhost"
    AUTH_SUBDOMAIN="auth.localhost"
    HTTP_PORT="8080"
    HTTPS_PORT="8443"
    info "local prod-like: HTTPS via Caddy's internal CA, high ports ${HTTP_PORT}/${HTTPS_PORT}."
  else
    # --- Q2. public FQDN (validated: hostname charset only) ---
    DOMAIN=$(ask_text "2) Public domain (FQDN), e.g. lazyit.example.com" "lazyit.example.com" \
      valid_fqdn "a hostname (letters, digits, dots, hyphens; no scheme, no path)")
    [ -n "$DOMAIN" ] || die "a public domain is required for a real deployment."
    SITE_ADDRESS="$DOMAIN"
    AUTH_SUBDOMAIN="auth.${DOMAIN}"

    # --- Q3. TLS / ACME email (validated: basic email shape) ---
    if ask_yn "3) Use Let's Encrypt (real publicly-trusted HTTPS)? (n = Caddy internal CA)" "y"; then
      TLS_EMAIL=$(ask_text "   ACME contact email for Let's Encrypt" "" \
        valid_email "an email address like ops@example.com")
      [ -n "$TLS_EMAIL" ] || warn "no ACME email given — Let's Encrypt still works but you lose expiry notices."
    else
      info "keeping Caddy's internal CA (browsers will warn until the CA is trusted)."
    fi

    # --- Q4. host ports (validated: numeric, 1..65535) ---
    HTTP_PORT=$(ask_text "4) HTTP host port for Caddy" "80" valid_port "a port number 1-65535")
    HTTPS_PORT=$(ask_text "   HTTPS host port for Caddy" "443" valid_port "a port number 1-65535")
  fi

  # Ports must be numeric (re-validated again before write).
  case "$HTTP_PORT"  in ''|*[!0-9]*) die "HTTP port must be numeric (got '$HTTP_PORT')." ;; esac
  case "$HTTPS_PORT" in ''|*[!0-9]*) die "HTTPS port must be numeric (got '$HTTPS_PORT')." ;; esac

  # Host-port availability for Caddy (internal services have no host port to check).
  HTTP_PORT=$(check_free_port "HTTP" "$HTTP_PORT")
  HTTPS_PORT=$(check_free_port "HTTPS" "$HTTPS_PORT")

  # Derive the browser-facing origins from the final host + https port.
  if [ "$DEPLOY_MODE" = "lan" ]; then
    # Host-agnostic: no fixed origin. The app derives it from the request Host (AUTH_TRUST_HOST=true,
    # emitted by render_env_file for lan mode).
    WEB_ORIGIN_VAL=""
    ISSUER_URL=""                        # no OIDC in lan mode
    WEB_ORIGIN_DISPLAY="http://<this-host>:${HTTP_PORT}"   # for the post-up banner only
  elif [ "$DEPLOY_MODE" = "local" ]; then
    WEB_ORIGIN_VAL="https://localhost:${HTTPS_PORT}"
    ISSUER_URL="https://${AUTH_SUBDOMAIN}:${HTTPS_PORT}"
    WEB_ORIGIN_DISPLAY="$WEB_ORIGIN_VAL"
  else
    if [ "$HTTPS_PORT" = "443" ]; then
      WEB_ORIGIN_VAL="https://${DOMAIN}"
      ISSUER_URL="https://${AUTH_SUBDOMAIN}"
    else
      WEB_ORIGIN_VAL="https://${DOMAIN}:${HTTPS_PORT}"
      ISSUER_URL="https://${AUTH_SUBDOMAIN}:${HTTPS_PORT}"
    fi
    WEB_ORIGIN_DISPLAY="$WEB_ORIGIN_VAL"
  fi

  # --- Q5. Authentication mode (ADR-0086) — local (default) | bundled Zitadel | BYOI ---
  # SKIPPED in lan mode (forced local, set above) and under --reconfigure (auth mode is immutable per
  # ADR-0086 — preserved from the existing .env.prod). Otherwise: local is the DEFAULT (lazyit manages
  # accounts + passwords); bundled Zitadel and BYOI are the opt-ins (AUTH_MODE=oidc). Chosen ONCE.
  if [ "$DEPLOY_MODE" = "lan" ]; then
    info "lan mode: authentication is built-in accounts (AUTH_MODE=local) — no external IdP possible with host-agnostic HTTP."
  elif [ "$RECONFIGURE" -eq 1 ]; then
    info "reconfigure: keeping the existing AUTH_MODE=${AUTH_MODE_VAL} (immutable — ADR-0086)."
  else
    _auth=$(ask "5) Authentication — 'local' built-in accounts (default), 'bundled' Zitadel OIDC, or 'byoi' your own IdP?" "local")
    case "$_auth" in
      bundled|BUNDLED|Bundled)  IDP_MODE="bundled" ;;
      byoi|BYOI|Byoi)           IDP_MODE="byoi" ;;
      local|LOCAL|Local)        IDP_MODE="local" ;;
      *) warn "unrecognized choice '$_auth' — defaulting to local."; IDP_MODE="local" ;;
    esac

    if [ "$IDP_MODE" = "byoi" ]; then
      info "BYOI: enter your existing IdP's OIDC details (the bundled Zitadel services will NOT be started)."
      BYOI_ISSUER=$(ask_text "   OIDC_ISSUER (your IdP issuer URL)" "$ISSUER_URL" \
        valid_issuer_url "an https:// issuer URL (e.g. https://login.example.com)")
      # Client id/secret: opaque tokens — only the newline/control-char gate applies (no charset rule).
      BYOI_CLIENT_ID=$(ask_text "   OIDC_CLIENT_ID" "" "" "")
      BYOI_CLIENT_SECRET=$(ask_text "   OIDC_CLIENT_SECRET" "" "" "")
      ISSUER_URL="$BYOI_ISSUER"
    elif [ "$IDP_MODE" = "local" ]; then
      info "local mode: lazyit stores accounts + password hashes itself — no Zitadel, no external IdP. You create the first admin at /setup."
    else
      info "bundled Zitadel: the zitadel-bootstrap sidecar wires OIDC automatically (no console clicking)."
    fi

    # Derive AUTH_MODE for the env file (ADR-0086): local -> "local"; bundled/byoi -> "oidc".
    if [ "$IDP_MODE" = "local" ]; then AUTH_MODE_VAL="local"; else AUTH_MODE_VAL="oidc"; fi
  fi

  # --- Q6. Postgres — bundled internal vs external ---
  # SKIPPED under --reconfigure: PG_MODE + DATABASE_URL are preserved from the existing file (switching
  # the database out is a data operation, not a reconfigure).
  if [ "$RECONFIGURE" -eq 1 ]; then
    info "reconfigure: keeping the existing Postgres topology (${PG_MODE})."
  elif ask_yn "6) Use the bundled internal Postgres (recommended)? (n = external/managed Postgres)" "y"; then
    PG_MODE="internal"
  else
    PG_MODE="external"
    EXTERNAL_DATABASE_URL=$(ask_text "   external DATABASE_URL (postgresql://user:pass@host:5432/db?schema=public)" "" \
      valid_database_url "a postgresql://user:pass@host:port/db URL")
    [ -n "$EXTERNAL_DATABASE_URL" ] || die "an external DATABASE_URL is required when not using the bundled Postgres."
  fi

  # --- backup sidecar opt-in ---
  if ask_yn "Enable the automated backup sidecar now? (cron pg_dump of both DBs)" "n"; then
    ENABLE_BACKUP=1
  fi
}

# =============================================================================
# MAIN
# =============================================================================
main() {
  # ---------- argument parsing ----------
  for arg in "$@"; do
    case "$arg" in
      -y|--yes|--non-interactive) ASSUME_YES=1 ;;
      --dry-run)                  DRY_RUN=1 ;;
      --reconfigure)              RECONFIGURE=1 ;;
      -h|--help)                  usage; exit 0 ;;
      *) usage; die "unknown option: $arg" ;;
    esac
  done

  # ---------- 0. run from the repo root ----------
  # Resolve the repo root from this script's own location (infra/start.sh -> repo root is ../).
  SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
  cd "$REPO_ROOT" || die "cannot cd to the repo root ($REPO_ROOT)"

  [ -f "$COMPOSE_BASE" ] || die "not at the repo root: $COMPOSE_BASE not found (run ./infra/start.sh from a checkout)."
  [ -f "$COMPOSE_PROD" ] || die "missing $COMPOSE_PROD — is this a complete lazyit checkout?"
  [ -f "$COMPOSE_OIDC" ] || die "missing $COMPOSE_OIDC (the OIDC overlay, ADR-0086) — is this a complete lazyit checkout?"
  [ -f "$ENV_EXAMPLE" ]  || die "missing $ENV_EXAMPLE (the secret contract) — cannot render the env file."

  cat >&2 <<EOF

  lazyit — guided first-deploy bootstrap
  repo root: $REPO_ROOT
EOF
  [ "$DRY_RUN" -eq 1 ]    && warn "DRY RUN — nothing will be written and docker will NOT run."
  [ "$ASSUME_YES" -eq 1 ] && info "non-interactive: accepting localhost defaults for every question."

  # ---------- 1. DETECT prerequisites ----------
  step "Checking prerequisites"

  # LAZYIT_SKIP_DOCKER=1 bypasses the docker/openssl tool checks AND the volume probe below. Test-only
  # seam for the offline leave-behind check (infra/test/reconfigure-preserves-secrets.sh), which drives
  # --reconfigure --dry-run without a Docker daemon. NEVER set it in a real deploy.
  if [ "${LAZYIT_SKIP_DOCKER:-0}" != 1 ]; then
    command -v docker >/dev/null 2>&1 \
      || die "docker not found. Install Docker Engine + Compose v2: https://docs.docker.com/engine/install/"
    if ! docker info >/dev/null 2>&1; then
      die "the Docker daemon is not reachable. Start it (e.g. 'sudo systemctl start docker') and ensure your user can talk to it (the 'docker' group), then re-run."
    fi
    ok "docker present and the daemon is reachable"

    if ! docker compose version >/dev/null 2>&1; then
      die "Docker Compose v2 not found. This needs the 'docker compose' plugin (not legacy 'docker-compose'). See https://docs.docker.com/compose/install/"
    fi
    ok "docker compose v2 present"

    command -v openssl >/dev/null 2>&1 \
      || die "openssl not found — it generates the random secrets. Install it (e.g. 'apt-get install openssl') and re-run."
    ok "openssl present"
  else
    warn "LAZYIT_SKIP_DOCKER=1 — skipping docker/openssl checks (test mode)."
  fi

  # Resource floor — WARN only (never block a deploy on a small box).
  RAM_MB=""
  if [ -r /proc/meminfo ]; then
    _ramkb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo "")
    [ -n "$_ramkb" ] && RAM_MB=$(( _ramkb / 1024 ))
  fi
  if [ -n "$RAM_MB" ]; then
    if [ "$RAM_MB" -lt "$MIN_RAM_MB" ]; then
      warn "host RAM ~${RAM_MB} MB is below the suggested ${MIN_RAM_MB} MB (2 vCPU / 4 GB / 20 GB). The stack runs 7 containers; it may be tight."
    else
      ok "host RAM ~${RAM_MB} MB (>= ${MIN_RAM_MB} MB floor)"
    fi
  fi
  DISK_MB=$(df -Pm "$REPO_ROOT" 2>/dev/null | awk 'NR==2 {print $4}' || echo "")
  if [ -n "$DISK_MB" ]; then
    if [ "$DISK_MB" -lt "$MIN_DISK_MB" ]; then
      warn "free disk ~${DISK_MB} MB is below the suggested ${MIN_DISK_MB} MB. Images + Postgres + Zitadel + Meili need headroom."
    else
      ok "free disk ~${DISK_MB} MB (>= ${MIN_DISK_MB} MB floor)"
    fi
  fi

  # ---------- 1b. RECONFIGURE (supported "my IP changed / switch network mode" path) ----------
  # Re-run the network-mode / host / ports questions on an EXISTING install and re-render .env.prod,
  # PRESERVING every secret (read back, never regenerated) and touching NO volumes. Only local-auth
  # installs are reconfigurable (OIDC bakes a fixed externalDomain — load_existing_env refuses). ADR-0087.
  if [ "$RECONFIGURE" -eq 1 ]; then
    step "Reconfigure requested"
    [ -f "$ENV_FILE" ] || die "nothing to reconfigure: $ENV_FILE does not exist. Run ./infra/start.sh (no flag) for a first install."
    load_existing_env          # hydrates the secret + topology globals from the existing file; refuses OIDC
    ask_questions              # re-asks network mode / host / ports (auth + Postgres are preserved)
    render_env_file "$ENV_FILE"  # template = the EXISTING file → preserve non-owned keys; secrets from globals
    bring_up                   # no volume touch; just recreates api/web/caddy with the new env
    print_post_up_guidance
    exit 0
  fi

  # ---------- 2. EXISTING-INSTALL PROBE (the idempotency guard) ----------
  # An install exists if EITHER the rendered env file exists OR any prod volume is present.
  step "Checking for an existing install"

  _existing=0
  _reason=""
  if [ -f "$ENV_FILE" ]; then
    _existing=1
    _reason="$ENV_FILE already exists"
  fi
  # LAZYIT_SKIP_DOCKER (test mode) has no real docker to probe — treat volumes as absent.
  if [ "${LAZYIT_SKIP_DOCKER:-0}" = 1 ]; then _vols=""; else
    _vols=$(docker volume ls -q 2>/dev/null | grep "^${PROD_PROJECT}_" || true)
  fi
  if [ -n "$_vols" ]; then
    _existing=1
    if [ -n "$_reason" ]; then
      _reason="$_reason; prod volumes present (${PROD_PROJECT}_*)"
    else
      _reason="prod volumes present (${PROD_PROJECT}_*)"
    fi
  fi

  if [ "$_existing" -eq 1 ]; then
    ok "existing install detected: $_reason"
    warn "NON-DESTRUCTIVE: skipping secret/env generation. Existing secrets (incl. the unrotatable ZITADEL_MASTERKEY) are LEFT UNTOUCHED."
    if [ ! -f "$ENV_FILE" ]; then
      die "prod volumes exist but $ENV_FILE is MISSING. Restore the original .env.prod (it holds the unrotatable ZITADEL_MASTERKEY) from your off-host backup before bringing the stack up. The script will NOT regenerate it — a new MASTERKEY cannot decrypt the existing Zitadel data."
    fi
    # Detect the EXISTING deploy's auth mode from the env file so bring_up uses the right compose
    # invocation (ADR-0086). This is what keeps a re-run of an existing OIDC install byte-identical:
    # bundled -> add the oidc overlay + --profile oidc; BYOI/local -> plain --profile prod.
    _am=$(grep -E '^AUTH_MODE=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
    if [ "$_am" = "local" ]; then
      IDP_MODE="local"; AUTH_MODE_VAL="local"
    elif grep -qE '^ZITADEL_MASTERKEY=' "$ENV_FILE"; then
      IDP_MODE="bundled"; AUTH_MODE_VAL="oidc"     # active ZITADEL_MASTERKEY => bundled Zitadel
    else
      IDP_MODE="byoi"; AUTH_MODE_VAL="oidc"        # OIDC but no bundled Zitadel => BYOI
    fi
    if [ -z "$_am" ]; then
      warn "this $ENV_FILE predates ADR-0086 (no AUTH_MODE line). AUTH_MODE is now EXPLICIT-REQUIRED — the API refuses to boot without it. Add 'AUTH_MODE=oidc' to $ENV_FILE BEFORE upgrading (detected mode: $IDP_MODE)."
    fi
    info "existing deploy auth mode: $IDP_MODE (AUTH_MODE=${_am:-<unset>})"
    # SMTP_SECRET_KEY upgrade awareness (ADR-0079). This branch NEVER writes $ENV_FILE, so we cannot add
    # the key here — but an operator whose file predates it hits a bare 409 the first time they save an
    # authenticated SMTP password, with nothing explaining why. Say it out loud instead. (The key itself is
    # never printed — there is none to print, and none of this branch's output ever carries a secret.)
    if ! grep -qE '^SMTP_SECRET_KEY=' "$ENV_FILE"; then
      warn "this $ENV_FILE has no SMTP_SECRET_KEY (ADR-0079). Outbound email works with an UNAUTHENTICATED relay, but saving an SMTP PASSWORD in Settings -> Instance -> SMTP fails with a 409 until the key exists. Fix it either way:"
      info "    ./infra/start.sh --reconfigure     # adds the key, preserves every other secret"
      info "    # or by hand, then recreate the api container:"
      info "    printf 'SMTP_SECRET_KEY=%s\\n' \"\$(openssl rand -hex 32)\" >> $ENV_FILE"
    fi
    # We cannot recover the operator's earlier port/domain answers from the file reliably for the
    # guidance banner; read back the browser origin so the CTA is accurate.
    _wo=$(grep -E '^WEB_ORIGIN=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
    [ -n "$_wo" ] && WEB_ORIGIN_VAL="$_wo"
    WEB_ORIGIN_DISPLAY="$WEB_ORIGIN_VAL"
    # lan mode has NO WEB_ORIGIN (host-agnostic) — detect it from the port-only site address so the
    # banner shows a usable http://<this-host>:<port> instead of a stale/empty URL (ADR-0087).
    _sa=$(grep -E '^LAZYIT_SITE_ADDRESS=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
    case "$_sa" in
      :[0-9]*)
        DEPLOY_MODE="lan"
        _hp=$(grep -E '^LAZYIT_HTTP_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
        HTTP_PORT="${_hp:-8080}"
        WEB_ORIGIN_DISPLAY="http://<this-host>:${HTTP_PORT}"
        ;;
    esac
    ZITADEL_ADMIN_PASSWORD=""   # never re-surface an existing admin password
    bring_up
    print_post_up_guidance
    exit 0
  fi
  ok "no existing install — proceeding to a fresh bootstrap"

  # ---------- 3. ASK ----------
  ask_questions

  # ---------- 4. GENERATE secrets ----------
  generate_secrets

  # ---------- 5. RENDER the env file ----------
  render_env_file

  # ---------- 6. BRING UP + guidance ----------
  bring_up
  print_post_up_guidance
}

main "$@"
