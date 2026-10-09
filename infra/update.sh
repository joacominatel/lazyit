#!/bin/sh
# =============================================================================
# lazyit — update.sh  ·  guided, idempotent, NON-DESTRUCTIVE version update.
#
# Sibling of start.sh (ADR-0047) and the guided updater of ADR-0084 (issue #904). The update UNIT is a
# git checkout + rebuild (images build ON the host; there is NO registry — ADR-0027). This script is the
# ONLY thing that mutates the host; the in-app button merely ENQUEUES an UpdateRun and shows this command.
#
# THE SEQUENCE (each step is useful and safe on its own — Mailcow's update.sh pattern):
#   0. Re-exec from a temp copy  — so `git checkout <tag>` can swap update.sh mid-run without pulling the
#                                  rug from under the running process.
#   1. Single-flight lock        — two admins (or a double-click) can never race an update.
#   2. Pre-flight                — docker + daemon, compose v2, CLEAN git tree, disk headroom, stack health.
#   3. Verified pg_dump          — MANDATORY. Dump the app DB — plus zitadel_db on a bundled-Zitadel install
#                                  (the auth mode is read from .env.prod as start.sh does; local and BYOI
#                                  have no zitadel_db) — verify each is restorable (pg_restore -l), and only
#                                  then keep it. A failed/unverifiable dump ABORTS the update — there is no
#                                  override flag. Paths + sizes are printed (proof).
#   4. Tag trust + checkout      — fetch master + the tag from origin over HTTPS/SSH; apply the tag only if it
#                                  is an annotated vX.Y.Z tag on origin/master. A signature is verified when
#                                  present (a BAD one stops), never required — CI tags are unsigned (ADR-0083).
#   5. Missing-env → FAIL LOUD   — diff the target tag's .env.prod.example keys vs the live .env.prod; on a
#                                  gap, print the EXACT lines to add and STOP. Keys start.sh leaves unset for
#                                  this install's mode (Zitadel/OIDC keys, WEB_ORIGIN in lan) are not gaps.
#                                  This script NEVER writes .env.prod (a human eyeball on the DR-linchpin file
#                                  is the cheapest insurance).
#   6. Build BEFORE swap         — the slow, failure-prone step runs while the OLD stack still serves.
#   7. up -d                     — the migrate one-shot runs (forward-only), then the stack recreates (~60s blip).
#   8. Health gate               — poll /health/ready, then confirm the api's baked APP_VERSION == target.
#   9. On failure:
#        - NO migration ran      → AUTO-ROLLBACK to the previous tag (fast, lossless).
#        - a migration ran       → STOP and print the exact, CONFIRM-GATED restore commands for the labeled
#                                  dumps. NEVER a silent automated DB restore. Honest "restore point" language:
#                                  restoring loses everything written since the dump.
#
# RED LINES (ADR-0084 — non-negotiable, enforced below):
#   - NEVER writes / rotates / regenerates infra/env/.env.prod or the DR linchpins; NEVER runs `down -v`.
#   - NO update proceeds without a fresh, VERIFIED pre-update backup of every database the install runs.
#   - NO silent automated DB restore — a migrated rollback is a printed, human-run, confirm-gated action.
#   - NO docker socket is mounted anywhere; this is a HOST script the operator runs — the app never executes it.
#
# Usage:
#   ./infra/update.sh v1.5.0            # update to a specific release tag
#   ./infra/update.sh --yes v1.5.0      # skip the "proceed?" confirmation (still verifies + backs up)
#   ./infra/update.sh --help
#
# Docs: docs/03-decisions/0084-update-awareness-and-guided-update.md · docs/05-runbooks/backups.md · start.sh.
# =============================================================================
set -eu

# =============================================================================
# 0. RE-EXEC FROM A TEMP COPY — so step 4's `git checkout <tag>` can replace this very file on disk
#    without corrupting the running shell (POSIX sh may re-read the script from disk as it executes).
#    We resolve the repo root from the ORIGINAL $0 FIRST, then re-exec the copy with it in the env.
#    NOTE: the copy is of the script in the CURRENT checkout — an update always runs the updater of the
#    version you are LEAVING, never the target's. A fix to update.sh helps only from the release after it.
#    Test seam (NEVER set in a real deploy): LAZYIT_UPDATE_LIB_ONLY=1 skips the re-exec and main, so a test
#    can source this file and call its functions directly (infra/test/update-tag-trust.sh, update-mode-aware.sh).
# =============================================================================
if [ "${LAZYIT_UPDATE_REEXEC:-}" != "1" ] && [ "${LAZYIT_UPDATE_LIB_ONLY:-}" != "1" ]; then
  _orig_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  _repo_root=$(CDPATH='' cd -- "$_orig_dir/.." && pwd)
  _self_copy=$(mktemp "${TMPDIR:-/tmp}/lazyit-update.XXXXXX") || {
    printf '[ABORT] cannot create a temp copy of update.sh\n' >&2; exit 1; }
  cp "$0" "$_self_copy"
  chmod +x "$_self_copy"
  # Clean the temp copy up when the re-exec'd child exits (the child inherits this trap slot fresh).
  LAZYIT_UPDATE_REEXEC=1 LAZYIT_REPO_ROOT="$_repo_root" LAZYIT_SELF_COPY="$_self_copy" \
    exec sh "$_self_copy" "$@"
fi

# ---------- constants --------------------------------------------------------
ENV_EXAMPLE="infra/env/.env.prod.example"
ENV_FILE="infra/env/.env.prod"
COMPOSE_BASE="compose.yaml"
COMPOSE_PROD="infra/docker-compose.prod.yaml"
BACKUP_DIR="backups"
LOCK_DIR=".update.lock"          # atomic single-flight lock (mkdir is atomic)

# Health-gate polling.
HEALTH_TRIES=60                  # up to ~5 min (60 × 5s) for the new stack to become ready.
HEALTH_INTERVAL=5

# Disk headroom floor for a host-side image build (WARN below is fatal here — a build needs room).
MIN_FREE_DISK_MB=5120

# ---------- flags / positionals ----------------------------------------------
ASSUME_YES=0
TARGET_TAG=""

