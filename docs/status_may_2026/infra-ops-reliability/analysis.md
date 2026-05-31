# Infrastructure — Operations, Backups, DR, Secrets, Upgrades, Reliability
*Deep analysis as of 2026-05-30 (status_may_2026).*

## Role & scope

Senior SRE pass, **read-only**, through the lens of an **IT-generalist operator** who will run
lazyit on their own infra for years (knows Docker barely, edits `.env`, runs `docker compose up`).
Scope: the self-hosted operational story — backup & restore (Postgres app DB + Zitadel DB + Meili +
Caddy/ACME state + uploaded files), disaster recovery, secrets management & rotation, resource
limits & sizing, the upgrade/migration path between versions, healthchecks & restart policies, log
retention, and first-boot UX. Goal: name every gap between "works on the developer's machine" and
"an IT generalist can operate it safely for years," and prioritize the runbook & infra additions
that close them.

I respect the accepted ADRs (esp. 0015 single-org, 0025 containerization, 0026 reverse-proxy/TLS,
0028 secrets-by-`.env`, 0037 Zitadel/BYOI). Where I would change one, I label it a **PROPOSAL to
supersede**.

## Method

Files read in full (cited inline as `file:line`):

- `infra/docker-compose.prod.yml`, root `docker-compose.yml`
- `infra/docker/api.Dockerfile`, `web.Dockerfile`, `migrate.Dockerfile`
- `infra/caddy/Caddyfile`
- `infra/env/.env.prod.example`, the live (gitignored) `infra/env/.env.prod`, root `.env.example`
- `infra/README.md`
- `docs/05-runbooks/`: `backups.md`, `deploy-self-hosted.md`, `docker-prod-like-first-boot.md`,
  `auth-bootstrap.md`, `prisma-migrations.md`, `_MOC.md`
- `docs/03-decisions/0028-secrets-and-config.md`
- `apps/api/src/main.ts`, `apps/api/src/prisma/prisma.service.ts`, `apps/api/prisma/seed.ts`,
  `apps/api/src/articles/articles.controller.ts` (upload path), `apps/api/scripts/reindex-all.ts`,
  `apps/api/package.json`
- `.github/workflows/ci.yml`, `.gitignore`

Cross-checks run: `git ls-files`/`check-ignore` for `.env.prod`; `grep` for resource/log limits,
health endpoints, backup automation, upload disk-storage, rollback docs; `stat` on env-file perms;
a web check of the official `postgres` image to verify the PGDATA layout change in v18.

**FACT** = verified in the listed files. **PROPOSAL/OPINION** = my recommendation.

---

## Findings

Ordered by operational priority (a years-long single-host operation that holds sensitive Access
data and must survive disk loss, operator turnover, and version upgrades).

### 1. Backup runbook covers only the app DB — Zitadel DB, the Zitadel masterkey, Meili, and Caddy ACME state are unprotected

- **Category:** infra · **Severity:** high · **Effort:** small · **Confidence:** high
- **Location:** `docs/05-runbooks/backups.md:1-79`; volumes in
  `infra/docker-compose.prod.yml:195-200` (`db_data`, `zitadel_db_data`, `meili_data`,
  `caddy_data`, `caddy_config`); masterkey at `auth-bootstrap.md:38-43`.
