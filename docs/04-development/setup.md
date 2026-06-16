---
title: Local Setup
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-06-16
---

# Local Setup

Get lazyit running on your machine. Verified against the repo as of 2026-05-30.

## Prerequisites

- **Bun** `1.3.x` (repo pins `bun@1.3.14`) — package manager and runtime.
- **Docker** + Docker Compose — for the PostgreSQL dev database.
- **Node** available on PATH — some CLIs still expect it (see [[stack]]).

## Quick start — one command (recommended)

The fastest path is the **`dev-setup` script** (`scripts/dev-setup.ts`, issue #483). It automates the
whole bring-up — backing services, migrate/generate/seed, the Zitadel + OIDC bootstrap, and the
`apps/{web,api}/.env` wiring — into one command, with two modes:

```bash
bun install                  # 1. install all workspace dependencies
cp .env.example .env         # 2. root env only: POSTGRES_*, MEILI_MASTER_KEY, ZITADEL_* (dev IdP)

# 3a. FIRST TIME (or a clean slate) — wipes dev volumes, rebuilds, bootstraps Zitadel, wires env:
bun run dev:fresh            # destructive: prompts for a typed "yes" (use --yes to skip in CI)

# 3b. EVERY DAY AFTER — services up + a fresh Prisma client, then start the apps:
bun run dev:up              # assumes dev:fresh ran before (Zitadel already bootstrapped)
```

Both modes end by running `bun run dev` (web → :3000, api → :3001). Pass `--no-start` to do all the
prep but stop before starting the apps (useful in CI/tests):
`bun scripts/dev-setup.ts --fresh --yes --no-start`.

> [!info] What `dev:fresh` does (and what it touches)
> It mirrors the prod zero-touch bootstrap for dev — **idempotent and fail-loud**. In order:
> 1. **removes the dev Docker volumes** (`lazyit_{db_data,zitadel_db_data,zitadel_secrets,meili_data,valkey_data}`) — this is the destructive step it asks you to confirm;
> 2. `docker compose up -d` — the `compose.override.yaml` `zitadel-secrets-init-dev` chmods the
>    secrets volume so Zitadel no longer crash-loops on a fresh volume (#477);
> 3. waits for `db` healthy + Zitadel `/debug/healthz` 200;
> 4. `prisma migrate deploy` → **`prisma generate`** (explicit — `migrate deploy` does NOT regenerate
>    the client, and a stale client breaks the API boot, #480) → `prisma db seed`;
> 5. **reuses `infra/scripts/zitadel-bootstrap.sh`** (the same script prod runs) to provision the
>    project / OIDC app / roles / service-account against the dev Zitadel;
> 6. stashes the runtime SA key at `~/.lazyit-dev/sa-key.json` (mode 600, **outside** the repo tree);
> 7. wires `apps/web/.env` (`AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`) and `apps/api/.env`
>    (disables `AUTH_MODE=shim`, sets `OIDC_ISSUER`, `OIDC_JWKS_URI=…/oauth/v2/keys`,
>    `ZITADEL_MGMT_PROJECT_ID`, `ZITADEL_MGMT_SA_KEY_PATH`) — idempotent, never duplicating lines.
>
> Requires the host tools `docker`, `jq`, `openssl`, `curl` (it fails loud if any is missing). The
> `.env` files it writes are gitignored and the SA key never lands in the tree — **no secret is ever
> committed**. After it finishes, open `http://localhost:3000/setup` to create the first admin **once**,
> then `http://localhost:3000/login`. See [[auth-bootstrap]] §0d for the dev flow in detail.

> [!info] OIDC vs. the `AUTH_MODE=shim` shortcut
> `dev:fresh` wires the **real OIDC flow** (Zitadel login → Bearer JWT → JIT-provisioned [[user]]),
> which is what production runs. If you want the **zero-config** dev shortcut instead (no Zitadel
> bootstrap, the API resolves the actor from an `X-User-Id` header), skip the script and use the
> manual steps below with `AUTH_MODE=shim` left in `apps/api/.env`. `AUTH_MODE=shim` is **dev/test
> only — never run production with it** ([[0037-idp-choice-zitadel-byoi]], [[0038-jit-user-provisioning]]).

## Manual steps (the shortcut / shim path, or when you want each step explicit)

```bash
# 1. Install all workspace dependencies
bun install

# 2. Configure environment — copy each example and fill it in (see env section below).
#    There are THREE env files now. Set MEILI_MASTER_KEY and the ZITADEL_* block in the root .env
#    (db:up starts those containers), and keep AUTH_MODE=shim in apps/api/.env for zero-config dev.
cp .env.example .env                     # root: POSTGRES_*, MEILI_MASTER_KEY, ZITADEL_* (dev IdP)
cp apps/api/.env.example apps/api/.env    # api:  DATABASE_URL, PORT, WEB_ORIGIN, MEILI_*, AUTH_MODE=shim
cp apps/web/.env.example apps/web/.env    # web:  NEXT_PUBLIC_API_URL + Auth.js (next-auth) vars

# 3. Start the infra containers — Postgres + Meilisearch + Zitadel (+ its own Postgres)
bun run db:up            # docker compose up -d  (db, meilisearch, zitadel_db, zitadel)

# 4. Apply migrations (from apps/api)
cd apps/api && bunx prisma migrate dev

# 5. Seed the initial data — asset categories (idempotent, safe to re-run)
bunx prisma db seed

# 6. Run everything (web + api) via Turbo
bun run dev              # web → :3000, api → :3001
```

> [!note] `db:up` now starts more than Postgres
> `bun run db:up` (`docker compose up -d`) brings up the whole dev infra: **Postgres** (`db`, :5432),
> **Meilisearch** (search engine, :7700 — see [[0035-search-architecture]]), **Valkey** (BullMQ
> broker, :6379 — see [[0053-async-workers-bullmq-valkey]]) and **Zitadel** (the bundled OIDC IdP,
> :8080) with its **own** Postgres (`zitadel_db`). A one-shot **`zitadel-secrets-init-dev`** (added in
> `compose.override.yaml`) chmods the `zitadel_secrets` volume **before** Zitadel starts so it can
> write its first-instance machine key — this fixes the #477 dev crash-loop so plain `docker compose
> up` works with no manual `chmod`. All ports are bound to loopback only. Zitadel needs
> `MEILI_MASTER_KEY` and the `ZITADEL_*` block set in the root `.env` or its container fails to boot.
> If you only want the app DB and search, start a subset, e.g. `docker compose up -d db meilisearch`.

> [!info] Authentication in dev — two modes
> **Web UI login** requires a real OIDC flow. `dev:fresh` (above) wires it automatically: it
> bootstraps the bundled Zitadel, then writes `AUTH_ISSUER` / `AUTH_CLIENT_ID` /
> `AUTH_CLIENT_SECRET` into `apps/web/.env` and switches `apps/api/.env` to OIDC mode (it
> comments out `AUTH_MODE=shim` and sets `OIDC_ISSUER` / `OIDC_JWKS_URI`). After `dev:fresh`
> runs, open `http://localhost:3000/setup` to create the first admin once, then
> `http://localhost:3000/login`.
>
> **`AUTH_MODE=shim`** (the value `apps/api/.env.example` ships) is a **dev/test shortcut for
> direct API access only** (curl, Swagger at `/api/docs`): the API resolves the actor from an
> `X-User-Id` header instead of validating a Bearer JWT — handy for shell scripts and Swagger
> testing, but **not wired into the web UI**. The web is OIDC-only; if `AUTH_MODE=shim` is
> still active (i.e. you haven't run `dev:fresh`), the browser will complete the OIDC flow but
> every API call from the web will return `401`. **Never run production with `AUTH_MODE=shim`
> — the header is forgeable** ([[0037-idp-choice-zitadel-byoi]], [[0038-jit-user-provisioning]]).

> [!note] Seeding (Prisma 7)
> The seed command lives in **`prisma.config.ts`** (`migrations.seed: "bun prisma/seed.ts"`),
> not in `package.json` — Prisma 7 ignores the `package.json` `prisma` key when a Prisma config
> file is present. `prisma/seed.ts` upserts the initial [[asset-category]] set by name, so it is
> idempotent and never overwrites edits (categories are user-managed).

## Environment variables

> [!info] One env file per scope
> lazyit uses a **root `.env`** plus **one `.env` per app**; each has a committed
> `.env.example` to copy from.
> - **`.env`** (root) — read by `docker-compose.yml`: `POSTGRES_*`, `MEILI_MASTER_KEY`
>   ([[0035-search-architecture]]), and the **`ZITADEL_*` block** for the bundled dev IdP
>   ([[0037-idp-choice-zitadel-byoi]]). Zitadel will not boot if its block is unset.
> - **`apps/api/.env`** — `DATABASE_URL`, `PORT`, `WEB_ORIGIN`, the Meilisearch knobs
>   (`MEILI_HOST` / `MEILI_MASTER_KEY`), and the auth block (`AUTH_MODE`, `OIDC_*`). Read in two
>   places: the Prisma **CLI** via `prisma.config.ts` (which imports `dotenv/config`), and the
>   **API runtime** because `start`/`dev` pass `--env-file .env` to `nest start`. Keep its
>   Postgres credentials/db in sync with the root.
> - **`apps/web/.env`** — `NEXT_PUBLIC_API_URL` plus the **Auth.js v5** vars (`AUTH_SECRET`,
>   `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_URL`) that drive the OIDC login
>   ([[0039-authjs-v5-frontend-oidc]]).
>
> No `dotenv` in app code. Make sure `DATABASE_URL` matches the Postgres credentials you set in
> the root `.env`, and that `MEILI_MASTER_KEY` matches between the root `.env` and `apps/api/.env`.

| Variable | Where | Used by |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | root `.env` | `docker-compose.yml` (`db`) |
| `MEILI_MASTER_KEY` | root `.env` + `apps/api/.env` | Meilisearch container + API search client ([[0035-search-architecture]]) |
| `ZITADEL_*` (DB creds, masterkey, admin, external domain) | root `.env` | Zitadel + `zitadel_db` containers ([[0037-idp-choice-zitadel-byoi]]) |
| `DATABASE_URL` | `apps/api/.env` | Prisma (`prisma.config.ts`) + API runtime |
| `PORT`, `WEB_ORIGIN` | `apps/api/.env` | NestJS API (`:3001`) + CORS |
| `MEILI_HOST` | `apps/api/.env` | API search client (search disabled if unset) |
| `AUTH_MODE`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_JWKS_URI` | `apps/api/.env` | API auth guard ([[0038-jit-user-provisioning]]) |
| `NEXT_PUBLIC_API_URL`, `AUTH_SECRET`, `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_URL` | `apps/web/.env` | Next.js web + Auth.js ([[0039-authjs-v5-frontend-oidc]]) |

> Bun auto-loads `.env` for Bun-run scripts/tooling, so there's no `dotenv` in app code. Two
> things run *outside* Bun's auto-load and load env explicitly: `prisma.config.ts` (imports
> `dotenv/config`; the Prisma CLI runs under Node) and the **API runtime** (`nest start
> --env-file .env`; the app is a Node child of `nest start`, which Bun's auto-load doesn't reach).

## Verify

- API: hit the first real endpoint — `curl http://localhost:3001/users` returns `[]` (or the
  users you've created). `POST /users` with `{email, firstName, lastName}` creates one. See
  [[user]].
- API docs: open `http://localhost:3001/api/docs` (Swagger UI); raw spec at `/api/docs-json`.
  See [[0018-api-documentation-swagger]].
- Web: open `http://localhost:3000`.

> [!note] Prisma 7 runtime specifics
> Prisma 7's generated client is ESM and needs a **driver adapter** — we use
> `@prisma/adapter-pg` and set `moduleFormat = "cjs"` in the generator (NestJS runs CommonJS).
> `DATABASE_URL` is read at runtime from `apps/api/.env` because the API's `start`/`dev` scripts
> pass `--env-file .env` to `nest start` (Node doesn't auto-load `.env`). The Prisma **CLI**
> reads it separately via `prisma.config.ts`. See [[0003-prisma-orm]].

Related: [[workflows]] · [[stack]] · [[monorepo]] · [[0003-prisma-orm]] · [[user]] ·
[[auth-bootstrap]] · [[0035-search-architecture]] · [[0037-idp-choice-zitadel-byoi]]
