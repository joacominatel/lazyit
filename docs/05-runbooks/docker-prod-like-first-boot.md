---
title: Prod-like First Boot (Docker)
tags: [runbook, docker, deployment]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Runbook — bring up the prod-like stack locally

Run the **whole** lazyit stack in containers on your machine — Postgres + migrate + API + web
behind Caddy with local HTTPS — to validate a production-shaped deployment. Background:
[[deployment]], [[0025-containerization-strategy]], [[0026-reverse-proxy-tls]], [[0028-secrets-and-config]].

> [!note] This is *not* the dev workflow
> Day-to-day development uses the root `docker-compose.yml` (Postgres only) + `bun run dev`
> ([[setup]]). This runbook is the **containerized, prod-shaped** stack in `infra/`. It uses high
> ports (Caddy `8080`/`8443`) so it never clashes with dev (`3000`/`3001`/`5432`).

## Prerequisites

- Docker + Docker Compose (BuildKit recommended; the Dockerfiles also build on the legacy builder).
- The repo checked out. All commands run from the **repo root**.

## Steps

```sh
# 1. Create the prod env file from the template and fill in real values (replace every CHANGE_ME).
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod
#    Minimum to change: POSTGRES_PASSWORD and the password inside DATABASE_URL (must match).
#    For local prod-like, leave LAZYIT_SITE_ADDRESS=localhost and WEB_ORIGIN=https://localhost:8443.

# 2. Build images and start everything (db -> migrate -> api -> web -> caddy, ordered by health).
docker compose -f infra/docker-compose.prod.yml up -d --build

# 3. Watch it converge. migrate runs once and exits 0; api/web/db become healthy.
docker compose -f infra/docker-compose.prod.yml ps
docker compose -f infra/docker-compose.prod.yml logs -f migrate   # Ctrl-C after it exits
```

## Verify

```sh
# Web (Caddy serves the Next.js app). Caddy uses its internal CA locally -> -k accepts the cert.
curl -sko /dev/null -w "web: %{http_code}\n"      https://localhost:8443/
curl -sk            -w "\napi: %{http_code}\n"    https://localhost:8443/api/users      # -> []
curl -sko /dev/null -w "docs: %{http_code}\n"     https://localhost:8443/api/docs       # Swagger
```

Expected: `web: 200`, `api: 200` with `[]`, `docs: 200`. In a browser open
**https://localhost:8443** (accept / trust Caddy's local CA — see the troubleshooting runbook to
trust it and remove the warning). The acting-user switcher and all screens work the same as in dev.

> [!info] Migrations & seed run automatically
> The one-shot `migrate` service runs `prisma migrate deploy` then the idempotent seed
> ([[prisma-migrations]]). The API only starts after it exits successfully. Re-running `up` re-runs
> migrate (a no-op if there's nothing pending).

## Routine operations

```sh
docker compose -f infra/docker-compose.prod.yml logs -f api          # follow API logs
docker compose -f infra/docker-compose.prod.yml restart api          # restart one service
docker compose -f infra/docker-compose.prod.yml up -d --build        # rebuild after a code change
docker compose -f infra/docker-compose.prod.yml down                 # stop (keeps the db volume)
docker compose -f infra/docker-compose.prod.yml down -v              # stop AND delete data (clean slate)
```

## Teardown

`down` keeps the named `db_data` volume (your data survives). `down -v` removes the volumes —
use it only when you want a fresh database.

Problems building or booting? → [[docker-build-troubleshooting]]. Real deployment → [[deploy-self-hosted]].

Related: [[deployment]] · [[setup]] · [[prisma-migrations]] · [[0026-reverse-proxy-tls]]
