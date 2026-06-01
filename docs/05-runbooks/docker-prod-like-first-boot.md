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
> Day-to-day development uses the root `compose.yaml` + auto-loaded `compose.override.yaml` (backing
> services: db + meili + zitadel) + `bun run dev` ([[setup]]). This runbook is the **containerized,
> prod-shaped** stack (`compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`). It uses
> high ports (Caddy `8080`/`8443`) so it never clashes with dev (`3000`/`3001`/`5432`).

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

# 2. Build images and start everything. Set a DC alias once for the long prod invocation.
#    Boot order (by health): db -> migrate -> zitadel -> zitadel-bootstrap -> api -> web -> caddy.
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC up -d --build

# 3. Watch it converge. migrate + zitadel-bootstrap each run once and exit 0; api/web/db become healthy.
$DC ps
$DC logs -f migrate            # Ctrl-C after it exits
$DC logs -f zitadel-bootstrap  # the zero-touch Zitadel provisioner (ADR-0043 §4); ends "DONE …", exit 0
```

## Verify

```sh
# Web (Caddy serves the Next.js app). Caddy uses its internal CA locally -> -k accepts the cert.
curl -sko /dev/null -w "web:    %{http_code}\n"   https://localhost:8443/
curl -sko /dev/null -w "health: %{http_code}\n"   https://localhost:8443/api/health/live  # -> 200
curl -sko /dev/null -w "api:    %{http_code}\n"   https://localhost:8443/api/users         # -> 401
curl -sko /dev/null -w "docs:   %{http_code}\n"   https://localhost:8443/api/docs          # Swagger
```

Expected: `web: 200`, `health: 200`, `docs: 200`, and `api: 401`. The **401 is correct**: the
global OIDC guard is active (ADR-0038), so `/api/users` rejects unauthenticated calls — it is not a
broken install. To see data you must bootstrap Zitadel and log in via the web UI
([[auth-bootstrap]]); JIT provisioning creates your `User` row on first login. In a browser open
**https://localhost:8443** (accept / trust Caddy's local CA — see the troubleshooting runbook).

> [!info] Migrations & seed run automatically
> The one-shot `migrate` service runs `prisma migrate deploy` then the idempotent seed
> ([[prisma-migrations]]). The API only starts after it exits successfully. Re-running `up` re-runs
> migrate (a no-op if there's nothing pending).

## Routine operations

```sh
# (reuse the DC alias from above)
$DC logs -f api          # follow API logs
$DC restart api          # restart one service
$DC up -d --build        # rebuild after a code change
$DC down                 # stop (keeps ALL volumes)
$DC down -v              # stop AND delete ALL volumes (incl. zitadel_db_data; see auth-bootstrap §0b
                         # for a clean re-bootstrap, which ALSO removes the zitadel_secrets volume)
```

## Teardown

`down` keeps every named volume (your data survives). `down -v` removes **all five** volumes —
`db_data`, `zitadel_db_data` (the whole IdP: users + OIDC client), `meili_data`, `caddy_data`,
`caddy_config` — a full clean slate. Use it for a local reset only. To restore a real deployment do
**not** use `down -v`: remove just the targeted volume (`docker volume rm lazyit-prod_db_data`) —
see [[backups]].

Problems building or booting? → [[docker-build-troubleshooting]]. Real deployment → [[deploy-self-hosted]].

Related: [[deployment]] · [[setup]] · [[prisma-migrations]] · [[0026-reverse-proxy-tls]]
