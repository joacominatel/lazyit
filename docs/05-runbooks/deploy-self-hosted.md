---
title: Deploy to a Self-Hosted Host
tags: [runbook, docker, deployment]
status: accepted
created: 2026-05-25
updated: 2026-05-30
---

# Runbook — deploy lazyit to a self-hosted host

Install lazyit on a single host (one company = one instance — [[0015-deployment-model]]) on a real
domain with publicly-trusted HTTPS. Same compose as the [[docker-prod-like-first-boot|prod-like
runbook]]; the differences are a real domain, real secrets, and backups.

> [!info] Auth is wired (OIDC via Zitadel)
> This build authenticates via OIDC against a bundled Zitadel IdP (ADR-0037/0038/0039). The API
> validates OIDC tokens behind a global guard; the web app uses Auth.js. **Bootstrap Zitadel and
> register the OIDC client before first real login** — follow [[auth-bootstrap]] (and the `OIDC_*`
> / `AUTH_*` vars in `.env.prod`). The legacy `X-User-Id` shim is dev-only (`AUTH_MODE=shim`) and
> must never be enabled in production.

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
> ./infra/start.sh            # interactive; choose 'real' deployment mode and answer ~6 questions
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

## 2. Bring it up

The stack is one canonical `compose.yaml` at the repo root plus a thin prod override; the full
containerized stack lives behind the `prod` profile ([[auth-zitadel-sot#9-compose-structure-decided|dossier §9]]).
Run from the **repo root**:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod ps          # all healthy; migrate exited 0
```

> [!note] Backward-compat — the old command is aliased
> The previous form `docker compose -f infra/docker-compose.prod.yml up -d --build` is **superseded**.
> It maps 1:1 to the new **base + thin override + `--profile prod` + `--env-file`** invocation above.
> The prod **project name is unchanged** (`lazyit-prod`), so existing volumes
> (`lazyit-prod_db_data`, `lazyit-prod_zitadel_db_data`, …) are reused — no data migration. Plain
> `docker compose up` (no `-f`) is now the **dev** backing-services stack (Postgres + Meilisearch +
> Zitadel for native `bun run dev`), not the full prod stack — see [[setup]].

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

```sh
git pull                                                       # or ship a new build/image
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml \
  --profile prod --env-file infra/env/.env.prod up -d --build  # rebuilds; migrate re-runs (deploy)
```

New migrations are applied automatically by the `migrate` job on the next `up` (it runs
`prisma migrate deploy` — never `migrate dev`/`reset` in production; [[prisma-migrations]]).
**Back up the database before any update** ([[backups]]).

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

> **Valkey** (ADR-0053) is the BullMQ broker for async workers (e.g. the async `.docx` import). It is
> lightweight (256 MB ceiling — mostly job metadata) and runs AOF persistence on the `valkey_data`
> volume so queued jobs survive a restart. It holds only in-flight job state — PostgreSQL is the system
> of record — so it is **not** a backup target (like Meilisearch, its volume is rebuildable); the
> `backup` sidecar only dumps the two Postgres DBs (see [[backups]]).

Build/boot problems → [[docker-build-troubleshooting]].

Related: [[deployment]] · [[docker-prod-like-first-boot]] · [[backups]] · [[prisma-migrations]] ·
[[0015-deployment-model]] · [[0026-reverse-proxy-tls]] · [[0028-secrets-and-config]] ·
[[0047-guided-first-deploy-bootstrap]]
