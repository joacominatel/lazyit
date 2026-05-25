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

# 5. Run everything (web + api) via Turbo
bun run dev              # web → :3000, api → :3001
```

## Environment variables

> [!info] One env file per scope
> lazyit uses a **root `.env`** plus **one `.env` per app**; each has a committed
> `.env.example` to copy from.
> - **`.env`** (root) — read by `docker-compose.yml`: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
>   `POSTGRES_DB` (defaults to `lazyit`).
> - **`apps/api/.env`** — read by the API: `DATABASE_URL` (Prisma, via `prisma.config.ts`,
>   which imports `dotenv/config`) and `PORT`. Keep its credentials/db in sync with the root.
> - **`apps/web/.env`** — none yet; the frontend has no environment variables. Add a
>   `.env.example` here when that changes.
>
> Bun auto-loads `.env`, so app code needs no `dotenv`. Make sure `DATABASE_URL` matches the
> Postgres credentials you set in the root `.env`.

| Variable | Where | Used by |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | root `.env` | `docker-compose.yml` |
| `DATABASE_URL` | `apps/api/.env` | Prisma (`prisma.config.ts`) |
| `PORT` | `apps/api/.env` | NestJS API (`:3001`) |

> Bun auto-loads `.env`, so there's no `dotenv` in app code — except `prisma.config.ts`, which
> imports `dotenv/config` because the Prisma CLI runs outside Bun's auto-loading.

## Verify

- API health: the initial migration created a throwaway `HealthCheck` model — a quick way to
  confirm DB connectivity until real endpoints exist.
- Web: open `http://localhost:3000`.

Related: [[workflows]] · [[stack]] · [[monorepo]] · [[0003-prisma-orm]]