# ---------- state (declared so `set -u` never trips) -------------------------
RUN_ID=""
FROM_VERSION=""
PREV_REF=""
MIGRATIONS_BEFORE=""
MIGRATIONS_AFTER=""
BACKUP_APP=""
BACKUP_ZITADEL=""
BACKUP_LABEL=""
DC=""
INSTALL_MODE=""                  # local | byoi | bundled — read from the live .env.prod (install_auth_mode)
TAG_TRUST_ERROR=""               # set by verify_release_tag when it refuses a tag (the fail_hard reason)
TAG_TRUST_COMMIT=""              # set by verify_release_tag on success: the verified commit step 4 checks out

# =============================================================================
# Output helpers — all status to stderr so any captured stdout stays clean.
# =============================================================================
info()  { printf '  %s\n'        "$*" >&2; }
step()  { printf '\n==> %s\n'    "$*" >&2; }
ok()    { printf '  [ ok ] %s\n' "$*" >&2; }
warn()  { printf '  [warn] %s\n' "$*" >&2; }
die()   { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
lazyit — update.sh · guided, non-destructive version update (ADR-0084)

USAGE
  ./infra/update.sh [--yes] <tag>
  ./infra/update.sh --help

WHAT IT DOES
  Backs up the database (verified; Zitadel's too on a bundled install) BEFORE anything, checks that the
  tag is a published release (an annotated vX.Y.Z tag on origin's master, fetched over HTTPS or SSH; a
  signature, when the tag has one, must not be bad), checks out the target, checks for new required env vars (and STOPS if any are
  missing — it never edits .env.prod), builds the new images while the old stack still serves, then
  swaps and health-gates. If it fails before any migration ran it auto-rolls-back; if a migration ran
  it STOPS and prints the exact, human-run restore commands (never an automatic DB restore).

OPTIONS
  --yes, -y     Skip the interactive "proceed?" confirmation (the backup + tag checks still run).
  --help, -h    Show this help and exit.

SAFETY
  Non-destructive: never writes .env.prod, never runs `down -v`, never rm's a volume. A failed/unverifiable
  pre-update backup ABORTS the update — there is no override. See docs/05-runbooks/backups.md.
EOF
}

# ---------- cleanup / lock ----------------------------------------------------
release_lock() {
  [ -n "${LOCK_DIR:-}" ] && [ -d "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null || true
}
cleanup() {
  release_lock
  # Remove the temp self-copy from the re-exec (step 0).
  [ -n "${LAZYIT_SELF_COPY:-}" ] && rm -f "$LAZYIT_SELF_COPY" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# =============================================================================
# UpdateRun stamping (ADR-0084 §4) — the host writes state; the API only reads. BEST-EFFORT: a stamp
# failure warns but NEVER aborts the update (the row is observability, not a safety gate). SQL runs
# INSIDE the db container using ITS OWN env (POSTGRES_USER/DB), so NO secret ever touches the host and
# no password is needed (local socket, trust). TAG is strictly validated (below), so interpolation is safe.
# =============================================================================
db_psql_scalar() {
  # Reads SQL from stdin, returns a single scalar (tuples-only, unaligned, quiet). Fails silently to "".
  $DC exec -T db sh -c \
    'psql -tAqX -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null || true
}

stamp() {
  # stamp <status> [error-text]
  [ -n "$RUN_ID" ] || return 0
  _st=$1; _err=${2:-}
  if [ -n "$_err" ]; then
    _errsql=$(printf "%s" "$_err" | sed "s/'/''/g")   # escape single quotes for SQL
    printf "UPDATE update_runs SET status='%s', error='%s', \"updatedAt\"=now()%s WHERE id=%s;\n" \
      "$_st" "$_errsql" "$(terminal_suffix "$_st")" "$RUN_ID" | db_psql_scalar >/dev/null 2>&1 || \
      warn "could not stamp UpdateRun #$RUN_ID status=$_st (non-fatal)."
  else
    printf "UPDATE update_runs SET status='%s', \"updatedAt\"=now()%s WHERE id=%s;\n" \
      "$_st" "$(terminal_suffix "$_st")" "$RUN_ID" | db_psql_scalar >/dev/null 2>&1 || \
      warn "could not stamp UpdateRun #$RUN_ID status=$_st (non-fatal)."
  fi
}

# For terminal states, also set finishedAt.
terminal_suffix() {
  case "$1" in
    done|failed|rolled_back) printf ', "finishedAt"=now()' ;;
    *) printf '' ;;
  esac
}

# =============================================================================
# main
# =============================================================================
main() {
  # ---------- args ----------
  for arg in "$@"; do
    case "$arg" in
      -y|--yes) ASSUME_YES=1 ;;
      -h|--help) usage; exit 0 ;;
      -*) usage; die "unknown option: $arg" ;;
      *)
        [ -z "$TARGET_TAG" ] || die "only one target tag may be given (got '$TARGET_TAG' and '$arg')."
        TARGET_TAG=$arg ;;
    esac
  done
  [ -n "$TARGET_TAG" ] || { usage; die "a target tag is required, e.g. ./infra/update.sh v1.5.0"; }

  # Strict tag validation — a version tag ONLY (vX.Y.Z). This is the single interpolation guard for the
  # git + SQL commands below; reject anything else up front (no injection surface).
  is_release_tag_name "$TARGET_TAG" || \
    die "invalid target tag '$TARGET_TAG' — expected a release tag like v1.5.0 (a v, then three dot-separated numbers)."

  # ---------- run from the repo root (resolved before re-exec, passed via env) ----------
  cd "$LAZYIT_REPO_ROOT" || die "cannot cd to the repo root ($LAZYIT_REPO_ROOT)"
  [ -f "$COMPOSE_BASE" ] || die "not at the repo root: $COMPOSE_BASE not found."
  [ -f "$COMPOSE_PROD" ] || die "missing $COMPOSE_PROD — incomplete checkout?"
  [ -f "$ENV_FILE" ]     || die "missing $ENV_FILE — is this instance installed? Run infra/start.sh first."

  # The canonical prod compose command (verbatim from start.sh / the runbooks).
  DC="docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD --profile prod --env-file $ENV_FILE"
  INSTALL_MODE=$(install_auth_mode)

  cat >&2 <<EOF

  lazyit — guided version update
  repo root: $LAZYIT_REPO_ROOT
  target:    $TARGET_TAG
  auth mode: $INSTALL_MODE
