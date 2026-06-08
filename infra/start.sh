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
#   ./infra/start.sh --yes           # non-interactive localhost defaults (smoke test)
#   ./infra/start.sh --dry-run       # do everything EXCEPT write the file and run docker
#   ./infra/start.sh --help
#
# Docs: docs/05-runbooks/docker-prod-like-first-boot.md · docs/05-runbooks/deploy-self-hosted.md
#       ADR-0047 (this script) · ADR-0028 (secrets) · ADR-0025 (containerization) · ADR-0043 (Zitadel).
# =============================================================================
set -eu

# ---------- constants --------------------------------------------------------
ENV_EXAMPLE="infra/env/.env.prod.example"
ENV_FILE="infra/env/.env.prod"
COMPOSE_BASE="compose.yaml"
COMPOSE_PROD="infra/docker-compose.prod.yaml"
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

# ---------- defaults the questions fill in (localhost prod-like smoke test) ---
DEPLOY_MODE="local"               # local | real
DOMAIN="localhost"                # FQDN or localhost
SITE_ADDRESS="localhost"          # Caddy site address (LAZYIT_SITE_ADDRESS)
WEB_ORIGIN_VAL="https://localhost:8443"
AUTH_SUBDOMAIN="auth.localhost"   # ZITADEL_EXTERNALDOMAIN
ISSUER_URL="https://auth.localhost:8443"
ZITADEL_ADMIN_USERNAME="admin"
TLS_EMAIL=""                      # set only for a real domain with Let's Encrypt
HTTP_PORT="8080"
HTTPS_PORT="8443"
IDP_MODE="bundled"                # bundled | byoi
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
  ./infra/start.sh [--yes] [--dry-run] [--help]

WHAT IT DOES
  Detects your environment, asks ~6 questions, generates infra/env/.env.prod with real
  random secrets (chmod 600), and brings the prod stack up. Then it points you at the
  in-app /setup wizard to create the first ADMIN. It is idempotent and non-destructive:
  if an install already exists it skips generation and just brings the stack up.

OPTIONS
  --yes, -y, --non-interactive   Accept localhost defaults for every question (smoke test).
  --dry-run                      Run all checks + prompts and PRINT what would happen, but
                                 do NOT write infra/env/.env.prod and do NOT run docker.
  --help, -h                     Show this help and exit.

