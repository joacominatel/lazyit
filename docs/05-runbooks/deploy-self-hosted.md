---
title: Deploy to a Self-Hosted Host
tags: [runbook, docker, deployment]
status: accepted
created: 2026-05-25
updated: 2026-07-03
---

# Runbook — deploy lazyit to a self-hosted host

Install lazyit on a single host (one company = one instance — [[0015-deployment-model]]) on a real
domain with publicly-trusted HTTPS. Same compose as the [[docker-prod-like-first-boot|prod-like
runbook]]; the differences are a real domain, real secrets, and backups.

> [!info] Auth mode — `local` is the default; OIDC/Zitadel is opt-in (ADR-0086)
> `AUTH_MODE` is a **three-state, explicit-required** setting: **`local`** (built-in accounts +
> passwords, no external IdP — the default the guided bootstrap writes), **`oidc`** (a bundled
> Zitadel IdP *or* your own BYOI IdP — ADR-0037/0038/0039), or `shim` (the dev-only `X-User-Id`
> bypass, **never** in production). There is **no implicit default at boot**: an unset `AUTH_MODE`
> is a hard boot failure — see the **upgrade note in §4** (existing OIDC installs must set
> `AUTH_MODE=oidc` before upgrading). In **OIDC** mode you additionally run the bundled Zitadel
> (the `oidc` compose profile + overlay, below) and bootstrap the OIDC client before first login
> ([[auth-bootstrap]]); in **local** mode there is no IdP to bootstrap — you go straight to `/setup`.

## Prerequisites

- A host (Linux) with Docker + Docker Compose and the repo (or a built artifact) on it.
- A DNS A/AAAA record pointing your domain at the host, reachable on **:80 and :443** *if* you want
  automatic Let's Encrypt certificates. On a private network, you can keep the internal CA instead.
- A backup location (see [[backups]]).

## 1. Configure environment & secrets

> [!tip] Recommended — let the guided bootstrap do steps 1 & 2
> The guided bootstrap script ([[0047-guided-first-deploy-bootstrap]]) automates this whole
> section: it asks for your domain, TLS choice + ACME email, ports, IdP (bundled Zitadel or BYOI)
> and Postgres (bundled or external), then **generates `infra/env/.env.prod` with real random
> secrets** (a correctly-sized `ZITADEL_MASTERKEY`, `POSTGRES_PASSWORD` mirrored into
> `DATABASE_URL`, `AUTH_SECRET`, …) in a file that is **mode 600 from creation** (the secrets are
> never world-readable, even for an instant), validates your free-text answers, and brings the stack
> up — then prints the URL and points you at `https://<your-domain>/setup`.
>
> ```sh
> ./infra/start.sh            # interactive; pick a network mode (lan | local | real) + answer ~6 questions
> ./infra/start.sh --reconfigure  # existing install: re-render .env.prod for a new host/port/mode, keep secrets
> ./infra/start.sh --dry-run  # preview: run all checks + prompts, write nothing, run no docker
> ```
>
> It is **idempotent and non-destructive** — re-running it on an existing install (an existing
> `.env.prod` **or** a `lazyit-prod_*` volume) **skips generation** and just brings the stack up; it
> **never** regenerates the unrotatable `ZITADEL_MASTERKEY` and has **no** teardown path. For
> **BYOI**, **external Postgres**, and **Let's Encrypt/HSTS** it writes the relevant env values and
> **prints** the one or two manual compose/Caddyfile edits to apply (it does not auto-edit those
> files — see the BYOI / Caddyfile notes in steps 1 & 2 below). After it finishes, continue at
> **§2a** (search re-index) and **§3a** (the in-app `/setup` first login).
>
> The rest of this section is the **manual fallback** — exactly what the script automates. Do it by
> hand if you want full control or to understand each value.

```sh
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod        # OWNER read/write only — see why below (ADR-0028)
```

