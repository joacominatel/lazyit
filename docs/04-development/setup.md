---
title: Local Setup
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Local Setup

Get lazyit running on your machine. Verified against the repo as of 2026-05-25.

## Prerequisites

- **Bun** `1.3.x` (repo pins `bun@1.3.14`) — package manager and runtime.
- **Docker** + Docker Compose — for the PostgreSQL dev database.
- **Node** available on PATH — some CLIs still expect it (see [[stack]]).

## Steps

```bash
# 1. Install all workspace dependencies
bun install

# 2. Configure environment — copy each example and fill it in (see env section below)
cp .env.example .env                    # root: POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB
cp apps/api/.env.example apps/api/.env   # api:  DATABASE_URL, PORT

# 3. Start PostgreSQL (postgres:18-alpine)
bun run db:up            # docker compose up -d

# 4. Apply migrations (from apps/api)
cd apps/api && bunx prisma migrate dev

# 5. Seed the initial data — asset categories (idempotent, safe to re-run)
bunx prisma db seed

# 6. Run everything (web + api) via Turbo
bun run dev              # web → :3000, api → :3001
```

> [!note] Seeding (Prisma 7)
> The seed command lives in **`prisma.config.ts`** (`migrations.seed: "bun prisma/seed.ts"`),
> not in `package.json` — Prisma 7 ignores the `package.json` `prisma` key when a Prisma config
> file is present. `prisma/seed.ts` upserts the initial [[asset-category]] set by name, so it is
> idempotent and never overwrites edits (categories are user-managed).

## Environment variables

> [!info] One env file per scope
> lazyit uses a **root `.env`** plus **one `.env` per app**; each has a committed
> `.env.example` to copy from.
> - **`.env`** (root) — read by `docker-compose.yml`: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
>   `POSTGRES_DB` (defaults to `lazyit`).
> - **`apps/api/.env`** — `DATABASE_URL` and `PORT`. Read in two places: the Prisma **CLI** via
>   `prisma.config.ts` (which imports `dotenv/config`), and the **API runtime** because
>   `start`/`dev` pass `--env-file .env` to `nest start`. Keep its credentials/db in sync with the root.
> - **`apps/web/.env`** — none yet; the frontend has no environment variables. Add a
>   `.env.example` here when that changes.
>
> No `dotenv` in app code. Make sure `DATABASE_URL` matches the Postgres credentials you set in
> the root `.env`.

| Variable | Where | Used by |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | root `.env` | `docker-compose.yml` |
| `DATABASE_URL` | `apps/api/.env` | Prisma (`prisma.config.ts`) |
| `PORT` | `apps/api/.env` | NestJS API (`:3001`) |

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

Related: [[workflows]] · [[stack]] · [[monorepo]] · [[0003-prisma-orm]] · [[user]]