EOF

  # ---------- 1. LOCK (single-flight) ----------
  step "Acquiring the update lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another update appears to be running (lock '$LOCK_DIR' exists). If you are SURE none is, remove it: rmdir $LOCK_DIR"
  fi
  ok "lock acquired ($LOCK_DIR)"

  # ---------- 2. PRE-FLIGHT ----------
  step "Pre-flight checks"

  command -v docker >/dev/null 2>&1 || die "docker not found."
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (start it / check the 'docker' group)."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found (need the 'docker compose' plugin)."
  command -v git >/dev/null 2>&1 || die "git not found — the update unit is a git checkout."
  ok "docker + compose v2 + git present"

  # CLEAN working tree — an update checks out a tag; local edits would be clobbered or block the checkout.
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    git status --short >&2 || true
    die "the git working tree is not clean. Commit/stash/discard local changes before updating (an update checks out a release tag)."
  fi
  ok "git working tree is clean"

  # Disk headroom for a host-side image build.
  _disk=$(df -Pm "$LAZYIT_REPO_ROOT" 2>/dev/null | awk 'NR==2 {print $4}' || echo "")
  if [ -n "$_disk" ] && [ "$_disk" -lt "$MIN_FREE_DISK_MB" ]; then
    die "free disk ~${_disk} MB is below the ${MIN_FREE_DISK_MB} MB needed to build new images. Free space and retry."
  fi
  [ -n "$_disk" ] && ok "free disk ~${_disk} MB (>= ${MIN_FREE_DISK_MB} MB)"

  # Stack must be UP (we exec into db/api). A stopped stack means "use start.sh", not update.sh.
  # `ps -q` lists container IDs only (no header row), so empty output = nothing running.
  if [ -z "$($DC ps -q 2>/dev/null)" ]; then
    die "the prod stack does not appear to be running. Bring it up first (infra/start.sh), then update."
  fi
  ok "prod stack is running"

  # The running version (baked at build, ADR-0083). `git describe` on the CURRENT checkout.
  FROM_VERSION=$(git describe --tags --always 2>/dev/null || echo dev)
  PREV_REF=$(git rev-parse HEAD 2>/dev/null || echo "")
  [ -n "$PREV_REF" ] || die "cannot resolve the current git HEAD (needed as the rollback target)."
  info "current version: $FROM_VERSION ($PREV_REF)"

  if [ "$FROM_VERSION" = "$TARGET_TAG" ]; then
    die "already on $TARGET_TAG — nothing to update."
  fi

  # ---------- confirm (skippable) ----------
  if [ "$ASSUME_YES" -ne 1 ]; then
    _what="the database"
    [ "$INSTALL_MODE" != "bundled" ] || _what="both databases (app + Zitadel)"
    printf '\n  This will back up %s, then update %s -> %s with a brief (~60s) outage.\n  Proceed? [y/N]: ' \
      "$_what" "$FROM_VERSION" "$TARGET_TAG" >&2
    IFS= read -r _ans || _ans=""
    case "$_ans" in y|Y|yes|YES) : ;; *) release_lock; die "aborted by operator (no changes made)." ;; esac
  fi

  # ---------- claim / create the UpdateRun row ----------
  # Claim the most-recent `requested` row for this target (enqueued by the in-app button); if none, create
  # one so update.sh works standalone (the manual path is the recovery floor). Best-effort.
  RUN_ID=$(printf "SELECT id FROM update_runs WHERE status='requested' AND \"toVersion\"='%s' ORDER BY id DESC LIMIT 1;\n" "$TARGET_TAG" | db_psql_scalar | head -n1 | tr -d '[:space:]')
  if [ -n "$RUN_ID" ]; then
    info "claiming enqueued UpdateRun #$RUN_ID"
    stamp "backing_up"
    printf "UPDATE update_runs SET \"startedAt\"=now() WHERE id=%s AND \"startedAt\" IS NULL;\n" "$RUN_ID" | db_psql_scalar >/dev/null 2>&1 || true
  else
    RUN_ID=$(printf "INSERT INTO update_runs (\"fromVersion\",\"toVersion\",status,\"startedAt\",\"createdAt\",\"updatedAt\") VALUES ('%s','%s','backing_up',now(),now(),now()) RETURNING id;\n" "$FROM_VERSION" "$TARGET_TAG" | db_psql_scalar | head -n1 | tr -d '[:space:]')
    if [ -n "$RUN_ID" ]; then
      info "created UpdateRun #$RUN_ID"
    else
      warn "could not record an UpdateRun row (non-fatal — the update continues; the UI just won't show live status)."
    fi
  fi

  # ---------- 3. MANDATORY VERIFIED BACKUP ----------
  step "Backing up the database(s) (mandatory, verified)"
  backup_databases

  # ---------- 4. TAG TRUST + CHECKOUT ----------
  # The trust rule (ADR-0083 §Tag trust, #1458) lives in verify_release_tag below. It checks out the exact
  # commit it verified, so nothing can move the tag between the check and the checkout.
  step "Verifying and checking out $TARGET_TAG"
  stamp "building"
  verify_release_tag "$TARGET_TAG" || fail_hard "$TAG_TRUST_ERROR"
  git checkout --quiet "$TAG_TRUST_COMMIT" || fail_hard "git checkout $TARGET_TAG ($TAG_TRUST_COMMIT) failed."
  ok "checked out $TARGET_TAG"

  # ---------- 5. MISSING-ENV DETECTION — FAIL LOUD, never write .env.prod ----------
  step "Checking for new required environment variables"
  _missing=$(missing_env_keys)
  if [ -n "$_missing" ]; then
    warn "the new version needs env var(s) NOT present in $ENV_FILE:"
    printf '%s\n' "$_missing" | while IFS= read -r _k; do
      [ -n "$_k" ] || continue
      _example_line=$(grep -E "^${_k}=" "$ENV_EXAMPLE" | head -n1 || true)
      info "  $_k        (example: ${_example_line:-$_k=...})"
    done
    cat >&2 <<EOF

  This script will NOT edit $ENV_FILE (it holds the unrotatable DR linchpins — a human must review it).
  Add the missing key(s) above to $ENV_FILE, then re-run:  ./infra/update.sh $TARGET_TAG
