---
title: Local Setup
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-10-09
---

# Local Setup

Get lazyit running on your machine. Verified against the repo as of 2026-05-30.

## Prerequisites

- **Bun** `1.4.x` (repo pins `bun@1.4.2`) — package manager and runtime.
- **Docker** + Docker Compose — for the PostgreSQL dev database.
- **Node** available on PATH — some CLIs still expect it (see [[stack]]).

## Quick start — one command (recommended)

The fastest path is the **`dev-setup` script** (`scripts/dev-setup.ts`, issue #483). It automates the
whole bring-up — backing services, migrate/generate/seed, and the `apps/{web,api}/.env` auth wiring —
into one command, with two modes. Dev auth is **local** (built-in accounts, [[0086-local-authentication-mode]]):
there is no bundled dev IdP ([[0102-remove-bundled-zitadel]]), and only `docker` is needed on the host.

```bash
bun install                  # 1. install all workspace dependencies
cp .env.example .env         # 2. root env only: POSTGRES_*, MEILI_MASTER_KEY

# 3a. FIRST TIME (or a clean slate) — wipes dev volumes, rebuilds, wires local auth:
bun run dev:fresh            # destructive: prompts for a typed "yes" (use --yes to skip in CI)

# 3b. EVERY DAY AFTER — services up + a fresh Prisma client, then start the apps:
bun run dev:up               # assumes dev:fresh ran before
```

Both modes end by running `bun run dev` (web → :3000, api → :3001). Pass `--no-start` to do all the
prep but stop before starting the apps (useful in CI/tests):
`bun scripts/dev-setup.ts --fresh --yes --no-start`.

> [!info] What `dev:fresh` does (and what it touches)
> 1. **removes the dev Docker volumes** (`lazyit_{db_data,meili_data_v1_53_2,meili_data,valkey_data}`,
>    plus `lazyit_zitadel_db_data` / `lazyit_zitadel_secrets` left over from the removed dev Zitadel) —
>    this is the destructive step it asks you to confirm;
> 2. `docker compose up -d` — db, meilisearch and valkey;
> 3. waits for `db` healthy;
> 4. `prisma migrate deploy` → **`prisma generate`** (explicit — `migrate deploy` does NOT regenerate
>    the client, and a stale client breaks the API boot, #480) → `prisma db seed`;
> 5. wires `apps/api/.env` (`AUTH_MODE=local` + a dev `SESSION_SIGNING_SECRET`, OIDC vars commented
>    out) and `apps/web/.env` (`AUTH_MODE=local`) — idempotent, never duplicating lines.
>
> The `.env` files it writes are gitignored — **no secret is ever committed**. After it finishes, open
> `http://localhost:3000/setup` to create the first admin **once**, then `http://localhost:3000/login`.

> [!info] OIDC in dev — bring your own IdP
> There is no dev IdP to start. To exercise the OIDC path, register a client in an IdP you run
> yourself (redirect URI `http://localhost:3000/api/auth/callback/oidc`), then set `AUTH_MODE=oidc`,
> `OIDC_ISSUER`, `OIDC_JWKS_URI` and `OIDC_CLIENT_ID` in `apps/api/.env`, and `AUTH_ISSUER`,
> `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` in `apps/web/.env` ([[0102-remove-bundled-zitadel]] §2).
> `AUTH_MODE` is immutable per database ([[0086-local-authentication-mode]] §1), so switch modes on a
> fresh `dev:fresh`, not on a populated dev DB.

## Manual steps (the shim path, or when you want each step explicit)

```bash
# 1. Install all workspace dependencies
bun install

# 2. Configure environment — copy each example and fill it in (see env section below).
#    There are THREE env files. Keep AUTH_MODE=shim in apps/api/.env for zero-config API access.
cp .env.example .env                     # root: POSTGRES_*, MEILI_MASTER_KEY
cp apps/api/.env.example apps/api/.env    # api:  DATABASE_URL, PORT, WEB_ORIGIN, MEILI_*, AUTH_MODE=shim
cp apps/web/.env.example apps/web/.env    # web:  NEXT_PUBLIC_API_URL + Auth.js (next-auth) vars

# 3. Start the infra containers — Postgres + Meilisearch + Valkey
bun run db:up            # docker compose up -d

# 4. Apply migrations (from apps/api)
cd apps/api && bunx prisma migrate dev

# 5. Seed the initial data — asset categories (idempotent, safe to re-run)
bunx prisma db seed

# 6. Run everything (web + api) via Turbo
bun run dev              # web → :3000, api → :3001
```

> [!note] What `db:up` starts
> `bun run db:up` (`docker compose up -d`) brings up the dev infra: **Postgres** (`db`, :5432),
> **Meilisearch** (search engine, :7700 — see [[0035-search-architecture]]) and **Valkey** (BullMQ
> broker, :6379 — see [[0053-async-workers-bullmq-valkey]]). All ports are bound to loopback only.
> Meilisearch needs `MEILI_MASTER_KEY` set in the root `.env`. If you only want the app DB and search,
> start a subset, e.g. `docker compose up -d db meilisearch`.

> [!info] Authentication in dev — `local` or `shim`
> **Web UI login** uses local accounts: `dev:fresh` (above) sets `AUTH_MODE=local` on both apps, and
> you create the first admin at `http://localhost:3000/setup`.
>
> **`AUTH_MODE=shim`** (the value `apps/api/.env.example` ships) is a **dev/test shortcut for
> direct API access only** (curl, Swagger at `/api/docs`): the API resolves the actor from an
> `X-User-Id` header instead of validating a session — handy for shell scripts and Swagger testing,
> but **not wired into the web UI**. **Never run production with `AUTH_MODE=shim` — the header is
> forgeable** ([[0086-local-authentication-mode]], [[0038-jit-user-provisioning]]).

> [!note] Seeding (Prisma 7)
> The seed command lives in **`prisma.config.ts`** (`migrations.seed: "bun prisma/seed.ts"`),
> not in `package.json` — Prisma 7 ignores the `package.json` `prisma` key when a Prisma config
> file is present. `prisma/seed.ts` upserts the initial [[asset-category]] set by name, so it is
> idempotent and never overwrites edits (categories are user-managed).

## Environment variables

> [!info] One env file per scope
> lazyit uses a **root `.env`** plus **one `.env` per app**; each has a committed
> `.env.example` to copy from.
> - **`.env`** (root) — read by `compose.yaml`: `POSTGRES_*` and `MEILI_MASTER_KEY`
>   ([[0035-search-architecture]]).
> - **`apps/api/.env`** — `DATABASE_URL`, `PORT`, `WEB_ORIGIN`, the Meilisearch knobs
>   (`MEILI_HOST` / `MEILI_MASTER_KEY`), and the auth block (`AUTH_MODE`, `OIDC_*`). Read in two
>   places: the Prisma **CLI** via `prisma.config.ts` (which imports `dotenv/config`), and the
>   **API runtime** because `start`/`dev` pass `--env-file .env` to `nest start`. Keep its
>   Postgres credentials/db in sync with the root.
> - **`apps/web/.env`** — `NEXT_PUBLIC_API_URL` plus the **Auth.js v5** vars (`AUTH_SECRET`,
>   `AUTH_MODE`, `AUTH_URL`, and — for OIDC only — `AUTH_ISSUER`, `AUTH_CLIENT_ID`,
>   `AUTH_CLIENT_SECRET`) ([[0039-authjs-v5-frontend-oidc]]).
>
> No `dotenv` in app code. Make sure `DATABASE_URL` matches the Postgres credentials you set in
> the root `.env`, and that `MEILI_MASTER_KEY` matches between the root `.env` and `apps/api/.env`.

| Variable | Where | Used by |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | root `.env` | `compose.yaml` (`db`) |
| `MEILI_MASTER_KEY` | root `.env` + `apps/api/.env` | Meilisearch container + API search client ([[0035-search-architecture]]) |
| `DATABASE_URL` | `apps/api/.env` | Prisma (`prisma.config.ts`) + API runtime |
| `PORT`, `WEB_ORIGIN` | `apps/api/.env` | NestJS API (`:3001`) + CORS |
| `MEILI_HOST` | `apps/api/.env` | API search client (search disabled if unset) |
| `AUTH_MODE`, `SESSION_SIGNING_SECRET` (local); `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_JWKS_URI` (OIDC) | `apps/api/.env` | API auth guard ([[0086-local-authentication-mode]], [[0038-jit-user-provisioning]]) |
| `NEXT_PUBLIC_API_URL`, `AUTH_SECRET`, `AUTH_MODE`, `AUTH_URL`; `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` (OIDC) | `apps/web/.env` | Next.js web + Auth.js ([[0039-authjs-v5-frontend-oidc]]) |

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
[[0035-search-architecture]] · [[0086-local-authentication-mode]] · [[0102-remove-bundled-zitadel]]