- **Observation (FACT):** `backups.md` documents `pg_dump`/`pg_restore` for the **app** database
  only (`$POSTGRES_USER`/`$POSTGRES_DB`, `backups.md:32`). The prod stack now also runs a **second
  Postgres** for Zitadel (`zitadel_db`, `docker-compose.prod.yml:92-113`), `meilisearch`
  (`:162-174`), and `caddy_data`/`caddy_config` (`:184-187, 199-200`). None of these is in the
  backup runbook. The backup doc was last updated `2026-05-25` (`backups.md:6`) — **before** the
  Zitadel/OIDC stack landed (PR #58/#60), so it is stale relative to the deployed topology.
  Critically: losing `ZITADEL_MASTERKEY` "means losing access to Zitadel's encrypted data"
  (`auth-bootstrap.md:42-43`) — but the masterkey backup instruction lives only in the auth
  runbook, not the backup runbook, and there is no single "what to back up" list.
- **Why it matters:** Auth is now wired (ADR-0037/0038/0039). If the host disk dies, restoring only
  `db_data` brings back inventory/access data but **every user is locked out** — Zitadel's users,
  the OIDC client, and its encrypted secrets are gone. Restoring the Zitadel DB without the matching
  `ZITADEL_MASTERKEY` yields an unreadable database. For an IT generalist, "I restored the backup
  and nobody can log in" is the worst possible DR outcome. Meili can be rebuilt with `reindex:all`
  (fail-soft, ADR-0035), and `caddy_data` only costs a re-issue of certs, but those caveats must be
  written down, not assumed.
- **Recommendation:** Rewrite `backups.md` into a complete **DR inventory**: (1) app DB dump; (2)
  Zitadel DB dump (`zitadel_db`, `$ZITADEL_DB_USER`/`$ZITADEL_DB_NAME`); (3) the **whole**
  `infra/env/.env.prod` (DB password + `ZITADEL_MASTERKEY` + `AUTH_SECRET` + OIDC secrets) stored
  separately and access-controlled; (4) note Meili is rebuildable (`reindex:all`) and `caddy_data`
  is re-issuable so they need not be backed up; (5) state the **restore order** (env file →
  zitadel_db → app db → `up -d` → `reindex:all`). Add a one-line "what to back up" table at the top.

### 2. No automated/scheduled backups — DR depends on the operator remembering to run a manual command

- **Category:** infra · **Severity:** high · **Effort:** medium · **Confidence:** high
- **Location:** `docs/05-runbooks/backups.md:15-19, 70-76`; `_MOC.md:35-37`
- **Observation (FACT):** Backups are explicitly **manual** ("Automating it … is deferred — wire it
  up when there's a real deployment to protect," `backups.md:17-19`). There is no cron, no sidecar,
  no `pg_dump` automation anywhere in `infra/` or `.github/` (grep found references only in the doc
  and compose comments). The MOC lists "Scheduled/offsite backup automation" as a *planned* runbook
  (`_MOC.md:35-37`).
- **Why it matters:** The product mandate is "an IT generalist can operate it safely for years." A
  backup that exists only as a manual command in a runbook is, in practice, **not taken** —
  operators forget, leave the company, or assume "Docker handles it." The single-host model
  (ADR-0015) means one disk failure = total loss. This is the single biggest gap between
  "works on the dev's machine" and "safe for years."
- **Recommendation:** Ship a **backup sidecar** as an opt-in compose profile (PROPOSAL — does not
  violate ADR-0028, which is about *secrets*, not backups): a small Alpine container running cron
  +`pg_dump` for **both** databases on a schedule, writing timestamped dumps to a host-mounted
  `./backups` volume with a retention sweep (keep N). Make it a `profiles: [backup]` service so it's
  off by default but enabled with one flag. Document an optional offsite copy hook (rclone/`scp` env
  var) without mandating cloud (respects "no mandatory cloud connection"). This is the highest-ROI
  infra addition.

### 3. No `restore` story for Zitadel, and the app `down -v` restore path now silently destroys the IdP

- **Category:** infra · **Severity:** high · **Effort:** small · **Confidence:** high
- **Location:** `backups.md:52-59`; `docker-prod-like-first-boot.md:67`
- **Observation (FACT):** The "cleanest restore" path runs
  `docker compose -f infra/docker-compose.prod.yml down -v` (`backups.md:54`) to get a fresh app DB.
  `down -v` removes **all** named volumes in the project, including `zitadel_db_data`, `meili_data`,
  `caddy_data` (`docker-compose.prod.yml:195-200`). The runbook comment claims it only "removes
  db_data" (`backups.md:54`) — **incorrect** now that the stack has five volumes. There is no
  Zitadel restore procedure at all.
- **Why it matters:** An operator following the documented restore steps to recover the inventory DB
  will **wipe their entire IdP** (all users, the OIDC client registration, the masterkey-encrypted
  store) as a side effect, then discover login is broken with no documented recovery. This turns a
  routine restore into a compound outage.
- **Recommendation:** Replace `down -v` in the restore path with a **targeted volume removal**
  (`docker volume rm lazyit-prod_db_data` after `down`, then `up -d`) so only the app DB is reset.
  Add a parallel "Restore Zitadel" subsection (same `pg_restore` shape against `zitadel_db`, plus the
  reminder that the **same `ZITADEL_MASTERKEY`** must be in `.env.prod` first). Fix the inaccurate
  `down -v` comment.

### 4. No resource limits anywhere — one runaway container can OOM/CPU-starve the whole single host

- **Category:** infra · **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `infra/docker-compose.prod.yml` (entire file — grep for `deploy:`/`resources:`/
  `mem_limit`/`cpus` returns nothing)
- **Observation (FACT):** No service in either compose file declares memory or CPU limits. The stack
  packs **seven** long-running containers (db, api, web, zitadel, zitadel_db, meilisearch, caddy)
  plus a one-shot migrate onto one host with **zero** sizing guidance. The two `shm_size` settings
  (`:18` 256mb db, `:95` 64mb zitadel_db) are the only resource tuning present.
- **Why it matters:** On a small VPS (a realistic target for a 2-20-person IT team), an unbounded
  Meili reindex, a Postgres backup, a `.docx` import (SEC-002 decompression bomb is still open), or
  a memory leak in any one service can OOM-kill **the Postgres holding all the data**, taking the
  whole instance down. An IT generalist has no way to know how much RAM/CPU to provision because no
  doc states it.
- **Recommendation:** Add conservative `deploy.resources.limits`/`reservations` per service
  (PROPOSAL — Compose honors `mem_limit`/`cpus` in non-swarm mode; e.g. db 1g, api 512m, web 256m,
  zitadel 512m, zitadel_db 256m, meili 512m, caddy 128m) and publish a **sizing table** in
  `deploy-self-hosted.md`: minimum host = e.g. 2 vCPU / 4 GB / 20 GB disk for ≤50 assets, with a
  growth note. This is the operator's #1 unanswered question before they provision a box.

### 5. No log rotation configured — container logs grow unbounded and can fill the disk

- **Category:** infra · **Severity:** medium · **Effort:** quick-win · **Confidence:** high
- **Location:** `infra/docker-compose.prod.yml` (no `logging:` block on any service)
- **Observation (FACT):** No service sets a `logging:` driver/options. The API uses Pino structured
  logging to stdout (ADR-0031, `main.ts:3,10`), which is correct, but on the default `json-file`
  Docker driver those logs accumulate **without rotation**. There is no log-retention policy
  documented anywhere.
- **Why it matters:** A chatty API (every request logged with X-Request-Id) on a long-lived
  single-host deployment will, over months, write gigabytes of JSON logs that the operator never
  prunes — eventually filling `/var/lib/docker` and crashing the Docker daemon (and with it
  Postgres). Silent, slow, and exactly the kind of failure a generalist won't anticipate.
- **Recommendation:** Add a shared `logging` anchor to the compose
  (`driver: json-file`, `options: { max-size: "10m", max-file: "3" }`) applied to every long-running
  service. Quick win, prevents a guaranteed multi-month failure. Document the retention in a short
  "Logs & retention" section.

### 6. No application health/readiness endpoint — healthchecks probe `GET /` and conflate "process up" with "ready"

- **Category:** infra · **Severity:** medium · **Effort:** small · **Confidence:** high
- **Location:** `api.Dockerfile:58-61`; `web.Dockerfile:46-47`; no health route in `apps/api/src`
  (grep for `health`/`@Get('health')` returns nothing); `main.ts` has no health controller.
- **Observation (FACT):** The API container healthcheck does `GET /` and treats any non-5xx as
  healthy — explicitly relying on the 401 from the global JWT guard ("`GET / returns 401 … that is
  expected and healthy`," `api.Dockerfile:59`). There is **no** dedicated health endpoint and no DB
  connectivity check. The compose `depends_on` only gates the API on `db` health and `migrate`
  completion (`docker-compose.prod.yml:54-58`); nothing verifies the API can actually reach the DB
  after startup.
- **Why it matters:** A 401 means "the HTTP server and the auth guard are up," **not** "the database
  connection is alive and the app can serve data." If Postgres connectivity drops (network blip,
  pool exhaustion) the API keeps returning 401 to `/`, stays "healthy," and Docker never restarts or
  surfaces it. The operator sees green healthchecks while the app is broken. It also makes the
  healthcheck brittle: any future change to the guard's unauthenticated behavior silently breaks the
  liveness probe.
- **Recommendation:** Add a tiny **public** `GET /health` endpoint (liveness: 200 always) and
  `GET /health/ready` (readiness: `SELECT 1` via Prisma, 200/503) — mark them `@Public()` so the
  global guard skips them. Point the Dockerfile healthchecks and Caddy at `/health`. NestJS Terminus
  is the idiomatic choice but a 15-line bespoke controller is fine and dependency-free. Small, high
  signal-to-noise, and removes the "401-as-health" coupling.

### 7. No documented upgrade/rollback path; the migrate job runs `migrate deploy` with no DB snapshot guard and no down-migrations

- **Category:** infra · **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `deploy-self-hosted.md:83-91`; `migrate.Dockerfile:30`;
  `prisma-migrations.md:108-117` (reset is dev-only; no prod rollback section); grep for
  `rollback`/`revert` across runbooks returns nothing.
- **Observation (FACT):** Upgrading is `git pull && up -d --build` (`deploy-self-hosted.md:84-87`),
  which **rebuilds every image and re-runs the migrate job** (`migrate deploy && db seed`,
  `migrate.Dockerfile:30`). The runbook says "Back up the database before any update"
  (`deploy-self-hosted.md:91`) but does not enforce it. There is **no rollback procedure**: Prisma
  generates forward-only migrations (`prisma-migrations.md` has no down-migration concept), so if a
  new migration corrupts or mis-shapes data, the only recovery is restore-from-backup — which loops
  back to Finding #1/#2. Images are tagged `:dev` (`docker-compose.prod.yml:38,51,69`), so there is
  no version pinning and no way to roll back to a known-good image.
- **Why it matters:** "Grow into a large platform" means frequent schema changes. A generalist
  operator running `git pull && up -d` against `master` has no safety net: an interrupted migrate
  job, a bad migration, or an image regression can leave the DB half-migrated with no documented way
  back. `restart: "no"` on migrate (`:39`) means a failed migrate exits non-zero and the API simply
  never starts — but the runbook does not tell the operator how to diagnose or recover that.
- **Recommendation:** Write an **upgrade runbook**: (1) mandatory pre-upgrade backup (reuse the
  Finding #1 inventory); (2) pin to release tags instead of `:dev` and upgrade by bumping the tag;
  (3) a "migrate job failed" recovery section (read `logs migrate`, fix, re-run, or restore); (4)
  document that rollback = restore the pre-upgrade dump + redeploy the previous tag (forward-only
  migrations make this the supported path — state it explicitly so operators don't expect down
  migrations). Consider auto-snapshotting the DB inside the migrate job before `deploy` (PROPOSAL).

### 8. Secrets cannot be rotated without coordinated multi-service restarts, and there is no rotation runbook

- **Category:** security · **Severity:** medium · **Effort:** medium · **Confidence:** high
- **Location:** `0028-secrets-and-config.md:68-76` ("rotating a secret is manual");
  `deploy-self-hosted.md:45-49`; `.env.prod.example:14-20, 95-98`; `docker-compose.prod.yml:74-85`
- **Observation (FACT):** ADR-0028 chose `.env` files, accepting "rotating secrets is manual"
  (`0028:70-73`). The DB password appears in **two** places that must stay in sync — `POSTGRES_PASSWORD`
  and the password embedded in `DATABASE_URL` (`.env.prod.example:15,20`); rotating it requires
  editing both **and** running `ALTER USER` inside Postgres (the volume already has the old password
  baked in — Postgres only reads `POSTGRES_PASSWORD` on *first* init). `AUTH_SECRET` rotation
  invalidates all web sessions (`docker-compose.prod.yml:75`). The OIDC client secret lives in
  three vars (`OIDC_CLIENT_SECRET`, `AUTH_CLIENT_SECRET`, and the Zitadel console). No runbook
  describes any of this; the only rotation guidance is one sentence: "edit the file + `up -d`"
  (`deploy-self-hosted.md:48`), which is **wrong for the DB password** (won't change the actual
  Postgres role password).
- **Why it matters:** Sensitive Access data + no RBAC (every authed user is equal) makes credential
  hygiene the main compensating control. An operator told "edit the file and `up -d`" will believe
  they rotated the DB password when they did not, leaving the old one valid. Over years, no rotation
  procedure means leaked/departed-admin credentials are never cycled.
- **Recommendation:** Add a **secrets-rotation runbook** with per-secret steps: DB password
  (`ALTER USER … PASSWORD` → update both env occurrences → `up -d db api migrate`), `AUTH_SECRET`
  (warn: logs everyone out), OIDC secret (rotate in Zitadel console → update the 2 env vars →
  `up -d api web`), `ZITADEL_MASTERKEY` (state plainly: **not rotatable in place** — it decrypts the
  store). PROPOSAL: collapse the DB password to a single source by deriving `DATABASE_URL` from
  `POSTGRES_*` parts, or document the two-place sync prominently.

### 9. `.env.prod` is the master key to everything yet has loose host permissions and contains a reused weak credential in this checkout

- **Category:** security · **Severity:** medium · **Effort:** quick-win · **Confidence:** high
- **Location:** `.gitignore:2` (correctly ignores `.env*`); live file
  `infra/env/.env.prod:14-20`; perms via `stat`; runbooks instruct `chmod 600`
  (`deploy-self-hosted.md:31`, `.env.prod.example:6`).
- **Observation (FACT):** `infra/env/.env.prod` is correctly **gitignored** and **not tracked**
  (`git ls-files infra/env/` shows only `.env.prod.example`; `check-ignore` confirms). Good. But the
  on-disk file in this checkout has perms `0644` (`-rw-r--r--`) — world-readable — despite every
  runbook telling the operator to `chmod 600`. The same `0644` applies to root `.env` and
  `apps/api/.env`. The live `.env.prod` also contains a **reused, weak, personal-looking** credential
  (`POSTGRES_USER=joaqo` / `POSTGRES_PASSWORD=Argentina1!`, reused verbatim in `DATABASE_URL`,
  `.env.prod:14-20`) — a real-world anti-pattern the operator profile will replicate.
- **Why it matters:** This single file holds the DB password, `ZITADEL_MASTERKEY` (the DR linchpin),
  `AUTH_SECRET`, and OIDC secrets. World-readable, any local user or a compromised low-priv process
  can read every secret. The `chmod 600` instruction is documented but **not enforced** — exactly
  the "operator forgets a manual step" failure ADR-0028 acknowledges. (The weak credential is a
  local dev artifact, not committed, so informational — but it models the reuse pattern operators
  will copy.)
- **Recommendation:** (a) Have the compose/first-boot path **verify and warn** on `.env.prod` perms
  (a 5-line preflight in a `Makefile`/wrapper script, or a doc-prominent `stat` check). (b) In the
  first-boot runbook, lead with the `chmod 600` step and explain *why* (lists what the file
  protects). (c) Strengthen `.env.prod.example` guidance with a generated-password recipe for
  `POSTGRES_PASSWORD` like the ones already shown for the masterkey/`AUTH_SECRET`
  (`.env.prod.example:61,96`). Quick win.

### 10. Major doc drift: `deploy-self-hosted.md` still says "Auth is not implemented yet — do not expose on the public internet"

- **Category:** docs · **Severity:** medium · **Effort:** quick-win · **Confidence:** high
- **Location:** `deploy-self-hosted.md:15-19, 98-103`; contrast with the now-live auth stack in
  `docker-compose.prod.yml:115-155` and `auth-bootstrap.md`.
- **Observation (FACT):** The self-hosted deploy runbook's front-and-center warning reads: "Auth is
  not implemented yet … the `X-User-Id` shim is forgeable … **Do not expose this build on the public
  internet** until the IdP integration lands. Deploy it on a private network / VPN only"
  (`deploy-self-hosted.md:15-19`). It also has a "Reserved for later — the IdP" section claiming
  "No IdP is wired" (`:98-103`). But OIDC/Zitadel **is** wired and merged (ADR-0037/0038/0039,
  PR #58/#60); the compose runs Zitadel + the auth-bootstrap runbook exists. `infra/README.md:58-63`
  ("Not configured yet … No IdP is wired") is stale the same way.
- **Why it matters:** The **primary deploy runbook** actively tells operators the product is unsafe
  to expose and to keep it VPN-only — directly contradicting the shipped auth and undermining trust
  in the docs. An operator either (a) wrongly believes the app is unauthenticated and over-restricts
  it, or (b) notices the contradiction and stops trusting the runbooks entirely. The project's own
  rule is "docs stay in sync" (CLAUDE.md). This is the most visible drift in the ops docs.
- **Recommendation:** Rewrite the warning to reflect reality (auth is via OIDC/Zitadel; link
  `auth-bootstrap.md`), fold the bootstrap into the deploy sequence (auth must be configured before
  first real login), and delete/replace the "Reserved for later — the IdP" and `infra/README.md`
  "Not configured yet" sections. Quick win, high trust impact.

### 11. First-boot UX assumes auth is absent ("acting-user switcher … work the same as in dev") and lacks an end-to-end "first real login" walkthrough

- **Category:** infra · **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `docker-prod-like-first-boot.md:51-53`; verify steps `:44-49`;
  `deploy-self-hosted.md:77-80`
- **Observation (FACT):** The prod-like first-boot runbook's verify step hits `GET /api/users`
  expecting `[]` (`:47`) and says "The acting-user switcher and all screens work the same as in dev"
  (`:53`) — i.e. it assumes the unauthenticated shim. With the global JWT guard now active
  (ADR-0038), `GET /api/users` returns **401**, not `[]`, unless `AUTH_MODE=shim`. The deploy
  runbook's verify (`:77-80`) has the same assumption. There is no single first-boot path that
  walks: bring up stack → bootstrap Zitadel → create first user → log in via the web → see data.
- **Why it matters:** First-boot is where a generalist forms their judgment of the product. If the
  documented "expected 200 `[]`" check now returns 401, they think the install is broken. The
  three-pillar value (inventory/access/knowledge) is invisible until they can log in, and no doc
  stitches the auth bootstrap to the app bring-up into one happy path.
- **Recommendation:** Add a single **"first real login" end-to-end** section (or merge the first-boot
  + auth-bootstrap runbooks): update verify expectations for the guard (use `AUTH_MODE=shim` only for
  the headless smoke test, and document the 401 as the *correct* unauthenticated response), then walk
  through obtaining a token / logging into the web UI and confirming JIT user provisioning created
  the `User` row.

### 12. Zitadel pinned to v2.68.0 and Meili to v1.12.3 with no upgrade guidance; Zitadel does "aggressive schema migrations"

- **Category:** infra · **Severity:** low · **Effort:** small · **Confidence:** medium
- **Location:** `docker-compose.prod.yml:124` (`ghcr.io/zitadel/zitadel:v2.68.0`), `:163`
  (`getmeili/meilisearch:v1.12.3`); comment about Zitadel migrations at `:88-90`.
- **Observation (FACT):** Third-party images are pinned (good — reproducible), but no runbook
  explains how/when to upgrade Zitadel or Meili. The compose itself notes Zitadel "does aggressive
  schema migrations" (`:88-90`), which is the explicit reason it gets its own DB. Postgres is pinned
  `18-alpine` (app) and `16-alpine` (Zitadel) — **two different major versions** of Postgres in one
  stack (`:18` vs `:93`).
- **Why it matters:** Over a multi-year operation, the bundled Zitadel and Meili will accrue CVEs and
  fall out of support. An IT generalist will not track upstream release notes. A naive Zitadel major
  bump without reading its migration notes can break the IdP (its own warning), locking everyone out.
  Two Postgres majors also means two upgrade tracks and two `pg_upgrade` paths to reason about.
- **Recommendation:** Add an "Upgrading bundled components" subsection to the upgrade runbook
  (Finding #7): pin discipline, "always back up zitadel_db before a Zitadel bump, read its breaking
  changes, bump one minor at a time," and a note that Meili is safe to recreate (data is rebuildable
  via `reindex:all`). Consider aligning the Zitadel DB to Postgres 18 to reduce the matrix (PROPOSAL;
  verify Zitadel v2.68 supports PG18 first).

### 13. Postgres volume mount layout is version-specific and inconsistent between the two DBs (correct for 18, non-standard for 16)

- **Category:** infra · **Severity:** low · **Effort:** quick-win · **Confidence:** high
- **Location:** `docker-compose.prod.yml:23` (`db_data:/var/lib/postgresql`, postgres **18**) and
  `:105` (`zitadel_db_data:/var/lib/postgresql`, postgres **16**); same in dev
  `docker-compose.yml:11,51`.
- **Observation (FACT):** Verified against the official `postgres` image docs: **PostgreSQL 18+**
  changed `PGDATA` to a version-specific `/var/lib/postgresql/18/docker` and the **recommended mount
  is now `/var/lib/postgresql`** — so the app `db` mount (`:23`) is **correct and current**. But
  **PostgreSQL 17 and below** default `PGDATA` to `/var/lib/postgresql/data` and the recommended
  mount is `/var/lib/postgresql/data`. The Zitadel DB runs postgres **16** yet mounts the volume one
  level up at `/var/lib/postgresql` (`:105`). Data still persists (the `data/` subdir lands inside
  the mounted parent), so this is **not currently broken**, but it is non-standard for v16 and
  becomes a footgun on any version change.
- **Why it matters:** The two DBs use the *same* mount path string for *different* PGDATA semantics.
  An operator (or a future agent) who "fixes" them to match, or bumps the Zitadel DB to 17/18, can
  inadvertently relocate PGDATA and **lose the data dir** on recreation. It's a latent, silent
  data-loss trap that only triggers during the exact operation (upgrade) where it hurts most.
- **Recommendation:** Either bump `zitadel_db` to `postgres:18-alpine` (so both use the new layout
  and the `/var/lib/postgresql` mount is correct for both — PROPOSAL, verify Zitadel support), or add
  an inline comment on each volume line stating the PGDATA layout and that the mount must track the
  major version. Add a one-line note to the backups/upgrade runbooks. Quick win (a comment), but
  prevents a nasty surprise.

### 14. `migrate` job runs the seed on every deploy — harmless today but couples migrate with seeding as the platform grows

- **Category:** infra · **Severity:** low · **Effort:** quick-win · **Confidence:** medium
- **Location:** `migrate.Dockerfile:19-30`; `prisma/seed.ts:1-18`; idempotency note `seed.ts:1-7`
- **Observation (FACT):** The migrate one-shot runs `prisma migrate deploy && prisma db seed`
  (`migrate.Dockerfile:30`) on **every** `up`. The seed is idempotent (upserts by unique name,
  `update: {}`, `seed.ts:1-7`) so re-running is safe. The seed reads `DATABASE_URL` directly
  (`seed.ts:11-14`); under the Bun-based migrate image that is auto-loaded, and compose injects it
  via `env_file` (`docker-compose.prod.yml:40`), so this works. (FACT: fine today; a low-risk
  observation, not a bug.)
- **Why it matters:** Re-seeding on every deploy is harmless now but couples "apply migrations" with
  "insert default categories" — if the seed ever grows non-idempotent rows (e.g. a default admin),
  every redeploy would re-create or error. Worth a guardrail before the seed scope expands.
- **Recommendation:** Keep as-is for now; add a comment in `migrate.Dockerfile` that the seed **must
  stay idempotent** because it runs on every deploy, and revisit splitting "migrate" from "seed" if
  seed data becomes environment-specific. Quick documentation win.

### 15. No documented self-observability or "is it healthy?" operator surface; logs are stdout-only

- **Category:** infra · **Severity:** low · **Effort:** large · **Confidence:** medium
- **Location:** `main.ts:1-10` (Pino to stdout); no metrics endpoint in `apps/api/src`; no
  monitoring service in compose.
- **Observation (FACT):** Observability is Pino structured logs to stdout (ADR-0031) with
  X-Request-Id correlation — solid for debugging, but there is **no** metrics endpoint, no
  uptime/health dashboard, and no documented way for an operator to answer "is lazyit healthy right
  now?" beyond `docker compose ps`. The product is explicitly **not** monitoring/alerting (anti-goal),
  which correctly applies to *monitoring customer devices* — but says nothing about lazyit observing
  *itself*.
- **Why it matters:** Over years, the operator needs to know when a service is degraded *before* a
  user reports it. With no self-health surface, the first signal of trouble is a broken UI. This is a
  bigger bet, not urgent, but it's the difference between "operable" and "operable confidently."
- **Recommendation (PROPOSAL):** Defer heavy stacks (Prometheus/Grafana fight the small-team
  simplicity). Minimal path: the `/health/ready` endpoint from Finding #6 plus a documented one-liner
  the operator can curl/cron, and a short "How to tell if lazyit is healthy" runbook section listing
  the `ps`/`logs`/`/health` checks. Revisit a metrics endpoint only if demand appears. Keep it within
  the self-hosted, no-mandatory-cloud ethos.

---

## Quick wins (high value, < ~2 hours each)

1. **Add log rotation** (Finding #5): one shared `logging` anchor (`max-size: 10m`, `max-file: 3`)
   on every long-running service in `infra/docker-compose.prod.yml`. Prevents a guaranteed
   disk-fill outage over time.
2. **Fix the auth doc drift** (Finding #10): rewrite the "Auth is not implemented" warning in
   `deploy-self-hosted.md` and the "No IdP is wired" sections in `deploy-self-hosted.md` /
   `infra/README.md` to reflect the shipped OIDC/Zitadel stack; link `auth-bootstrap.md`.
3. **Expand the backup "what to back up" list** (Finding #1, partial): add Zitadel DB + the
   `ZITADEL_MASTERKEY`/`.env.prod` callout + "Meili is rebuildable" to `backups.md`, even before the
   full automation lands.
4. **Fix the `down -v` comment and restore path** (Finding #3): correct the inaccurate "removes
   db_data" comment and swap to targeted `docker volume rm lazyit-prod_db_data`.
5. **Enforce/verify `.env.prod` perms** (Finding #9): `chmod 600` the live file and add a perms-check
   note (or preflight) to the first-boot runbook; add a `POSTGRES_PASSWORD` generation recipe to the
   example.
6. **Comment the Postgres volume mounts** (Finding #13): note the version-specific PGDATA layout on
   the two `:/var/lib/postgresql` lines so no one relocates the data dir on an upgrade.
7. **Note seed-runs-every-deploy idempotency requirement** (Finding #14) in `migrate.Dockerfile`.

## Strategic recommendations (bigger bets, with sequencing)

1. **DR foundation first (Findings #1 → #3 → #2).** (a) Rewrite `backups.md` into a complete DR
   inventory + correct restore order (covers app DB, Zitadel DB, masterkey/env, Meili-is-rebuildable).
   (b) Fix the destructive restore path. (c) **Then** build the opt-in backup sidecar
   (`profiles: [backup]`, both DBs, retention, optional offsite hook). Sequence matters: an automated
   backup of an incomplete set (only the app DB) gives false confidence — define *what* and *how to
   restore* before automating *when*.
2. **Reliability hardening (Findings #6 → #4 → #5).** Add `/health` + `/health/ready` (DB ping),
   repoint the Docker/Caddy healthchecks at it, then add per-service resource limits and log
   rotation. Together these turn "green healthchecks that lie" into real liveness/readiness and
   protect the single host from one runaway service.
3. **Upgrade & rotation runbooks (Findings #7, #8, #12).** Write the upgrade runbook (release-tag
   pinning instead of `:dev`, mandatory pre-upgrade backup, migrate-failure recovery, forward-only
   rollback = restore-from-backup, bundled-component upgrade discipline) and the secrets-rotation
   runbook (per-secret steps; correct the wrong "edit + up -d" DB-password guidance). These unblock
   "grow into a large platform" by making frequent version changes safe for a generalist.
4. **First-boot happy path (Finding #11).** Merge/cross-link first-boot + auth-bootstrap into one
   end-to-end "stack up → IdP bootstrap → first login → see data" walkthrough with verify steps that
   match the active guard. Lowers time-to-value and first-impression failure rate.
5. **Self-observability (Finding #15), last.** Once `/health/ready` exists, add a thin "is it
   healthy?" runbook section; defer any metrics stack until there is real demand, to preserve the
   small-team simplicity.

## Open questions for the CTO/CEO

1. **Backup automation as shipped infra vs. operator's responsibility?** ADR-0028 deferred automation
   "until there's a real deployment." Auth is now live and the topology is real — do we ship an
   opt-in backup sidecar in `infra/` (my recommendation), or keep backups a documented manual
   procedure the operator must wire themselves? This is the single biggest "safe for years" decision.
2. **Offsite/object-storage backup target — how far without violating "no mandatory cloud"?**
   Should the sidecar support an optional `rclone`/S3-compatible push (off by default), or stay
   local-disk-only and leave offsite copies entirely to the operator?
3. **Resource limits & a published minimum-sizing spec — do you want to commit to numbers?** Naming a
   minimum host spec (e.g. 2 vCPU / 4 GB) is a support commitment. Are we ready to publish and stand
   behind sizing guidance, or keep it advisory?
4. **Release tagging / CD.** CD is deferred (ADR-0027) and images are `:dev`. Adopting versioned image
   tags (and eventually GHCR publishing) is the precondition for a safe rollback story. Is now the
   time, given the "grow into a platform" mandate and the upgrade-safety gap?
5. **`ZITADEL_MASTERKEY` rotation / escrow policy.** The masterkey is unrotatable-in-place and is the
   DR linchpin. Do we want a documented escrow procedure (e.g. sealed copy held off-host), and how do
   we communicate "lose this = lose all logins" to a non-security-trained operator?
6. **Align the two bundled Postgres majors (16 + 18)?** Bumping Zitadel's DB to Postgres 18 simplifies
   the volume-mount/upgrade matrix — acceptable to verify Zitadel v2.68 support and standardize, or
   keep them independent for blast-radius isolation?