EOF
    # Roll the checkout back so the stack stays on the working version.
    git checkout --quiet "$PREV_REF" 2>/dev/null || true
    stamp "failed" "missing required env var(s): $(printf '%s' "$_missing" | tr '\n' ' ')"
    die "missing required env — aborted BEFORE touching the running stack. No changes were applied."
  fi
  ok "no new required env vars"

  # ---------- 6. BUILD BEFORE SWAP (old stack still serving) ----------
  step "Building new images ($TARGET_TAG) — the old stack keeps serving"
  # Bake the target version into the images (ADR-0083): git describe now reads the checked-out tag.
  LAZYIT_VERSION=$(git describe --tags --always 2>/dev/null || echo "$TARGET_TAG")
  LAZYIT_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  export LAZYIT_VERSION LAZYIT_GIT_SHA
  info "building version: $LAZYIT_VERSION ($LAZYIT_GIT_SHA)"
  if ! $DC build; then
    # A build failure leaves the RUNNING stack untouched — just restore the checkout.
    git checkout --quiet "$PREV_REF" 2>/dev/null || true
    stamp "failed" "image build failed (running stack untouched)"
    die "image build failed. The running stack was NOT changed. Fix the build and retry."
  fi
  ok "images built"

  # ---------- 7. SWAP (migrate one-shot runs, then recreate) ----------
  step "Applying the update (migrate + recreate — brief outage)"
  MIGRATIONS_BEFORE=$(count_migrations)
  stamp "migrating"
  if ! $DC up -d; then
    # CRITICAL: capture what ACTUALLY applied BEFORE classifying. The migrate one-shot runs first
    # (service_completed_successfully), so a failure here is often "migration A applied, B failed" —
    # a schema change DID happen. Measuring migrations only after a SUCCESSFUL up would leave
    # MIGRATIONS_AFTER empty on this path and wrongly take the auto-rollback branch; ADR-0084 §9
    # requires the guided-restore branch once any migration ran. count_migrations counts only
    # finished_at IS NOT NULL, so a half-failed migration correctly does NOT count.
    MIGRATIONS_AFTER=$(count_migrations)
    stamp "restarting"
    handle_failure "docker compose up failed during the swap"
    return
  fi
  stamp "restarting"
  MIGRATIONS_AFTER=$(count_migrations)

  # ---------- 8. HEALTH GATE ----------
  step "Health-gating the new version"
  stamp "verifying"
  if ! health_gate; then
    handle_failure "health gate failed: the new version did not become ready / did not report $TARGET_TAG"
    return
  fi
  ok "new version is healthy and reports $TARGET_TAG"

  stamp "done"
  print_success
  hint_legacy_meili_volume "lazyit-prod"   # print-only (#1216) — never removes a volume
}

# backup_databases — step 3: the app DB always; zitadel_db only on a bundled install, since local and BYOI
#   run no zitadel_db (compose profile oidc, ADR-0086). Any failed dump aborts via fail_backup.
backup_databases() {
  mkdir -p "$BACKUP_DIR"
  _ts=$(date +%Y%m%d-%H%M%S)
  _sha=$(printf '%s' "$PREV_REF" | cut -c1-12)
  BACKUP_LABEL="pre-update-${FROM_VERSION}-${_sha}-${_ts}"
  BACKUP_APP="$BACKUP_DIR/${BACKUP_LABEL}-app.dump"
  BACKUP_ZITADEL=""

  dump_verify "db" "$BACKUP_APP" || fail_backup "app"
  if [ "$INSTALL_MODE" = "bundled" ]; then
    BACKUP_ZITADEL="$BACKUP_DIR/${BACKUP_LABEL}-zitadel.dump"
    dump_verify "zitadel_db" "$BACKUP_ZITADEL" || fail_backup "zitadel"
  fi
  ok "backups verified:"
  info "  app     -> $BACKUP_APP ($(wc -c < "$BACKUP_APP" | tr -d ' ') bytes)"
  if [ -n "$BACKUP_ZITADEL" ]; then
    info "  zitadel -> $BACKUP_ZITADEL ($(wc -c < "$BACKUP_ZITADEL" | tr -d ' ') bytes)"
  fi
}

# =============================================================================
# dump_verify <compose-service> <host-final-path>
#   Dump a DB (custom format) from INSIDE its container to a *.partial on the host, verify it is non-empty
#   AND restorable (pg_restore -l reads the -Fc TOC — fails on truncation), then atomically promote. Mirrors
#   the backup sidecar's verify-then-promote discipline (compose.yaml). Uses the container's own
#   POSTGRES_USER/DB via local socket (trust) — NO secret and NO password ever touch the host.
# =============================================================================
dump_verify() {
  _svc=$1; _final=$2; _partial="${_final}.partial"
  rm -f "$_partial"
  if ! $DC exec -T "$_svc" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$_partial" 2>/dev/null; then
    rm -f "$_partial"; return 1
  fi
  [ -s "$_partial" ] || { rm -f "$_partial"; return 1; }
  # Verify: stream the partial back INTO a container's pg_restore -l (the host may lack pg tools).
  if ! $DC exec -T "$_svc" pg_restore -l < "$_partial" >/dev/null 2>&1; then
    rm -f "$_partial"; return 1
  fi
  mv "$_partial" "$_final"
}

fail_backup() {
  stamp "failed" "$1 pre-update backup failed or was unverifiable"
  die "$1 database backup FAILED or was unverifiable. The update is aborted (no backup, no update — there is no override). Nothing on the host was changed."
}

# A hard failure AFTER the backup but BEFORE the swap (tag/checkout problems): restore the checkout, stamp.
fail_hard() {
  git checkout --quiet "$PREV_REF" 2>/dev/null || true
  stamp "failed" "$1"
  die "$1 The checkout was restored to $FROM_VERSION; the running stack was not changed."
}

