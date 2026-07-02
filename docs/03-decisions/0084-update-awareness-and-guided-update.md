---
title: "ADR-0084: Update awareness & guided update — check, weekly email, update.sh, UpdateRun"
tags: [adr, updates, versioning, deployment, infra, notifications, settings]
status: accepted
created: 2026-07-01
updated: 2026-07-01
deciders: [Joaquín Minatel]
---

# ADR-0084: Update awareness & guided update

## Status

accepted — issue #904. CEO decision (2026-07-01): **guided updater v1** ("Guiado v1, one-click
después") — a host-side `infra/update.sh` plus an in-app enqueue button; the true one-click trigger
is *designed* here (§6) as a deferred, slot-in-compatible phase. Depends on
[[0083-versioning-and-releases]] (#903): tags exist, are SSH-signed, MAJOR means "not
one-click-safe", and the running version is baked in via `git describe` → build-arg →
`GET /instance/version`. Sibling of [[0047-guided-first-deploy-bootstrap]] (the `start.sh` pattern
this extends) and [[backups]] (the DR story this must never weaken).

## Context

Updating lazyit today is SSH + `git pull` + `docker compose … up -d --build`, from memory, with no
update detection, no pre-update backup discipline, and no honest rollback story. Three structural
facts (verified against the repo) shape everything below:

1. **The update unit is a git checkout, not an image.** Images build ON the host from the working
   tree ([[0027-ci-pipeline]] builds with `push: false`; there is no registry). `compose.yaml`, the
   prod override, the Caddyfile and the migrate one-shot all live in the checkout and evolve between
   versions. An updater that only swaps image tags can never apply a release.
2. **Prisma migrations are forward-only** and run in a one-shot `migrate` container *before* the API
   (`compose.yaml`, `depends_on: service_completed_successfully`). Once a migration runs, the only
   true rollback is restoring the pre-update `pg_dump` of BOTH databases ([[backups]]) — losing
   whatever was written since. Any "rollback" language that implies otherwise is a lie.
3. **Anything that can drive Docker is root on the host.** The `api`/`web` containers are
   deliberately unprivileged and internal ([[0028-secrets-and-config]] least-privilege posture).
   `.env.prod` holds three unrotatable DR linchpins (`ZITADEL_MASTERKEY`, `WORKFLOW_SECRET_KEY`, the
   DB password) that `start.sh` refuses to ever regenerate.

A 17-persona discovery panel converged hard (15/17): version awareness + a weekly nudge is wanted by
everyone; a self-executing in-app update button is vetoed by every operator and security reviewer
consulted ("that's not an update button, that's a second admin with root on my server"). The named
reference patterns: **Mailcow's `update.sh`** for the guided host script, **Gitea's notify-only
honesty** as the fallback posture when nothing host-side is installed. Novice operators (persona
Tomás) added the non-negotiables: forced pre-update backup with *visible proof*, real stage status
(not a spinner that dies with the container), and a guided — never improvised — recovery path.

## Decision

Four pieces, strictly layered so each is useful without the next: an **update check** (read-only), a
**weekly email** (rides existing seams), a **guided host updater** `infra/update.sh` (the only thing
that mutates the host), and an **`UpdateRun` contract** that lets the app request and observe an
update it never executes.

### 1 — Update check (opt-in, beacon-free, fail-soft)

A repeatable, jittered, in-API job following the existing sweep mold — a plain `setInterval`,
`unref`'d, re-entrancy-guarded, whole pass try/caught, skipped under `NODE_ENV=test` — copying
`NotificationsRetentionSweeper` exactly (the codebase deliberately avoids `@nestjs/schedule`; this
is not the moment to import it). The job performs one **anonymous GET to the GitHub Releases API**
and semver-compares against the running version.

- **Zero instance-identifying data.** No POST, no install ID, no org name, no counts — a bare
  unauthenticated GET, the same trust shape as checking an OS package mirror. Beacon-free is a
  red line (§Red lines), not a default.
- **Result cached** in a singleton config row `{latestVersion, htmlUrl, notes, checkedAt}` (the
  `SmtpSettings`/`AssetTagScheme` singleton mold). The UI reads the cache; it never fetches GitHub
  at render time.
- **Opt-in, default OFF.** One `start.sh` question ("Check github.com weekly for updates? y/N") and
  a Settings → Instance toggle. Restricted-egress and air-gapped instances stay first-class.
- **Every failure fails soft** — egress blocked, DNS dead, rate-limited, repo unreachable: log and
  drop, `latestVersion` stays null, the UI degrades to **version-display-only** ("checks disabled /
  couldn't check"). The check never blocks boot, never delays a request, never raises an alarm, and
  never treats "couldn't check" as "up to date".

### 2 — Weekly "N behind" email

Rides the existing notifications `emit()` seam and the [[0079-instance-smtp-outbound-email]]
code-level allowlist with one new type, `update.available`. No new delivery machinery.

- **Recipients: ADMINs.** The audience that can act on it.
- **Suppress-when-current** — `behindBy === 0` emits nothing, ever.
- **De-dupe per newly-observed latest version** — one email when a new latest version is first
  observed, never a weekly re-nag about the same version. An ignored reminder trains operators to
  ignore the one that matters.
- When SMTP is unconfigured the feature simply doesn't exist (checkbox disabled with a hint, §5).

### 3 — `infra/update.sh` (the guided updater)

A sibling of `start.sh`, same contract: guided, idempotent, **non-destructive**, readable by the
operator before they run it. Mailcow's `update.sh` is the named reference pattern. The sequence:

1. **Single-flight lock file** — two admins (or a double-click) can never race an update.
2. **Pre-flight** — disk headroom (a host-side image build is coming), current stack health, clean
   git working tree. Any failure stops before anything is touched.
3. **Mandatory verified `pg_dump` of BOTH databases** (app + `zitadel_db`), labeled with the
   pre-update version + SHA + timestamp, using the backup sidecar's verify-then-promote discipline
   ([[backups]]). **A failed or unverifiable dump aborts the update.** The dump path and size are
   printed — visible proof, not a promise. This runs regardless of whether the operator ever
   configured the backup sidecar; the updater is its own safety net.
4. **`git fetch --tags && git verify-tag <tag> && git checkout <tag>`** — only SSH-signed tags
   ([[0083-versioning-and-releases]]) are applied; verification failure stops the update.
5. **Missing-env detection, FAIL LOUD** — diff the target tag's `.env.prod.example` keys against the
   live `.env.prod`; on a gap, stop and print the *exact line to add* (the `REDIS_URL` /
   `WORKFLOW_SECRET_KEY` upgrade notes, automated). The script **never writes `.env.prod`** — a
   human eyeball on the linchpin file is the cheapest insurance that exists.
6. **`compose build` BEFORE swapping anything** — the slow, failure-prone step happens while the old
   stack still serves. A build failure leaves the running stack untouched.
7. **`up -d`** — the migrate one-shot runs, then the stack recreates.
8. **Health gate** — poll `/health/ready`, then verify `GET /instance/version == target`.
9. **On failure:** if **no migration ran**, auto-rollback — checkout the previous tag, rebuild, up
   (fast, lossless). If **a migration ran**, STOP and print the exact restore commands for the
   labeled dumps — a **confirm-gated guided restore**, never a silent automated DB restore (an
   automated destructive write triggered by a failure heuristic is scarier than the failure).
10. **Keep the rollback target** — the previous checkout, its images, and the pre-update dumps
    survive until the operator confirms the new version healthy. Never pruned by the update itself.

Throughout, the script stamps its progress into the `UpdateRun` row (§4) over plain Postgres.

### 4 — `UpdateRun`: the API↔host contract

The in-app ADMIN action is **enqueue + show the command** — the API records intent and reads
outcome; the host executes. `POST /instance/update` (ADMIN + the human-only guard) does exactly one
thing: insert an append-only **`UpdateRun`** row and return. The UI then shows the exact
`./infra/update.sh vX.Y.Z` command to run on the host.

- **Shape** (append-only, `autoincrement` id per the log convention): `requestedByUserId`,
  `fromVersion`, `toVersion`, `status` enum `requested → backing_up → migrating → building →
  restarting → verifying → done | failed | rolled_back`, per-phase timestamps, `logTail`, `error`.
- **The host script writes every state transition; the API only reads.** The row lives in Postgres,
  which an app update never rebuilds — so job state survives the restart of the very containers
  being replaced, and the UI just polls the same origin.
- **Boot-time reconciliation:** a freshly-booted API that finds a dangling non-terminal row compares
  its own `APP_VERSION` to the row's `toVersion` — equal ⇒ stamp `done`, unchanged ⇒ stamp `failed`.
  No permanent "updating…" ghost.
- **`UpdateRun` IS the audit record** — who requested, from→to, when, outcome. It is deliberately
  **NOT** added to the [[0081-audit-log-read-surface]]: that surface reads three *security* logs; an
  update is an operational event. Its history renders as a simple list on Settings → Instance.

**Honest rollback language, everywhere:** the feature is a **"restore point"**, never a magic undo.
A migrated version rolls back ONLY by restoring the pre-update dumps, and everything written since
is lost — the script and the UI both say exactly that, in those words, before anyone confirms.
Releases that bump the pinned Zitadel image are flagged **no-quick-rollback** (Zitadel migrates
`zitadel_db` aggressively; rolling back then means restoring that dump too).

### 5 — UI contract (The Ledger, [[0077-ledger-design-language-frontend-refactor]])

- A **"Version & updates" card FIRST** on Settings → Instance (InfoRow + StatusBadge patterns;
  version strings in mono). Rows: current version · status badge (up to date / N behind / checks
  off) · last checked · update history (the `UpdateRun` list).
- The **update CTA is the singular oxblood action** on the page, rendered **only when behind** —
  never a dead disabled button when current (a calm success badge instead).
- In-progress state shows **stage labels from the real `UpdateRun` phases** — backing up, migrating,
  building, restarting, verifying. **No fake progress bar** (the client cannot know true progress;
  honest stages beat cosmetic polish).
- During the restart window, fetch failures render as a quiet **"reconnecting"** state — same-origin
  polling, no red toasts; the job state is in Postgres waiting for the new API to answer.
- Settings-hub card badge **only-when-behind** — the [[0056-in-app-notification-bell]] rule: the
  badge exists only when the count is non-zero.
- A quiet, non-interactive **`lazyit vX.Y.Z` mark** in the app shell, visible to everyone.
- The weekly-email checkbox is **disabled-with-hint when SMTP is unconfigured**, linking to the
  SMTP card on the same page.
- **No global banners, no nagging modals, no login-time interrupts.** Update awareness lives where
  the admin already opted to look.

### 6 — Deferred one-click (designed now, built later)

The true one-click path is designed here so it slots in without changing the contract, and is
explicitly **NEVER a Docker socket in a network-reachable container**:

- A **host-side systemd path-unit trigger**, installed once by `start.sh`, watches for a
  `requested` `UpdateRun` (or a bind-mounted sentinel file the API touches).
- The **stable trigger** is separated from the **versioned recipe**: the trigger checks out the
  target tag, then runs *that tag's* `update.sh` — the recipe evolves with releases, the trigger
  doesn't.
- Where the trigger isn't installed (non-systemd hosts, operators who skipped it), the button
  degrades to today's honest posture: show the command (the Gitea model). A degraded state, never a
  dead button.
- Because the host script already owns `requested → *` and the API already only enqueues and reads,
  adding the trigger changes **zero** API or UI code.

## Consequences

- Operators finally know what version they run, whether they're behind, and have a single trusted
  command that backs up before it migrates — with a recovery path a novice can follow at 3am.
- The API grows one sweep-mold job, one singleton config row, one notification type, one `UpdateRun`
  table + two endpoints (`POST /instance/update`, a read for the card). The host grows one script.
  No new services, no registry, no daemon in v1.
- **Follow-ups (filed after ADR approval, phased):** a new runbook
  `docs/05-runbooks/updating-lazyit.md` (the update + guided-restore procedure, cross-linked from
  [[backups]]); Manual pages (en + es) at implementation time per [[0062-in-app-help-manual-surface]];
  the implementation issues themselves (check + email · update.sh · UpdateRun + UI).
- Update-awareness couples to GitHub availability — acceptable: the fallback is the status quo, and
  the feature is opt-in and fail-soft by construction.
- `update.sh` becomes a second script to keep in lockstep with the compose topology; it lives next
  to `start.sh` and shares its helpers precisely so they drift together or not at all.

## Considered alternatives

- **Docker-socket updater sidecar (or socket in api/web) — rejected.** Anything holding
  `/var/run/docker.sock` is root on the host; reachable from the app layer, it converts any app RCE
  into full host compromise — a categorical escalation over today's unprivileged containers, and an
  instant veto from every compliance-shaped operator consulted. ADMIN-gating is an application-layer
  control and cannot fence a host-layer capability.
- **Watchtower-style image-tag swap — structurally impossible.** There is no registry, and the
  release *is* the checkout: `compose.yaml`, the Caddyfile and the migrations all change between
  versions. Pulling a new image tag can never apply a lazyit release. (Even with GHCR later, the
  compose files still ride git — see Deferred.)
- **Blue/green / zero-downtime — infeasible and not worth it.** Forward-only migrations run against
  ONE shared DB before the API starts; old and new code cannot safely coexist across a schema
  change, and a single-host 5–20-person tool does not need it. Accept a ~60-second blip at an
  admin-chosen moment.
- **Auto-apply (scheduled/unattended updates) — rejected, permanently.** A compromised release
  identity would self-install fleet-wide as root; a bad migration would run with nobody watching;
  and the one operator story that destroys trust forever is "it updated itself at 3am and broke."
  Every update is an explicit human action. This is a red line, not a v1 scope cut.
- **Notify-only (no script) — insufficient alone.** Honest, but it leaves the pre-update backup and
  the guided recovery to operator memory — the exact gap (persona Tomás) this ADR exists to close.
  It survives as the degraded posture when nothing host-side is available.

## Red lines

- **Never mount `/var/run/docker.sock` into `web`, `api`, or any network-reachable container.** No
  `--privileged`, no Docker-in-the-app, no exceptions for convenience.
- **No auto-apply, ever.** No scheduled or unattended update path exists, in any configuration.
- **The updater never writes, rotates, or regenerates `.env.prod`** or the DR linchpins
  (`ZITADEL_MASTERKEY`, `WORKFLOW_SECRET_KEY`, the DB password), **and never runs `down -v`**.
  `start.sh`'s non-destructive guarantee extends to `update.sh` verbatim.
- **No update proceeds without a fresh, verified pre-update backup of BOTH databases.** A failed
  dump aborts the update — there is no override flag.
- **No silent automated DB restore.** Restoring a dump is always a loud, confirm-gated, guided
  human action with the data-loss window stated plainly.
- **Egress is never mandatory.** Restricted/air-gapped instances stay fully functional; the feature
  degrades to version display. The check is anonymous and beacon-free — no instance-identifying
  byte ever leaves the host.
- **The manual documented `compose up` path remains the recovery floor.** No update may leave the
  stack in a state the operator cannot recover with the plain runbook commands.

## Deferred (recorded, out of v1)

- **The systemd path-unit one-click trigger** — designed in §6, built when demanded; same contract,
  zero API/UI change.
- **GHCR image publishing** ([[0027-ci-pipeline]]'s reserved slot) — would speed patch updates but
  cannot replace the git-fetch step (compose lives in the checkout); a parallel optimization, not a
  prerequisite.
- **Scheduled maintenance windows** ("apply Friday 19:00") — an auto-apply-shaped feature; revisit
  only with the one-click trigger, if ever.
- **Arbitrary-version rollback** — v1 rolls back to the immediately-previous version only; crossing
  multiple Zitadel/Meili bumps gets complex fast.
- **Offline bundle updates** for air-gapped hosts — real but rare; the manual path covers it today.

## Amendment — security-relevant gap (issue #908, 2026-07-02)

The weekly check now also parses the [[0083-versioning-and-releases|ADR-0083]] security marker. Reusing the
SAME `per_page=100` releases response (no second call), it flags `securityRelevant = true` when ANY release
strictly newer than the running version (i.e. anywhere in the gap up to and including latest) carries
`SECURITY_RELEASE_MARKER` in its notes body. The boolean is cached on the `update_settings` singleton
alongside `behindBy` (same reasoning: derived from the full list at check time, not recomputable at read)
and surfaced on `GET /instance/update-status` as `securityRelevant`.

- **Settings → Instance card:** a distinct red *N behind — security* badge + a **Security update available**
  callout when `securityRelevant`.
- **Weekly email:** a security-relevant gap ALWAYS reaches the inbox — it fires on a new latest version like
  a routine nudge, AND re-fires exactly ONCE if a version already emailed as routine later flips to
  security-relevant (a GHSA published on an already-notified version). A second cache boolean
  `lastEmailedSecurity` de-dupes that transition so the security nudge never becomes a weekly re-nag; the
  email raises severity to `warning`, prefixes the subject with "Security update:", and gains a
  `:security` dedupeKey suffix so it is a distinct notification row from any prior routine one.
