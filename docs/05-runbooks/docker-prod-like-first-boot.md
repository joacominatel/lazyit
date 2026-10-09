---
title: Prod-like First Boot (Docker)
tags: [runbook, docker, deployment]
status: accepted
created: 2026-05-25
updated: 2026-10-09
---

# Runbook — bring up the prod-like stack locally

Run the **whole** lazyit stack in containers on your machine — Postgres + migrate + API + web
behind Caddy with local HTTPS — to validate a production-shaped deployment. Background:
[[deployment]], [[0025-containerization-strategy]], [[0026-reverse-proxy-tls]], [[0028-secrets-and-config]].

> [!note] This is *not* the dev workflow
> Day-to-day development uses the root `compose.yaml` + auto-loaded `compose.override.yaml` (backing
> services: db + meili + valkey) + `bun run dev` ([[setup]]). This runbook is the **containerized,
> prod-shaped** stack (`compose.yaml` + `infra/docker-compose.prod.yaml` + `--profile prod`). It uses
> high ports (Caddy `8080`/`8443`) so it never clashes with dev (`3000`/`3001`/`5432`).

## Prerequisites

- Docker + Docker Compose (BuildKit recommended; the Dockerfiles also build on the legacy builder).
- The repo checked out. All commands run from the **repo root**.

## Recommended — the guided bootstrap (`infra/start.sh`)

The fastest, safest first boot is the guided bootstrap script ([[0047-guided-first-deploy-bootstrap]]).
It detects your environment, asks a few questions, generates `infra/env/.env.prod` with **real random
secrets** (including the unrotatable `WORKFLOW_SECRET_KEY`) in a file that is **mode 600 from creation**
(secrets are never world-readable, even briefly), and brings the stack up
— then points you at the in-app `/setup` wizard. It is **idempotent and non-destructive**: re-running
it on an existing install skips generation and just brings the stack up (appending only missing keys
from its allowlist of safely generatable ones — see [[deploy-self-hosted]] and ADR-0047's 2026-09-26
amendment).

```sh
./infra/start.sh            # interactive, guided
./infra/start.sh --yes      # non-interactive localhost defaults (smoke test; aborts if 8080/8443 busy)
./infra/start.sh --dry-run  # run all checks + prompts, but write nothing and don't run docker
./infra/start.sh --help
```

For a local prod-like smoke test, accept the defaults (network mode `local`, built-in accounts,
bundled Postgres). The script ends by printing the public URL and the single next step: **open
`https://localhost:8443/setup`** to create the first ADMIN. It does **not** create any user (that is
the wizard's job) and calls no IdP. To try OIDC instead, answer `byoi` and point it at an IdP you run
([[auth-bootstrap]]).

> [!warning] Back up `infra/env/.env.prod` off-host
> The script generates the unrotatable `WORKFLOW_SECRET_KEY` into this file. Copy it off-host
> (encrypted) — lose it and the connector credentials in a restored backup are undecryptable (see
> [[backups]]). The script never tears anything down; a destructive reset is the manual `down -v` op
> documented under **Teardown**.

Prefer to do it by hand (or to understand exactly what the script writes)? The manual steps below are
the explicit fallback — the script automates precisely these.

## Steps (manual — the explicit fallback)

```sh
# 1. Create the prod env file from the template and fill in real values (replace every CHANGE_ME).
cp infra/env/.env.prod.example infra/env/.env.prod
chmod 600 infra/env/.env.prod
#    Minimum to change: POSTGRES_PASSWORD and the password inside DATABASE_URL (must match),
#    WORKFLOW_SECRET_KEY, AUTH_SECRET, MEILI_MASTER_KEY, and SESSION_SIGNING_SECRET (uncomment it —
#    AUTH_MODE=local needs it). For local prod-like keep WEB_ORIGIN=https://localhost:8443.
#    `./infra/start.sh` generates all of these.

# 2. Build images and start everything. Set a DC alias once for the long prod invocation.
#    Boot order (by health): db -> migrate -> api -> web -> caddy.
DC="docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod"
$DC up -d --build

# 3. Watch it converge. migrate runs once and exits 0; api/web/db become healthy.
$DC ps
$DC logs -f migrate            # Ctrl-C after it exits
```

## Verify

```sh
# Web (Caddy serves the Next.js app). Caddy uses its internal CA locally -> -k accepts the cert.
curl -sko /dev/null -w "web:    %{http_code}\n"   https://localhost:8443/
curl -sko /dev/null -w "health: %{http_code}\n"   https://localhost:8443/api/health/live  # -> 200
curl -sko /dev/null -w "api:    %{http_code}\n"   https://localhost:8443/api/users         # -> 401
curl -sko /dev/null -w "docs:   %{http_code}\n"   https://localhost:8443/api/docs          # -> 404 (SEC-009)
```

Expected: `web: 200`, `health: 200`, `api: 401`, and `docs: 404`. Two of these are *intended*, not
breakage. The **401** is correct: the global auth guard is active, so `/api/users` rejects
unauthenticated calls. The **404 on `/api/docs`** is also correct: Swagger is deliberately **not**
served on the public origin (SEC-009) — Caddy no longer forwards `/api/docs*`, so the path strips to
`/docs*`, which the API doesn't route. The docs remain reachable on the internal Docker network and in
local dev; they are not a broken install. To see data, open **https://localhost:8443** in a browser
(accept / trust Caddy's local CA — see the troubleshooting runbook): a fresh instance routes you to the
in-app **`/setup` wizard**, which creates the first ADMIN; then sign in at `/login`.

> [!note] First-run gate: visiting `/` redirects to `/setup` on a fresh instance
> On a clean deploy (no ADMIN yet), the proxy (`proxy.ts`) asks `GET /api/config/status` on every
> unauthenticated page navigation. If the API reports `isConfigured: false`, the visitor is
> redirected to `/setup`. This requires the web container to reach the API over the Docker-internal
> network (`http://api:3001`) — which `INTERNAL_API_URL` (set in `compose.yaml`) provides. Without
> it, Node's `fetch` would receive a relative `/api` URL, throw, and the gate would **fail open**
> (the marketing landing would show instead of the wizard). The same var is used by SSR server
> components (the marketing landing CTA). It is a **runtime** env var (not a build arg) and is
> never exposed to the browser bundle.

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
$DC down -v              # stop AND delete ALL volumes (see Teardown)
```

## Teardown

`down` keeps every named volume (your data survives). `down -v` removes **all six** volumes —
`db_data`, `meili_data_v1_53_2`, `valkey_data`, `attachments_data`, `caddy_data`, `caddy_config` — a
full clean slate. Use it for a local reset only. To restore a real deployment do
**not** use `down -v`: remove just the targeted volume (`docker volume rm lazyit-prod_db_data`) —
see [[backups]].

Problems building or booting? → [[docker-build-troubleshooting]]. Real deployment → [[deploy-self-hosted]].

Related: [[deployment]] · [[setup]] · [[prisma-migrations]] · [[0026-reverse-proxy-tls]] ·
[[0047-guided-first-deploy-bootstrap]]