# =============================================================================
# RELEASE-TAG TRUST (ADR-0083 §Tag trust, ADR-0084 §3 step 4, issue #1458)
#
#   release.yml cuts every tag after v1.0.0 as an ANNOTATED but UNSIGNED tag (CI never holds the release
#   owner's key), so a mandatory `git verify-tag` can never pass on them. The trust anchor is instead the
#   one ADR-0083 already names: the GitHub identity that gates master. A target tag is applied only if
#     1. its name is a vX.Y.Z release tag;
#     2. every fetch URL of `origin` is an authenticated transport — HTTPS (with certificate checks on)
#        or SSH, or a local path (no network leg). Plain http:// and git:// (and unknown schemes or
#        remote helpers) are refused: over them anyone on the path could forge master AND the tag;
#     3. master and the tag are fetched from origin IN THIS RUN. The tag must exist on origin; a local
#        tag of the same name that differs from origin's stops the update (it is never overwritten);
#     4. it is an ANNOTATED tag (a tag object, as `git tag -a` makes) whose embedded name matches;
#     5. the commit it points at is an ancestor of (or equal to) the freshly fetched origin/master.
#        Only the gated dev→master promotion puts commits there.
#   A signature is verified when present and never required:
#     - SSH-signed, gpg.ssh.allowedSignersFile configured → `git verify-tag` must pass. A bad signature or
#       a signer you have not listed stops the update — you configured that list, so it is honoured.
#     - SSH-signed, no allowed-signers file (the usual host) → `git verify-tag` cannot run at all, but
#       `ssh-keygen -Y check-novalidate` still checks the signature against the tag's content: a BAD
#       signature stops the update; a valid one is accepted with the signer's identity unchecked (the
#       ancestry rule above already carries the trust). An ssh-keygen that is missing or too old to check
#       → a warning, and the tag is trusted on ancestry.
#     - OpenPGP / X.509-signed → `git verify-tag` must pass, EXCEPT when the verifier cannot run: the
#       signer's public key is not in your keyring, or gpg/gpgsm is not installed → a warning, trusted on
#       ancestry. A BAD signature, or any other verifier failure, stops the update.
#   On refusal it sets TAG_TRUST_ERROR (an actionable sentence) and returns 1 — main turns that into
#   fail_hard. On success TAG_TRUST_COMMIT is the verified commit id.
# =============================================================================

# is_release_tag_name <name> — vX.Y.Z, digits only. The character check runs first so a name with a
# newline can never slip past the line-oriented grep.
is_release_tag_name() {
  case "$1" in ''|*[!v0-9.]*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'
}

# redact_urls — hide any user:token@ credentials embedded in URLs before they reach a message or the
# UpdateRun row.
redact_urls() {
  sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'
}

# last_line <text> — the last non-empty line of a command's output, credentials redacted.
last_line() {
  _ll=$(printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' | tail -n1 | sed 's/^[[:space:]]*//; s/[[:space:]][[:space:]]*/ /g' | redact_urls)
  printf '%s' "${_ll:-no details from git}"
}

# is_secure_fetch_url <url> — 0 when fetching from <url> authenticates the server (HTTPS with certificate
# verification, SSH) or has no network leg (a local path / file://).
is_secure_fetch_url() {
  _su_lc=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$_su_lc" in
    http://*|git://*) return 1 ;;
    https://*)
      # HTTPS authenticates the server only while certificate verification is on.
      [ -z "${GIT_SSL_NO_VERIFY+set}" ] || return 1
      _su_verify=$(git config --type=bool --get-urlmatch http.sslVerify "$1" 2>/dev/null || echo true)
      [ "$_su_verify" != "false" ] || return 1
      return 0 ;;
    ssh://*|git+ssh://*|ssh+git://*|file://*) return 0 ;;
    *::*|*://*) return 1 ;;   # remote helpers (ext::, fd::) and any other scheme
    *) return 0 ;;            # scp-like [user@]host:path (SSH), or a local path
  esac
}

# refuse_tag <reason> — record why the tag is refused (the caller returns 1 right after).
refuse_tag() { TAG_TRUST_ERROR=$1; }

