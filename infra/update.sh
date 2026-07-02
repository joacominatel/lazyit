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
#   3. Verified dual pg_dump     — MANDATORY. Dump BOTH DBs (app + zitadel_db), verify each is restorable
#                                  (pg_restore -l), and only then keep it. A failed/unverifiable dump ABORTS
#                                  the update — there is no override flag. Paths + sizes are printed (proof).
#   4. verify-tag + checkout     — only an SSH-signed tag (ADR-0083) is applied; verification failure stops.
#   5. Missing-env → FAIL LOUD   — diff the target tag's .env.prod.example keys vs the live .env.prod; on a
#                                  gap, print the EXACT lines to add and STOP. This script NEVER writes
#                                  .env.prod (a human eyeball on the DR-linchpin file is the cheapest insurance).
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
#   - NO update proceeds without a fresh, VERIFIED pre-update backup of BOTH databases.
#   - NO silent automated DB restore — a migrated rollback is a printed, human-run, confirm-gated action.
#   - NO docker socket is mounted anywhere; this is a HOST script the operator runs — the app never executes it.
#
# Usage:
#   ./infra/update.sh v1.5.0            # update to a specific signed tag
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
# =============================================================================
if [ "${LAZYIT_UPDATE_REEXEC:-}" != "1" ]; then
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
  Backs up BOTH databases (verified) BEFORE anything, verifies the tag's SSH signature, checks out the
  target, checks for new required env vars (and STOPS if any are missing — it never edits .env.prod),
  builds the new images while the old stack still serves, then swaps and health-gates. If it fails
  before any migration ran it auto-rolls-back; if a migration ran it STOPS and prints the exact,
  human-run restore commands (never an automatic DB restore).

OPTIONS
  --yes, -y     Skip the interactive "proceed?" confirmation (the backup + tag verification still run).
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
  case "$TARGET_TAG" in
    v[0-9]*.[0-9]*.[0-9]*) : ;;
    *) die "invalid target tag '$TARGET_TAG' — expected a signed release tag like v1.5.0." ;;
  esac
  case "$TARGET_TAG" in
    *[!v0-9.]*) die "invalid target tag '$TARGET_TAG' — only digits, dots and a leading v are allowed." ;;
  esac

  # ---------- run from the repo root (resolved before re-exec, passed via env) ----------
  cd "$LAZYIT_REPO_ROOT" || die "cannot cd to the repo root ($LAZYIT_REPO_ROOT)"
  [ -f "$COMPOSE_BASE" ] || die "not at the repo root: $COMPOSE_BASE not found."
  [ -f "$COMPOSE_PROD" ] || die "missing $COMPOSE_PROD — incomplete checkout?"
  [ -f "$ENV_FILE" ]     || die "missing $ENV_FILE — is this instance installed? Run infra/start.sh first."

  # The canonical prod compose command (verbatim from start.sh / the runbooks).
  DC="docker compose -f $COMPOSE_BASE -f $COMPOSE_PROD --profile prod --env-file $ENV_FILE"

  cat >&2 <<EOF

  lazyit — guided version update
  repo root: $LAZYIT_REPO_ROOT
  target:    $TARGET_TAG
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
    printf '\n  This will back up both databases, then update %s -> %s with a brief (~60s) outage.\n  Proceed? [y/N]: ' \
      "$FROM_VERSION" "$TARGET_TAG" >&2
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

  # ---------- 3. MANDATORY VERIFIED DUAL BACKUP ----------
  step "Backing up BOTH databases (mandatory, verified)"
  mkdir -p "$BACKUP_DIR"
  _ts=$(date +%Y%m%d-%H%M%S)
  _sha=$(printf '%s' "$PREV_REF" | cut -c1-12)
  BACKUP_LABEL="pre-update-${FROM_VERSION}-${_sha}-${_ts}"
  BACKUP_APP="$BACKUP_DIR/${BACKUP_LABEL}-app.dump"
  BACKUP_ZITADEL="$BACKUP_DIR/${BACKUP_LABEL}-zitadel.dump"

  dump_verify "db"         "$BACKUP_APP"     || fail_backup "app"
  dump_verify "zitadel_db" "$BACKUP_ZITADEL" || fail_backup "zitadel"
  ok "backups verified:"
  info "  app     -> $BACKUP_APP ($(wc -c < "$BACKUP_APP" | tr -d ' ') bytes)"
  info "  zitadel -> $BACKUP_ZITADEL ($(wc -c < "$BACKUP_ZITADEL" | tr -d ' ') bytes)"

  # ---------- 4. VERIFY-TAG + CHECKOUT ----------
  step "Verifying and checking out $TARGET_TAG"
  stamp "building"
  git fetch --tags --quiet origin 2>/dev/null || git fetch --tags --quiet 2>/dev/null || \
    die "git fetch failed — cannot retrieve the target tag. Check network / remote."
  git rev-parse -q --verify "refs/tags/${TARGET_TAG}" >/dev/null 2>&1 || \
    fail_hard "tag $TARGET_TAG does not exist after fetch. Check the tag name."
  if ! git verify-tag "$TARGET_TAG" >/dev/null 2>&1; then
    fail_hard "tag $TARGET_TAG is NOT a valid signed tag (git verify-tag failed). Refusing to apply an unverified release (ADR-0083). Import the signing key or check the tag."
  fi
  ok "tag $TARGET_TAG signature verified"
  git checkout --quiet "$TARGET_TAG" || fail_hard "git checkout $TARGET_TAG failed."
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
# missing_env_keys — active KEY= names in the target's .env.prod.example NOT present in the live .env.prod.
#   Only KEY names on non-comment lines are compared (values/comments ignored). Prints one missing key per
#   line (empty output = nothing missing). This NEVER writes .env.prod — detection only.
# =============================================================================
missing_env_keys() {
  _ex_keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_EXAMPLE" | sed 's/=.*//' | sort -u)
  _live_keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | sed 's/=.*//' | sort -u)
  # Keys in example but not in live.
  printf '%s\n' "$_ex_keys" | while IFS= read -r _k; do
    [ -n "$_k" ] || continue
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

# Print the exact restore commands for the labeled dumps (both DBs). Human-run only.
print_restore_commands() {
  cat <<EOF
    # 1) Go back to the previous version's code:
    git checkout $PREV_REF
    # 2) Restore BOTH databases from the verified pre-update dumps (DROPS data written since):
    $DC exec -T db sh -c 'pg_restore --clean --if-exists -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' < $BACKUP_APP
    $DC exec -T zitadel_db sh -c 'pg_restore --clean --if-exists -U "\$POSTGRES_USER" -d "\$POSTGRES_DB"' < $BACKUP_ZITADEL
    # 3) Rebuild + bring the previous version back up:
    $DC build && $DC up -d
    # Full procedure: docs/05-runbooks/backups.md
EOF
}

print_success() {
  cat >&2 <<EOF

============================================================================
  lazyit updated: $FROM_VERSION  ->  $TARGET_TAG   ✔
============================================================================
  The new version is healthy. The previous checkout, its images and the
  pre-update backups are KEPT until you're confident — nothing was pruned:
      restore point (app):     $BACKUP_APP
      restore point (zitadel): $BACKUP_ZITADEL
      previous code ref:       $PREV_REF ($FROM_VERSION)

  If something looks wrong, you can restore the pre-update state:
$(print_restore_commands)
============================================================================
EOF
}

main "$@"