> [!danger] `chmod 600 infra/env/.env.prod` is not optional
> This single file is the master key to everything: the DB password, the `ZITADEL_MASTERKEY`
> (the DR linchpin — see [[backups]]), `AUTH_SECRET`, and the OIDC client secret. The default
> `0644` is **world-readable** — any local user or a compromised low-privilege process can read
> every secret. Set `0600` (owner-only) and confirm with `stat -c '%a' infra/env/.env.prod` → `600`.
> Back the file up off-host, encrypted (it's gitignored and never committed).

Edit `infra/env/.env.prod`:

- `POSTGRES_PASSWORD` — a strong, unique password. **Never** the example value.
- `DATABASE_URL` — same password, host `db` (e.g. `postgresql://lazyit:<pw>@db:5432/lazyit?schema=public`).
- `LAZYIT_SITE_ADDRESS` — your FQDN (e.g. `lazyit.example.com`).
- `WEB_ORIGIN` — `https://lazyit.example.com` (no trailing slash).
- `LAZYIT_TLS_EMAIL` — your ops email, **and** uncomment the `email` line in `infra/caddy/Caddyfile`
  to enable Let's Encrypt. For a real public domain also uncomment `import hsts` in the Caddyfile
  site block (HSTS; never on a localhost/internal-CA install). (Skip both to keep Caddy's internal CA.)
- Ports: keep `LAZYIT_HTTP_PORT=80` / `LAZYIT_HTTPS_PORT=443` for a public host (override the
  high-port defaults), or keep the high ports behind another proxy.
- `LAZYIT_DOMAIN`, `ZITADEL_*`, `OIDC_*`, `AUTH_*` — auth (Zitadel IdP). Set strong values for
  `ZITADEL_DB_PASSWORD`, `ZITADEL_MASTERKEY` (≥32 chars), `ZITADEL_ADMIN_PASSWORD`, `AUTH_SECRET`;
  the `OIDC_*`/`AUTH_CLIENT_*` values are filled **after** the IdP bootstrap (step 3a, [[auth-bootstrap]]).

> [!info] Secrets handling
> `.env.prod` is gitignored and never committed. There is no Docker secrets block or external
> manager by decision ([[0028-secrets-and-config]]); protect the file with host permissions
> (`chmod 600`, above) and back it up out-of-band. Rotating *most* secrets = edit the file +
> `up -d` to recreate the affected services. **Exception — the DB password:** Postgres only reads
> `POSTGRES_PASSWORD` on *first* init, so editing the env file alone does **not** change the live
> role password. Rotate it with `ALTER USER ... PASSWORD ...` inside the `db` container, then update
> **both** `POSTGRES_PASSWORD` and the password embedded in `DATABASE_URL`, then `up -d db api migrate`.

## 1a. LAN / bare-IP deployment (no public domain)

Small IT teams often reach lazyit on the LAN by IP or a plain hostname, with no public DNS. There are
**two** ways to do this — pick one at install (Q1 of `infra/start.sh`, [[0087-plain-http-lan-deployment-axis]]):

### Option A — `lan` mode: plain HTTP, host-agnostic (recommended for a trusted LAN)

Choose **`lan`** at Q1. The script sets a **port-only** `LAZYIT_SITE_ADDRESS=:80`, so Caddy serves plain
HTTP for **any** Host on the published port (`LAZYIT_HTTP_PORT`, default 8080) — no TLS, no cert, no
browser warning. It sets `AUTH_TRUST_HOST=true` and leaves `WEB_ORIGIN` **unset**, so the app derives its
origin from whatever host/IP the browser used. **If the LAN IP changes (DHCP), the URL just follows — no
reconfigure needed.** Reach it at `http://<this-host>:8080`.

- **`lan` requires `AUTH_MODE=local`** (built-in accounts) — OIDC/Zitadel bakes a fixed `externalDomain`
  and can't be host-agnostic. The script forces this.
- **Security:** the login session travels **unencrypted** over the LAN. Use `lan` **only** on a network
  you trust; never expose it to the public internet. The **secret vault stays end-to-end encrypted**
  regardless (its passphrase never reaches the server — INV-10), so a sniffed session grants no vault
  access. For anything less than a physically-trusted LAN, use Option B (HTTPS) or a real domain.
- The reporting agent installs against the **plain-HTTP** origin (`--url http://<this-host>:8080`); no CA
  trust step is needed (there is no TLS). Since #1190 the installers **refuse a plain-http `--url` unless
  you pass `--allow-insecure-http`** (`-AllowInsecureHttp` on Windows) — the flag is the written
  acknowledgement that the agent binary (root/SYSTEM) and the SA token cross the LAN in cleartext, the
  token on every report. On a `lan`-mode deploy that is the same trade the login session already makes.

To change the port or switch modes later (or after an IP change on a **hostname**-pinned deploy), re-run:

```sh
./infra/start.sh --reconfigure   # re-render .env.prod for a new host/port/mode, preserving ALL secrets
```

`--reconfigure` re-asks the network mode / host / ports, keeps every secret (`WORKFLOW_SECRET_KEY`,
`SESSION_SIGNING_SECRET`, `AUTH_SECRET`, `SMTP_SECRET_KEY`, DB creds — never regenerated) and the auth mode + Postgres
topology, touches **no** volumes, and brings the stack back up. It is supported for **local-auth installs
only** (an OIDC deploy's IdP `externalDomain` is baked at first boot and can't be re-homed by re-rendering
env — edit `.env.prod` by hand and re-provision Zitadel instead). Existing browser sessions from before
the reconfigure go stale and self-heal to `/login` on their next request — the script's post-up guidance
notes this; no other action needed.

### Option B — HTTPS on a bare IP (internal CA)

Prefer encrypted sessions on the LAN? Choose **`local`**/**`real`** and set `LAZYIT_SITE_ADDRESS` to the
bare IP or LAN hostname. This works out of the box: Caddy's
`default_sni` (issue #1010/#1011, `infra/caddy/Caddyfile`) presents the site certificate even when
the client sends no SNI — which is the bare-IP case, since TLS SNI is a hostname field and neither
browsers nor curl/OpenSSL send an IP literal as SNI (RFC 6066). A bare-IP deploy keeps Caddy's
**internal CA** — do not set `LAZYIT_TLS_EMAIL` / uncomment Let's Encrypt against an IP, it needs a
real hostname.

1. Set `LAZYIT_SITE_ADDRESS` (and `WEB_ORIGIN`) to the LAN IP or hostname operators will actually
   type (e.g. `192.168.1.50` or `lazyit.lan`). Leave `LAZYIT_TLS_EMAIL` unset to keep the internal CA.
2. Bring the stack up as in **§2** below. Browsers show a self-signed-CA warning the first time —
   click through it, or trust the CA per-machine as in the next step.
3. **Before installing the reporting agent** ([[0074-server-reporting-agent]]) **on any LAN host**,
   trust Caddy's internal CA on that host — otherwise the installer's `curl -f` rejects the
   certificate as untrusted and the install fails closed (it does not silently skip verification).
   Run the bundled helper on the agent host itself (Linux and macOS are both supported):

   ```sh
   ./infra/trust-local-ca.sh          # extracts Caddy's current root CA and trusts it (sudo)
   ```

   Re-run it after any `down -v` / volume reset — Caddy mints a new root then, and the script
   removes the stale one first (`--untrust` reverts it). See the script's own `--help`.
4. Run the agent install command from the **Add agent** wizard as usual, with `--url` set to the
   **HTTPS origin from step 1** (the Caddy front, e.g. `https://192.168.1.50`) — never the raw web
   port `:3000`, which has no `/api` routing and 302s to `/login` (issue #980; the installer now
   hard-fails on that instead of installing the redirect page as the binary).

## 2. Bring it up

The stack is one canonical `compose.yaml` at the repo root plus a thin prod override; the full
containerized stack lives behind the `prod` profile ([[auth-zitadel-sot#9-compose-structure-decided|dossier §9]]).
Run from the **repo root**. **Which command depends on `AUTH_MODE`** (ADR-0086):

**Local-auth mode (`AUTH_MODE=local` — the default):** plain `--profile prod`, no Zitadel.

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod ps          # all healthy; migrate exited 0
```

**OIDC mode with the bundled Zitadel (`AUTH_MODE=oidc`):** add the **`oidc` overlay + profile** so the
`zitadel*` services come up and the api/web wait on the `zitadel-bootstrap` sidecar. (BYOI — your own
external IdP — stays on the plain local command above: it uses your `OIDC_*` creds and starts no
bundled Zitadel.)

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml -f infra/docker-compose.oidc.yaml \
  --profile prod --profile oidc --env-file infra/env/.env.prod up -d --build
```

> [!note] Why the extra overlay (ADR-0086)
> The `zitadel`, `zitadel_db`, `zitadel-secrets-init` and `zitadel-bootstrap` services carry a **bare
> `profiles: [oidc]`**, so they only start under `--profile oidc`. `infra/docker-compose.oidc.yaml`
> carries the api/web → `zitadel-bootstrap` `depends_on` (and the backup → `zitadel_db` gate + the
> Caddy `auth.{domain}` site mount). Those edges **cannot** live in the base file: an active service
> depending on a profile-excluded one makes plain `--profile prod` a parse-fatal *"invalid compose
> project"*. The guided `infra/start.sh` picks the right invocation for you from your chosen mode.

> [!note] Backward-compat — the old command is aliased
> The previous form `docker compose -f infra/docker-compose.prod.yml up -d --build` is **superseded**.
> It maps 1:1 to the new **base + thin override + `--profile prod` + `--env-file`** invocation above.
> The prod **project name is unchanged** (`lazyit-prod`), so existing volumes
> (`lazyit-prod_db_data`, `lazyit-prod_zitadel_db_data`, …) are reused — no data migration. Plain
> `docker compose up` (no `-f`) is now the **dev** backing-services stack (Postgres + Meilisearch +
> Zitadel for native `bun run dev`), not the full prod stack — see [[setup]].

> [!note] Version identity ([[0083-versioning-and-releases]])
> The guided `infra/start.sh` exports `LAZYIT_VERSION=$(git describe --tags --always)` and
> `LAZYIT_GIT_SHA=$(git rev-parse --short HEAD)` before `up`, so the api/web images bake the running
> version (shown on **Settings → Instance** and by `GET /instance/version`). When running the compose
> command **by hand**, export both first — otherwise the build honestly reports `dev`/`unknown`:
>
> ```sh
> export LAZYIT_VERSION=$(git describe --tags --always) LAZYIT_GIT_SHA=$(git rev-parse --short HEAD)
> ```

Caddy obtains a certificate automatically (Let's Encrypt for a public FQDN on :443, or its internal
CA otherwise). The one-shot `migrate` service applies migrations and seeds before the API starts.

## 2a. Populate search indices (first deploy only)

After the stack is healthy (all services up, `migrate` exited 0), run the full re-index once to
populate Meilisearch with existing data ([[0035-search-architecture]]):

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
```

> [!important] Run reindex via the `migrate` job, not the API container
> The API **runtime** image is minimal Node (`node:26-alpine`) — it has **no Bun** and ships only
> compiled `dist/`, so `exec api bun run reindex:all` fails (no `bun`, no `.ts`). The `migrate`
> image is Bun-based and carries the script + the generated Prisma client, so the one-off
> `run --rm migrate bun run reindex:all` runs the standalone reindex (it gets `DATABASE_URL` and
> `MEILI_*` from `.env.prod` and exits when done).

This is a one-time step on first deploy, or after adding Meilisearch to an existing instance.
Subsequent deploys do not need it — the API keeps Meili in sync incrementally. The API's
`SearchService` is fail-soft: if Meilisearch is unreachable, search calls no-op and the app
continues to function ([[0035-search-architecture]]).

> [!tip] Drift now self-heals on a timer (no manual reindex between deploys)
> A fire-and-forget sync dropped while Meili is momentarily down leaves that index drifted from the
> DB. The API runs a **periodic drift-reconcile sweeper** that rebuilds every index from the live DB
> set (the same zero-downtime swap as `reindex:all`), so such drift repairs itself automatically —
> default **hourly**, tunable via `SEARCH_RECONCILE_INTERVAL_MS` (milliseconds) in `.env.prod`
> ([[0035-search-architecture]] amendment 2026-06-14, issue #383). `reindex:all` above stays the
> first-deploy backfill and the deterministic big-hammer recovery after a long outage; the sweeper
> handles ongoing drift in between. The sweep is `unref`'d (never holds the process open) and
> fail-soft (a reconcile error never crashes the API).

## 3. Verify

```sh
curl -so /dev/null -w "web:    %{http_code}\n" https://lazyit.example.com/
curl -so /dev/null -w "health: %{http_code}\n" https://lazyit.example.com/api/health/live   # expect 200
curl -so /dev/null -w "api:    %{http_code}\n" https://lazyit.example.com/api/users          # expect 401
```

`GET /api/health/live` is the public liveness endpoint (200; the Docker/compose healthchecks use
it). `GET /api/users` now returns **401** unauthenticated — that is the *correct* response with the
global OIDC guard active (ADR-0038), not a broken install. To see data, bootstrap the IdP and log
in via the web UI.

## 3a. Bootstrap auth & first login

Auth is OIDC via the bundled Zitadel IdP. **Before the first real login**, register the OIDC client
and create your first user, then fill the `OIDC_*` / `AUTH_*` values in `.env.prod` and `up -d`.
Full procedure: **[[auth-bootstrap]]**. JIT provisioning creates the `User` row on first login.

## 4. Updating to a new version

Releases are the `vX.Y.Z` tags + GitHub Releases cut on every dev→master promotion
([[0083-versioning-and-releases]]): a **patch/minor** is one-click-safe; a **major** requires reading
the Release's *⚠️ Upgrade actions* section first. Check the running version on **Settings →
Instance** before and after.

> [!note] Support is latest-only, and version jumps are safe ([[0083-versioning-and-releases]] amendment)
> Only the newest `vX.Y.Z` is supported — stay current; there is no LTS branch or backporting. You can jump
> across several versions at once (e.g. `1.2 → 1.9`) in **one** update: the `migrate` job runs
> `prisma migrate deploy`, which applies every pending migration **in sequence** ([[prisma-migrations]]), so
> you never step through intermediate versions by hand. The **only** stop is a **major** in the range — apply
> its *⚠️ Upgrade actions* before jumping past it. The guided **`infra/update.sh`**
> ([[0084-update-awareness-and-guided-update]]) automates the pull → verified dual backup → `verify-tag` →
> build → migrate → health-gate sequence and blocks one-click across a major.

> [!note] Deprecation policy ([[0083-versioning-and-releases]] amendment)
> Anything user- or operator-facing (an endpoint, a config/env var, an import/export format) is
> **deprecated in a MINOR** — announced in that release's notes as "deprecated, will be removed in X.0" and
> still working — and **removed only in the next MAJOR** (listed in that major's *⚠️ Upgrade actions*). Watch
> the release notes for deprecations so a major never removes something you still rely on unannounced.

```sh
git pull                                                       # or `git fetch --tags && git checkout vX.Y.Z`
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build  # rebuilds; migrate re-runs (deploy)
```

New migrations are applied automatically by the `migrate` job on the next `up` (it runs
`prisma migrate deploy` — never `migrate dev`/`reset` in production; [[prisma-migrations]]).
**Back up the database before any update** ([[backups]]).

> [!danger] Upgrade note — set `AUTH_MODE=oidc` BEFORE upgrading an existing OIDC install (ADR-0086)
> This release adds a third auth mode (`local`) and makes **`AUTH_MODE` explicit-required**: an
> **unset** `AUTH_MODE` used to imply OIDC, but it is now a **hard boot failure** (a silent "unset ⇒
> local" flip would have taken every OIDC instance offline). Deployments created before this release
> have **no `AUTH_MODE` line** in `.env.prod`, so add it **before** you pull-and-`up`:
>
> ```sh
> grep -q '^AUTH_MODE=' infra/env/.env.prod || echo 'AUTH_MODE=oidc' >> infra/env/.env.prod
> ```
>
> Then bring the stack up with the **OIDC command** (the `-f infra/docker-compose.oidc.yaml`
> `--profile oidc` variant in §2) — the bundled `zitadel*` services now live behind the `oidc`
> profile and will not start under a plain `--profile prod`. Your existing `ZITADEL_*` / `OIDC_*` /
> `AUTH_*` values and `lazyit-prod_*` volumes are untouched; the deploy is otherwise byte-identical.
> (The guided `infra/start.sh` detects the mode from your `.env.prod` and picks the command for you.)

> **Upgrade note — `REDIS_URL` is required (ADR-0053).** Deployments created **before** the async-workers
> release have a `.env.prod` that predates `REDIS_URL`. The guided `start.sh` only writes it on a
> **fresh** render — it never edits an existing `.env.prod` — so after pulling, add it by hand and
> recreate the api container:
>
> ```sh
> grep -q '^REDIS_URL=' infra/env/.env.prod || echo 'REDIS_URL=redis://valkey:6379' >> infra/env/.env.prod
> docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
>   --env-file infra/env/.env.prod up -d api
> ```
>
> Without it the api falls back to `redis://127.0.0.1:6379` (itself, no Valkey there). The api no
> longer floods on this misconfig — it logs the resolved URL (redacted) at boot, bounds reconnection,
> and 503s the import instead of hanging — but async import stays broken until `REDIS_URL` is set
> (issue #257). See **[[docker-build-troubleshooting]]** for the symptom/diagnosis.

> **Upgrade note — `WORKFLOW_SECRET_KEY` before enabling the Applications Workflow Engine (ADR-0054).**
> The engine encrypts its connector credentials (`WorkflowSecret`, AES-256-GCM) with this key and
> **fails loud at boot** if it is enabled while the key is missing or the wrong length. As with
> `REDIS_URL` above, the guided `start.sh` only writes it on a **fresh** render — a `.env.prod` that
> predates the engine has no such line — so add it by hand before turning the engine on:
>
> ```sh
> grep -q '^WORKFLOW_SECRET_KEY=' infra/env/.env.prod \
>   || echo "WORKFLOW_SECRET_KEY=$(openssl rand -hex 32)" >> infra/env/.env.prod   # 32 bytes -> 64 hex chars
> docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
>   --env-file infra/env/.env.prod up -d api
> ```
>
> Treat this key like `ZITADEL_MASTERKEY`: it is **unrotatable and irreplaceable** — a DB restore
> without the *matching* key yields undecryptable connector credentials. Back it up off-host (it lives
> in `.env.prod`; see **[[backups]]**). Do **not** generate a fresh one on a restore.

> **Upgrade note — `SMTP_SECRET_KEY` on a `.env.prod` that predates it (ADR-0079, issue #1269).**
> The instance SMTP password is encrypted at rest under this key. It is **optional at boot** — the API
> starts fine without it and an *unauthenticated* relay keeps working — but saving an SMTP **password**
> returns a clean **409 and stores nothing at all** (the encrypt runs *before* the upsert, so the whole
> save is rejected, not partially applied). A guided install now generates the key, and `--reconfigure`
> adds it to a file that lacks one while preserving every other secret. To do it by hand instead:
>
> ```sh
> grep -q '^SMTP_SECRET_KEY=' infra/env/.env.prod \
>   || echo "SMTP_SECRET_KEY=$(openssl rand -hex 32)" >> infra/env/.env.prod   # 32 bytes -> 64 hex chars
> docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
>   --env-file infra/env/.env.prod up -d api
> ```
>
> The `grep -q` guard is the point: an **already-present** key must never be replaced — it decrypts the
> SMTP password already stored, and a fresh one silently orphans it (re-enter the password to recover).
> Unlike `WORKFLOW_SECRET_KEY` this is **not** a DR linchpin: the worst case is one re-typed password.

> **Upgrade note — attachments storage: fix a pre-existing root-owned volume (#1019).** The api
> image now creates `/app/attachments` owned by `node` before the runtime `USER node` switch, so
> Docker seeds the `*_attachments_data` named volume with the right ownership on first mount. A
> stack that booted **before** this fix has an already-created, root-owned (and empty — uploads
> never worked) volume; Docker only applies ownership at first mount into an *empty* volume, so
> pulling the fix alone won't repair it. Run this **once** after upgrading:
>
> ```sh
> docker run --rm -v lazyit-prod_attachments_data:/v alpine chown -R 1000:1000 /v
> ```

## 5. Backups & disaster recovery

Configure backups before real use — see **[[backups]]**. The prod stack has **two** databases (the
app DB **and** Zitadel's), and the DR linchpin `ZITADEL_MASTERKEY` lives in `infra/env/.env.prod`:
back up **both** DBs **and** `.env.prod` off-host, or "restored the backup, nobody can log in." An
opt-in `backup` profile sidecar automates the two DB dumps with retention (see [[backups]]).

## 6. Resource sizing & limits

The compose file sets a modest `mem_limit`/`cpus` per service (and `logging:` rotation so logs can't
fill the disk). They cap a runaway service from OOM-ing the host; tune them to your box. The stack
runs **eight** long-running containers (db, api, web, zitadel, zitadel_db, meilisearch, valkey, caddy)
plus the one-shot migrate. Suggested minimum host for a small team (≤50 assets): **2 vCPU / 4 GB RAM /
20 GB disk**, growing with data and search volume. Watch `docker stats` and raise the limits if a
service is constrained.

> **`api` `mem_limit` vs the sandboxed import child (OPS-5/SEC-002).** The async `.docx` import runs
> in a **forked sandboxed child** whose V8 heap is capped at `IMPORT_CHILD_HEAP_MB` (default **256m**;
> `apps/api/src/articles/import/import-job.constants.ts`) so a decompression bomb makes the *child's*
> V8 abort while the API process survives. That isolation only holds if the **child OOMs before the
> api container's cgroup does**. Invariant (worker concurrency = 1):
>
> ```
> api mem_limit  >  NestJS baseline RSS (~250m)  +  IMPORT_CHILD_HEAP_MB
> ```
>
> The api ceiling is therefore **768m** (256m heap → ~506m floor; 512m was too tight and would let the
> kernel OOM-killer take the whole API instead of just the child). If you raise `IMPORT_CHILD_HEAP_MB`
> for genuinely large documents, raise `api` `mem_limit` to keep the headroom; if you must shrink
> `mem_limit`, lower the heap cap to match. Keep the two coupled.

> **Valkey** (ADR-0053) is the BullMQ broker for async workers (e.g. the async `.docx` import). It is
> lightweight (256 MB ceiling — mostly job metadata) and runs AOF persistence on the `valkey_data`
> volume so queued jobs survive a restart. It holds only in-flight job state — PostgreSQL is the system
> of record — so it is **not** a backup target (like Meilisearch, its volume is rebuildable); the
> `backup` sidecar only dumps the two Postgres DBs (see [[backups]]).

Build/boot problems → [[docker-build-troubleshooting]].

Related: [[deployment]] · [[docker-prod-like-first-boot]] · [[backups]] · [[prisma-migrations]] ·
[[0015-deployment-model]] · [[0026-reverse-proxy-tls]] · [[0028-secrets-and-config]] ·
[[0047-guided-first-deploy-bootstrap]]