verify_release_tag() {
  _vt_tag=$1
  TAG_TRUST_ERROR=""
  TAG_TRUST_COMMIT=""

  if ! is_release_tag_name "$_vt_tag"; then
    refuse_tag "'$_vt_tag' is not a release tag — lazyit releases are named vX.Y.Z (ADR-0083)."
    return 1
  fi

  # --- transport: every fetch URL of origin must be authenticated (insteadOf rewrites are expanded) ---
  if ! _vt_urls=$(git remote get-url --all origin 2>/dev/null) || [ -z "$_vt_urls" ]; then
    refuse_tag "this checkout has no 'origin' remote to fetch releases from. Point it at the lazyit repository over HTTPS or SSH: git remote add origin https://github.com/joacominatel/lazyit.git"
    return 1
  fi
  _vt_bad_url=""
  while IFS= read -r _vt_u; do
    [ -n "$_vt_u" ] || continue
    is_secure_fetch_url "$_vt_u" || _vt_bad_url=$_vt_u
  done <<URLS
$_vt_urls
URLS
  if [ -n "$_vt_bad_url" ]; then
    refuse_tag "origin is fetched over an unauthenticated transport ($(printf '%s' "$_vt_bad_url" | redact_urls)) — plain http://, git://, or HTTPS with certificate checks turned off. Anyone on the network path could forge both master and the tag, so the update will not trust it. Switch origin to HTTPS or SSH, e.g.: git remote set-url origin https://github.com/joacominatel/lazyit.git"
    return 1
  fi
  _vt_origin=$(printf '%s' "$_vt_urls" | head -n1 | redact_urls)

  # --- fetch master + the tag from origin, now. origin/master is force-refreshed (a remote-tracking ref);
  #     the tag is NOT forced, so a local tag that differs from origin's fails the fetch. ---
  if ! _vt_log=$(git fetch --no-tags origin '+refs/heads/master:refs/remotes/origin/master' 2>&1); then
    refuse_tag "could not fetch master from origin ($_vt_origin): $(last_line "$_vt_log"). The release check needs origin's current master — check network access to the remote and retry."
    return 1
  fi
  if ! _vt_log=$(git fetch --no-tags origin "refs/tags/$_vt_tag:refs/tags/$_vt_tag" 2>&1); then
    refuse_tag "could not fetch tag $_vt_tag from origin ($_vt_origin): $(last_line "$_vt_log"). Either the tag does not exist on origin (check the name against the Releases page), or this checkout has a local $_vt_tag that differs from origin's — inspect it with 'git show $_vt_tag' and, if it is not the published release, delete it with 'git tag -d $_vt_tag' and retry."
    return 1
  fi

  # --- annotated, and it names itself ---
  _vt_type=$(git cat-file -t "refs/tags/$_vt_tag" 2>/dev/null || true)
  if [ "$_vt_type" != "tag" ]; then
    refuse_tag "tag $_vt_tag is a lightweight tag (it points straight at a ${_vt_type:-missing object}, not at a tag object). lazyit releases are annotated tags cut by the release workflow (ADR-0083); this one was not."
    return 1
  fi
  _vt_name=$(git cat-file tag "refs/tags/$_vt_tag" 2>/dev/null | sed -n '/^$/q; s/^tag //p')
  if [ "$_vt_name" != "$_vt_tag" ]; then
    refuse_tag "tag $_vt_tag is a tag object that names itself '$_vt_name' — it was re-labelled, not cut as $_vt_tag by the release workflow. Refusing it."
    return 1
  fi

  # --- the tagged commit is on origin/master ---
  _vt_commit=$(git rev-parse -q --verify "refs/tags/$_vt_tag^{commit}" 2>/dev/null || true)
  if [ -z "$_vt_commit" ]; then
    refuse_tag "tag $_vt_tag does not point at a commit. Refusing it."
    return 1
  fi
  _vt_master=$(git rev-parse -q --verify "refs/remotes/origin/master^{commit}" 2>/dev/null || true)
  if [ -z "$_vt_master" ]; then
    refuse_tag "origin/master could not be resolved after the fetch. Check the remote with 'git ls-remote origin master' and retry."
    return 1
  fi
  _vt_rc=0
  git merge-base --is-ancestor "$_vt_commit" "$_vt_master" 2>/dev/null || _vt_rc=$?
  if [ "$_vt_rc" -ne 0 ]; then
    _vt_hint=""
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
      _vt_hint=" This checkout is shallow, which can hide the history that links them — run 'git fetch --unshallow origin' and retry."
    fi
    if [ "$_vt_rc" -eq 1 ]; then
      refuse_tag "tag $_vt_tag points at commit $(printf '%s' "$_vt_commit" | cut -c1-12), which is not on origin/master. lazyit releases are only cut from master by the gated promotion (ADR-0083), so this tag was not published by the release process.$_vt_hint"
    else
      refuse_tag "could not check whether tag $_vt_tag is on origin/master (git merge-base exited $_vt_rc).$_vt_hint"
    fi
    return 1
  fi
  ok "tag $_vt_tag is an annotated release tag on origin/master ($(printf '%s' "$_vt_master" | cut -c1-12)), fetched from $_vt_origin"

  # --- a signature, when present, must not be bad ---
  verify_tag_signature "$_vt_tag" || return 1

  TAG_TRUST_COMMIT=$_vt_commit
  return 0
}

# tag_signature_kind <tag> — ssh | openpgp | x509 | none, from the LAST signature header in the tag object
# (the one git itself verifies).
tag_signature_kind() {
  git cat-file tag "refs/tags/$1" 2>/dev/null | awk '
    index($0, "-----BEGIN SSH SIGNATURE-----") == 1  { k = "ssh" }
    index($0, "-----BEGIN PGP SIGNATURE-----") == 1  { k = "openpgp" }
    index($0, "-----BEGIN SIGNED MESSAGE-----") == 1 { k = "x509" }
    END { print (k == "" ? "none" : k) }'
}

verify_tag_signature() {
  _vs_tag=$1
  _vs_kind=$(tag_signature_kind "$_vs_tag")
  case "$_vs_kind" in
    none)
      info "tag $_vs_tag is unsigned — as release-workflow tags are by design (ADR-0083); trusted via origin/master."
      return 0 ;;
    ssh)
      verify_ssh_tag_signature "$_vs_tag" || return 1
      return 0 ;;
    *)
      verify_gpg_tag_signature "$_vs_tag" "$_vs_kind" || return 1
      return 0 ;;
  esac
}

verify_ssh_tag_signature() {
  _ss_tag=$1
  _ss_signers=$(git config --path --get gpg.ssh.allowedSignersFile 2>/dev/null || true)
  if [ -n "$_ss_signers" ] && [ -f "$_ss_signers" ]; then
    if git verify-tag "$_ss_tag" >/dev/null 2>&1; then
      ok "tag $_ss_tag: SSH signature verified against your allowed signers ($_ss_signers)"
      return 0
    fi
    refuse_tag "tag $_ss_tag carries an SSH signature that does NOT verify against your allowed signers file ($_ss_signers): the signature is bad, or its signer is not listed there. Run 'git verify-tag $_ss_tag' to see which. Add the signer's key to that file only if you trust it; otherwise do not apply this tag."
    return 1
  fi
  if [ -n "$_ss_signers" ]; then
    warn "gpg.ssh.allowedSignersFile is set to '$_ss_signers', but that file does not exist — the signer's identity cannot be checked."
  fi

  # No allowed-signers file: git cannot verify at all, but ssh-keygen can still prove the signature matches
  # the tag's content (it just cannot say WHO signed).
  if ! command -v ssh-keygen >/dev/null 2>&1; then
    warn "tag $_ss_tag is SSH-signed, but ssh-keygen is not installed, so the signature was not checked — trusting the tag via origin/master."
    return 0
  fi
  _ss_dir=$(mktemp -d "${TMPDIR:-/tmp}/lazyit-tagsig.XXXXXX") || {
    refuse_tag "cannot create a temporary directory to check the SSH signature on $_ss_tag."
    return 1
  }
  # Split the tag object exactly as git does: the signed payload is every line before the signature.
  git cat-file tag "refs/tags/$_ss_tag" > "$_ss_dir/raw" 2>/dev/null || true
  _ss_at=$(awk 'index($0, "-----BEGIN SSH SIGNATURE-----") == 1 { n = NR } END { print n + 0 }' "$_ss_dir/raw")
  awk -v n="$_ss_at" 'NR < n'  "$_ss_dir/raw" > "$_ss_dir/payload"
  awk -v n="$_ss_at" 'NR >= n' "$_ss_dir/raw" > "$_ss_dir/sig"
  _ss_rc=0
  _ss_out=$(ssh-keygen -Y check-novalidate -n git -s "$_ss_dir/sig" < "$_ss_dir/payload" 2>&1) || _ss_rc=$?
  rm -rf "$_ss_dir"
  if [ "$_ss_rc" -eq 0 ]; then
    info "tag $_ss_tag: the SSH signature is valid for the tag's content; its signer was not checked (no gpg.ssh.allowedSignersFile configured) — trusted via origin/master."
    return 0
  fi
  case "$_ss_out" in
    *"Could not verify signature"*|*"Couldn't verify signature"*) : ;;   # the signature itself is bad
    *"Unsupported operation"*|*"unknown option"*|*"illegal option"*|*"usage:"*)
      warn "tag $_ss_tag is SSH-signed, but this ssh-keygen is too old to check signatures (OpenSSH 8.2+ needed) — trusting the tag via origin/master."
      return 0 ;;
  esac
  refuse_tag "tag $_ss_tag carries a BAD SSH signature: it does not match the tag's content ($(last_line "$_ss_out")). The tag was altered after it was signed, or the signature is corrupt. Do not apply it; report it to the lazyit maintainers."
  return 1
}