THE ~6 QUESTIONS (interactive mode only)
  1. Deployment mode      — local prod-like (default) vs a real public domain.
  2. Public domain (FQDN) — default localhost (-> auth.localhost; hosts-file note printed).
  3. TLS                  — Caddy internal CA (local) vs Let's Encrypt (real domain -> ACME email).
  4. Host ports for Caddy — default 8080/8443 (80/443 offered for a real domain).
  5. IdP                  — bundled Zitadel (default) vs BYOI (prints the manual edit, no auto-edit).
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

  POSTGRES_PASSWORD=$(openssl rand -base64 24)
  ZITADEL_DB_PASSWORD=$(openssl rand -base64 24)
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
# render_env_file — read the example, rewrite ONLY owned keys, validate, chmod 600, atomic mv.
# =============================================================================
# Reading line-by-line preserves every comment + ordering and avoids `sed` on base64 secrets
# (which contain / + =). Values are written with printf (no shell interpolation of the value).
render_env_file() {
  step "Rendering $ENV_FILE"

  _tmp="${ENV_FILE}.tmp.$$"
  trap 'rm -f "$_tmp" 2>/dev/null || true' EXIT INT TERM

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
      WEB_ORIGIN=*)             printf 'WEB_ORIGIN=%s\n'             "$WEB_ORIGIN_VAL"      >>"$_tmp" ;;
      LAZYIT_SITE_ADDRESS=*)    printf 'LAZYIT_SITE_ADDRESS=%s\n'    "$SITE_ADDRESS"        >>"$_tmp" ;;
      LAZYIT_HTTP_PORT=*)       printf 'LAZYIT_HTTP_PORT=%s\n'       "$HTTP_PORT"           >>"$_tmp" ;;
      LAZYIT_HTTPS_PORT=*)      printf 'LAZYIT_HTTPS_PORT=%s\n'      "$HTTPS_PORT"          >>"$_tmp" ;;
      MEILI_MASTER_KEY=*)       printf 'MEILI_MASTER_KEY=%s\n'       "$MEILI_MASTER_KEY"    >>"$_tmp" ;;
      LAZYIT_DOMAIN=*)          printf 'LAZYIT_DOMAIN=%s\n'          "$DOMAIN"              >>"$_tmp" ;;
      # --- Bundled-Zitadel-only keys. In BYOI mode the bundled IdP services do NOT run, so these
      #     MUST be unset/omitted (a stale bundled value here is wrong + misleading). We comment
      #     them out in BYOI so the file stays self-documenting but the var is genuinely UNSET.
      ZITADEL_DB_PASSWORD=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# ZITADEL_DB_PASSWORD=  # unset in BYOI (no bundled Zitadel DB)\n' >>"$_tmp"
        else printf 'ZITADEL_DB_PASSWORD=%s\n' "$ZITADEL_DB_PASSWORD" >>"$_tmp"; fi ;;
      ZITADEL_MASTERKEY=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# ZITADEL_MASTERKEY=  # unset in BYOI (no bundled Zitadel)\n' >>"$_tmp"
        else printf 'ZITADEL_MASTERKEY=%s\n' "$MASTERKEY" >>"$_tmp"; fi ;;
      ZITADEL_EXTERNALDOMAIN=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# ZITADEL_EXTERNALDOMAIN=  # unset in BYOI (your IdP advertises its own issuer)\n' >>"$_tmp"
        else printf 'ZITADEL_EXTERNALDOMAIN=%s\n' "$AUTH_SUBDOMAIN" >>"$_tmp"; fi ;;
      ZITADEL_ADMIN_PASSWORD=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# ZITADEL_ADMIN_PASSWORD=  # unset in BYOI (no bundled Zitadel console)\n' >>"$_tmp"
        else printf 'ZITADEL_ADMIN_PASSWORD=%s\n' "$ZITADEL_ADMIN_PASSWORD" >>"$_tmp"; fi ;;
      # --- Internal Zitadel server-to-server URLs. Bundled: keep (containers reach zitadel:8080).
      #     BYOI: the bundled container is absent, so the example's http://zitadel:8080 default is
      #     stale; comment it out (the API/web fall back to the BYOI issuer for JWKS/token calls).
      OIDC_JWKS_URI=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# OIDC_JWKS_URI=  # unset in BYOI (derived from your issuer; no internal zitadel:8080)\n' >>"$_tmp"
        else printf '%s\n' "$line" >>"$_tmp"; fi ;;
      AUTH_INTERNAL_ISSUER=*)
        if [ "$IDP_MODE" = "byoi" ]; then printf '# AUTH_INTERNAL_ISSUER=  # unset in BYOI (no internal zitadel:8080; use the external issuer)\n' >>"$_tmp"
        else printf '%s\n' "$line" >>"$_tmp"; fi ;;
      OIDC_ISSUER=*)            printf 'OIDC_ISSUER=%s\n'            "$ISSUER_URL"          >>"$_tmp" ;;
      AUTH_ISSUER=*)            printf 'AUTH_ISSUER=%s\n'            "$ISSUER_URL"          >>"$_tmp" ;;
      AUTH_SECRET=*)            printf 'AUTH_SECRET=%s\n'            "$AUTH_SECRET"         >>"$_tmp" ;;
      WORKFLOW_SECRET_KEY=*)    printf 'WORKFLOW_SECRET_KEY=%s\n'    "$WORKFLOW_SECRET_KEY" >>"$_tmp" ;;
      *) printf '%s\n' "$line" >>"$_tmp" ;;
    esac
  done <"$ENV_EXAMPLE"

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
  # ZITADEL_MASTERKEY length is asserted only in BUNDLED mode (in BYOI it is intentionally unset).
  if [ "$IDP_MODE" = "bundled" ]; then
    _rk=$(grep -E '^ZITADEL_MASTERKEY=' "$_tmp" | head -n1 | cut -d= -f2-)
    [ "${#_rk}" -eq 32 ] || die "render check failed: ZITADEL_MASTERKEY in the file is ${#_rk} chars, not 32."
  else
    # BYOI consistency guard: the bundled-Zitadel internal URLs must NOT survive as active lines.
    if grep -E '^(ZITADEL_EXTERNALDOMAIN|ZITADEL_MASTERKEY|ZITADEL_DB_PASSWORD|ZITADEL_ADMIN_PASSWORD)=' "$_tmp" >/dev/null 2>&1; then
      die "render check failed (BYOI): a bundled-Zitadel key is still active — it must be unset in BYOI mode."
    fi
    if grep -E '^(OIDC_JWKS_URI|AUTH_INTERNAL_ISSUER)=.*zitadel:8080' "$_tmp" >/dev/null 2>&1; then
      die "render check failed (BYOI): an internal zitadel:8080 URL survived — it must be unset in BYOI mode."
    fi
  fi
  _hp=$(grep -E '^LAZYIT_HTTP_PORT='  "$_tmp" | head -n1 | cut -d= -f2-)
  _sp=$(grep -E '^LAZYIT_HTTPS_PORT=' "$_tmp" | head -n1 | cut -d= -f2-)
  case "$_hp" in ''|*[!0-9]*) die "render check failed: LAZYIT_HTTP_PORT is not numeric ('$_hp')." ;; esac
  case "$_sp" in ''|*[!0-9]*) die "render check failed: LAZYIT_HTTPS_PORT is not numeric ('$_sp')." ;; esac
  # WORKFLOW_SECRET_KEY must be 64 hex chars (32 bytes) — a wrong length fails the engine's boot check.
  _wsk=$(grep -E '^WORKFLOW_SECRET_KEY=' "$_tmp" | head -n1 | cut -d= -f2-)
  [ "${#_wsk}" -eq 64 ] || die "render check failed: WORKFLOW_SECRET_KEY in the file is ${#_wsk} chars, not 64 (32 hex bytes)."
  if [ "$PG_MODE" = "internal" ]; then
    _du=$(grep -E '^DATABASE_URL=' "$_tmp" | head -n1 | cut -d= -f2-)
    case "$_du" in
      *":${POSTGRES_PASSWORD}@db:5432/"*) : ;;
      *) die "render check failed: DATABASE_URL password does not match POSTGRES_PASSWORD." ;;
    esac
  fi
  ok "rendered file validated (no stray CHANGE_ME, MASTERKEY=32, WORKFLOW_SECRET_KEY=64, ports numeric, DB password matches)"

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY RUN: NOT writing $ENV_FILE and NOT running docker."
    info "Rendered file would carry these non-secret keys (secrets are masked):"
    grep -E '^(WEB_ORIGIN|LAZYIT_SITE_ADDRESS|LAZYIT_DOMAIN|LAZYIT_HTTP_PORT|LAZYIT_HTTPS_PORT|ZITADEL_EXTERNALDOMAIN|OIDC_ISSUER|AUTH_ISSUER)=' "$_tmp" \
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
# bring_up — print the print-only manual steps, then run the canonical prod bring-up.
# =============================================================================
bring_up() {
  step "Bringing the stack up"

  # Print-only manual steps (the script NEVER auto-edits compose/Caddyfile — by decision).
  if [ "$IDP_MODE" = "byoi" ]; then
    warn "BYOI selected — the script does NOT auto-edit compose. Before 'up', drop the bundled Zitadel services so they don't start:"
    info "  add a tiny override that sets 'profiles: [never]' on zitadel, zitadel_db, zitadel-secrets-init, zitadel-bootstrap"
    info "  (or remove them from your overlay). See docs/05-runbooks/deploy-self-hosted.md (BYOI). Your OIDC_* values are already in $ENV_FILE."
  fi
  if [ "$PG_MODE" = "external" ]; then
    warn "External Postgres selected — DATABASE_URL points at your managed DB. Do NOT start the bundled 'db' service:"
    info "  bring services up explicitly WITHOUT 'db' (e.g. 'up -d migrate api web caddy ...'), or set 'profiles: [never]' on db in an overlay."
  fi
  if [ -n "$TLS_EMAIL" ]; then
    warn "Let's Encrypt: you gave an ACME email ($TLS_EMAIL). Uncomment 'email $TLS_EMAIL' (and, for a public domain, 'import hsts') in infra/caddy/Caddyfile to enable publicly-trusted certs (print-only — the script does not edit the Caddyfile)."
  fi

  # The canonical prod bring-up (verbatim from the runbooks / the example header).
  set -- docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_PROD" --profile prod
  [ "$ENABLE_BACKUP" -eq 1 ] && set -- "$@" --profile backup
  set -- "$@" --env-file "$ENV_FILE" up -d --build

  info "running: $*"
  if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY RUN: not executing the docker command above."
  else
    "$@" || die "docker compose up failed. Inspect with: docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD --profile prod --env-file $ENV_FILE logs"
    ok "stack is coming up (db -> migrate; zitadel -> zitadel-bootstrap -> api -> web -> caddy)"
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

  Public URL:        $WEB_ORIGIN_VAL

  NEXT STEP — create the first ADMIN in the in-app wizard:
      open  $WEB_ORIGIN_VAL/setup
  (The first sign-in routes you to /setup; it creates the first ADMIN. This
   script does NOT create any user — that is the wizard's job.)
EOF

  if [ "$DEPLOY_MODE" = "local" ]; then
    cat >&2 <<EOF

  LOCAL prod-like notes:
   - Caddy uses its INTERNAL CA -> your browser warns until you trust it.
   - OIDC / Zitadel console URL: ${ISSUER_URL} (host port ${HTTPS_PORT}, not :443).
   - The OIDC login redirects through auth.localhost:${HTTPS_PORT}. Most resolvers map
     *.localhost to 127.0.0.1 automatically; if yours does not, add:
         echo "127.0.0.1 auth.localhost" | sudo tee -a /etc/hosts
EOF
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

  cat >&2 <<EOF

  CRITICAL — back up infra/env/.env.prod OFF-HOST, encrypted:
   it holds the UNROTATABLE ZITADEL_MASTERKEY (the disaster-recovery linchpin)
   plus the DB password and AUTH_SECRET. Lose it and a restored backup is
   undecryptable — nobody can log in. The backup sidecar does NOT copy it.

  Useful commands:
      DC="docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD --profile prod --env-file $ENV_FILE"
      \$DC ps                 # watch services converge (migrate + zitadel-bootstrap exit 0)
      \$DC logs -f zitadel-bootstrap   # the zero-touch OIDC provisioner
      \$DC logs -f api
============================================================================
EOF
}

# =============================================================================
# ask_questions — the ~6 questions (interactive) or accept defaults (--yes).
# =============================================================================
ask_questions() {
  step "A few questions (press Enter to accept the [default])"

  # --- Q1. deployment mode ---
  _mode=$(ask "1) Deployment mode — 'local' prod-like on this machine, or 'real' public domain?" "local")
  case "$_mode" in
    real|REAL|r|R) DEPLOY_MODE="real" ;;
    *)             DEPLOY_MODE="local" ;;
  esac

  if [ "$DEPLOY_MODE" = "local" ]; then
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
  if [ "$DEPLOY_MODE" = "local" ]; then
    WEB_ORIGIN_VAL="https://localhost:${HTTPS_PORT}"
    ISSUER_URL="https://${AUTH_SUBDOMAIN}:${HTTPS_PORT}"
  else
    if [ "$HTTPS_PORT" = "443" ]; then
      WEB_ORIGIN_VAL="https://${DOMAIN}"
      ISSUER_URL="https://${AUTH_SUBDOMAIN}"
    else
      WEB_ORIGIN_VAL="https://${DOMAIN}:${HTTPS_PORT}"
      ISSUER_URL="https://${AUTH_SUBDOMAIN}:${HTTPS_PORT}"
    fi
  fi

  # --- Q5. IdP — bundled Zitadel vs BYOI ---
  if ask_yn "5) Use the bundled Zitadel IdP (recommended)? (n = bring your own IdP / BYOI)" "y"; then
    IDP_MODE="bundled"
  else
    IDP_MODE="byoi"
    info "BYOI: enter your existing IdP's OIDC details."
    BYOI_ISSUER=$(ask_text "   OIDC_ISSUER (your IdP issuer URL)" "$ISSUER_URL" \
      valid_issuer_url "an https:// issuer URL (e.g. https://login.example.com)")
    # Client id/secret: opaque tokens — only the newline/control-char gate applies (no charset rule).
    BYOI_CLIENT_ID=$(ask_text "   OIDC_CLIENT_ID" "" "" "")
    BYOI_CLIENT_SECRET=$(ask_text "   OIDC_CLIENT_SECRET" "" "" "")
    ISSUER_URL="$BYOI_ISSUER"
  fi

  # --- Q6. Postgres — bundled internal vs external ---
  if ask_yn "6) Use the bundled internal Postgres (recommended)? (n = external/managed Postgres)" "y"; then
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
  [ -f "$ENV_EXAMPLE" ]  || die "missing $ENV_EXAMPLE (the secret contract) — cannot render the env file."

  cat >&2 <<EOF

  lazyit — guided first-deploy bootstrap
  repo root: $REPO_ROOT
EOF
  [ "$DRY_RUN" -eq 1 ]    && warn "DRY RUN — nothing will be written and docker will NOT run."
  [ "$ASSUME_YES" -eq 1 ] && info "non-interactive: accepting localhost defaults for every question."

  # ---------- 1. DETECT prerequisites ----------
  step "Checking prerequisites"

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

  # ---------- 2. EXISTING-INSTALL PROBE (the idempotency guard) ----------
  # An install exists if EITHER the rendered env file exists OR any prod volume is present.
  step "Checking for an existing install"

  _existing=0
  _reason=""
  if [ -f "$ENV_FILE" ]; then
    _existing=1
    _reason="$ENV_FILE already exists"
  fi
  _vols=$(docker volume ls -q 2>/dev/null | grep "^${PROD_PROJECT}_" || true)
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
    # We cannot recover the operator's earlier port/domain answers from the file reliably for the
    # guidance banner; read back the browser origin so the CTA is accurate.
    _wo=$(grep -E '^WEB_ORIGIN=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
    [ -n "$_wo" ] && WEB_ORIGIN_VAL="$_wo"
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