verify_gpg_tag_signature() {
  _gs_tag=$1
  case "$2" in x509) _gs_kind="X.509" ;; *) _gs_kind="OpenPGP" ;; esac
  if _gs_out=$(git verify-tag --raw "$_gs_tag" 2>&1); then
    ok "tag $_gs_tag: $_gs_kind signature verified"
    return 0
  fi
  case "$_gs_out" in
    *"[GNUPG:] BADSIG"*) : ;;   # a genuinely bad signature — refused below
    *"[GNUPG:] NO_PUBKEY"*)
      warn "tag $_gs_tag is $_gs_kind-signed, but the signer's public key is not in your keyring, so the signature could not be checked — trusting the tag via origin/master. To check it, import the key and run: git verify-tag $_gs_tag"
      return 0 ;;
    *"[GNUPG:]"*) : ;;          # the verifier ran and did not accept it — refused below
    *)
      if [ "$2" = "x509" ]; then
        _gs_prog=$(git config --get gpg.x509.program 2>/dev/null || echo gpgsm)
      else
        _gs_prog=$(git config --get gpg.openpgp.program 2>/dev/null || git config --get gpg.program 2>/dev/null || echo gpg)
      fi
      if ! command -v "$_gs_prog" >/dev/null 2>&1; then
        warn "tag $_gs_tag is $_gs_kind-signed, but '$_gs_prog' is not installed, so the signature could not be checked — trusting the tag via origin/master."
        return 0
      fi ;;
  esac
  _gs_why=$(printf '%s\n' "$_gs_out" | grep -E '\[GNUPG:\] (BADSIG|EXPKEYSIG|REVKEYSIG|ERRSIG)' | head -n1 || true)
  refuse_tag "tag $_gs_tag carries an $_gs_kind signature that FAILED verification (${_gs_why:-$(last_line "$_gs_out")}). A bad signature means the tag was altered after it was signed. Run 'git verify-tag $_gs_tag' for details; do not apply it."
  return 1
}

# install_auth_mode — local | byoi | bundled, detected exactly as start.sh detects an existing install.
install_auth_mode() {
  _am=$(grep -E '^AUTH_MODE=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)
  if [ "$_am" = "local" ]; then
    printf 'local'
  elif grep -qE '^ZITADEL_MASTERKEY=' "$ENV_FILE"; then
    printf 'bundled'
  else
    printf 'byoi'
  fi
}

# env_key_not_applicable <key> — 0 when start.sh comments <key> out for this install's mode (render_env_file),
#   so its absence from .env.prod is by design. lan = a port-only LAZYIT_SITE_ADDRESS (ADR-0087).
env_key_not_applicable() {
  case "$INSTALL_MODE:$1" in
    local:ZITADEL_*|local:OIDC_*|local:AUTH_ISSUER|local:AUTH_INTERNAL_ISSUER|local:AUTH_CLIENT_*) return 0 ;;
    byoi:ZITADEL_*|byoi:OIDC_JWKS_URI|byoi:AUTH_INTERNAL_ISSUER) return 0 ;;
  esac
  if [ "$1" = "WEB_ORIGIN" ]; then
    case "$(grep -E '^LAZYIT_SITE_ADDRESS=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)" in
      :[0-9]*) return 0 ;;
    esac
  fi
  return 1
}

# =============================================================================
# missing_env_keys — active KEY= names in the target's .env.prod.example NOT present in the live .env.prod,
#   minus the keys this install's mode leaves unset on purpose (env_key_not_applicable).
#   Only KEY names on non-comment lines are compared (values/comments ignored). Prints one missing key per
#   line (empty output = nothing missing). This NEVER writes .env.prod — detection only.
# =============================================================================
missing_env_keys() {
  _ex_keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_EXAMPLE" | sed 's/=.*//' | sort -u)
  _live_keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/=.*//' | sort -u)
  # Keys in example but not in live.
  printf '%s\n' "$_ex_keys" | while IFS= read -r _k; do
    [ -n "$_k" ] || continue
    env_key_not_applicable "$_k" && continue
    if ! printf '%s\n' "$_live_keys" | grep -qx "$_k"; then
      printf '%s\n' "$_k"
    fi
  done
}

# =============================================================================
# count_migrations — number of applied Prisma migrations (the _prisma_migrations ledger). Used to decide,
#   on failure, whether a migration ran during THIS update (after > before ⇒ migrated ⇒ NO auto-rollback).
#   Returns "0" if the table can't be read (treated as "unknown" → we choose the SAFE branch below).
# =============================================================================
count_migrations() {
  _n=$(printf "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;\n" | db_psql_scalar | head -n1 | tr -d '[:space:]')
  case "$_n" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$_n" ;; esac
}

# =============================================================================
# health_gate — poll /health/ready inside the api container, then confirm the baked APP_VERSION == target.
#   /instance/version requires auth, so we read the version from the container's env directly (that IS what
#   GET /instance/version returns — ADR-0083). Returns 0 on success.
# =============================================================================
health_gate() {
  _i=0
  while [ "$_i" -lt "$HEALTH_TRIES" ]; do
    if $DC exec -T api node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
      break
    fi
    _i=$((_i + 1))
    sleep "$HEALTH_INTERVAL"
  done
  [ "$_i" -lt "$HEALTH_TRIES" ] || { warn "the api never became ready within the health window."; return 1; }

  _running=$($DC exec -T api node -e "process.stdout.write(process.env.APP_VERSION||'')" 2>/dev/null | tr -d '[:space:]')
  if [ "$_running" != "$TARGET_TAG" ]; then
    warn "the api is ready but reports version '$_running', expected '$TARGET_TAG'."
    return 1
  fi
  return 0
}

# =============================================================================
# handle_failure <reason> — the ADR §3.9 fork:
#   - NO migration ran (MIGRATIONS_AFTER <= MIGRATIONS_BEFORE) → AUTO-ROLLBACK to the previous tag: rebuild
#     + up on PREV_REF (fast, lossless). Stamp rolled_back.
#   - a migration ran → STOP. Do NOT auto-restore. Print the exact, confirm-gated restore commands for the
#     labeled dumps, with honest "restore point / data loss" language. Stamp failed.
# =============================================================================
handle_failure() {
  _reason=$1
  warn "$_reason"

  _migrated=0
  if [ -n "$MIGRATIONS_BEFORE" ] && [ -n "$MIGRATIONS_AFTER" ] && [ "$MIGRATIONS_AFTER" -gt "$MIGRATIONS_BEFORE" ]; then
    _migrated=1
  fi

  if [ "$_migrated" -eq 0 ]; then
    step "No migration ran — auto-rolling back to $FROM_VERSION"
    if git checkout --quiet "$PREV_REF" 2>/dev/null; then
      export LAZYIT_VERSION="$FROM_VERSION"
      export LAZYIT_GIT_SHA
      LAZYIT_GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
      if $DC build && $DC up -d; then
        stamp "rolled_back" "$_reason"
        die "update failed BEFORE any migration; auto-rolled back to $FROM_VERSION (no data lost). Reason: $_reason"
      fi
    fi
    stamp "failed" "$_reason (auto-rollback ALSO failed)"
    die "update failed and the auto-rollback ALSO failed. Bring the stack up manually on the previous version, or restore the pre-update backup (see below).
       $(print_restore_commands)"
  fi

  # A migration ran: NEVER auto-restore. Print the guided, confirm-gated restore.
  stamp "failed" "$_reason (a migration ran — guided restore required)"
  cat >&2 <<EOF

============================================================================
  UPDATE FAILED — a database migration had already run.
============================================================================
  A forward-only migration was applied, so there is NO automatic rollback: the
  ONLY way back to $FROM_VERSION is to RESTORE the pre-update backup below. This
  is a RESTORE POINT, not an undo — restoring DISCARDS everything written to the
  databases since the backup was taken (a few minutes ago). Read that twice.

  If you can fix forward (recommended for a small data-loss window), do that instead.

  To restore (RUN THESE YOURSELF — nothing here is automatic):
$(print_restore_commands)
============================================================================
EOF
  die "update failed after a migration ran. A confirm-gated restore is required — commands printed above. $_reason"
}

# Print the exact restore commands for the labeled dumps this run took. Human-run only.
print_restore_commands() {
  cat <<EOF
    # 1) Go back to the previous version's code:
    git checkout $PREV_REF
    # 2) Restore the database(s) from the verified pre-update dumps (DROPS data written since):
    $DC exec -T db sh -c 'pg_restore --clean --if-exists -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' < $BACKUP_APP
EOF
  if [ -n "$BACKUP_ZITADEL" ]; then
    cat <<EOF
    $DC exec -T zitadel_db sh -c 'pg_restore --clean --if-exists -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' < $BACKUP_ZITADEL
EOF
  fi
  cat <<EOF
    # 3) Rebuild + bring the previous version back up:
    $DC build && $DC up -d
    # Full procedure: docs/05-runbooks/backups.md
EOF
}

# =============================================================================
# hint_legacy_meili_volume — PRINT-ONLY notice about the pre-v1.53 Meilisearch data volume (#1216).
#   The Meilisearch server bump (ADR-0035 amendment 2026-09-26) moved search onto a NEW volume
#   (<project>_meili_data_v1_53_2) because a Meilisearch database only opens on the engine version that
#   wrote it; the API rebuilds the index from Postgres on boot. The old volume is left in place — it is
#   what a rollback to an earlier tag uses. This NEVER deletes anything (red line): it only tells the
#   operator the volume exists and the exact command to reclaim the space once they are done with it.
# =============================================================================
hint_legacy_meili_volume() {
  _old_meili="${1}_meili_data"
  docker volume inspect "$_old_meili" >/dev/null 2>&1 || return 0
  info "search: Meilisearch now runs on a new data volume (${1}_meili_data_v1_53_2); the API rebuilds the index from the database in the background, so search results may be incomplete for a few minutes."
  info "search: the previous volume '$_old_meili' (Meilisearch v1.12) is no longer used. It is kept for a rollback to an earlier release; once you no longer need that, reclaim the space with:  docker volume rm $_old_meili"
}

print_success() {
  _zitadel_point=""
  if [ -n "$BACKUP_ZITADEL" ]; then
    _zitadel_point=$(printf '\n      restore point (zitadel): %s' "$BACKUP_ZITADEL")
  fi
  cat >&2 <<EOF

============================================================================
  lazyit updated: $FROM_VERSION  ->  $TARGET_TAG   ✔
============================================================================
  The new version is healthy. The previous checkout, its images and the
  pre-update backups are KEPT until you're confident — nothing was pruned:
      restore point (app):     $BACKUP_APP$_zitadel_point
      previous code ref:       $PREV_REF ($FROM_VERSION)

  If something looks wrong, you can restore the pre-update state:
$(print_restore_commands)
============================================================================
EOF
}

[ "${LAZYIT_UPDATE_LIB_ONLY:-}" = "1" ] || main "$@"
