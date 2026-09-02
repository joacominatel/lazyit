---
title: Cloud agents — bringing lazyit up in a fresh VM
tags: [development, runbook]
status: accepted
created: 2026-09-02
updated: 2026-09-02
---

# Cloud agents — bringing lazyit up in a fresh VM

Environment notes for an agent working in a disposable machine (Cursor Cloud and similar),
where nothing is installed and nothing is cached. Previously carried in the root `AGENTS.md`;
moved here because it is setup, not standing instruction — see [[claude-workflow]] for how we
work and `.claude/charter.md` for the operational facts.

For a normal local setup, use [[setup]] instead.

## Services

| Service | How to run | Port |
| --- | --- | --- |
| PostgreSQL | `docker compose up -d db`, or `bun run db:up` for the full set | `127.0.0.1:5432` |
| API | `bun run dev`, or `cd apps/api && bun run dev` | `3001` |
| Web | `bun run dev`, or `cd apps/web && bun run dev` | `3000` |
| Meilisearch / Zitadel | started by `bun run db:up`; optional in shim mode | `7700` / `8080` |

The minimal end-to-end loop is **Postgres + API + Web**. Meilisearch and Zitadel are optional
when `AUTH_MODE=shim`.

## Docker in the VM

Docker is not managed by systemd here. If `docker ps` fails with a permission or connection
error:

1. Make sure `dockerd` is running — check `/tmp/dockerd.log`, or start it with `sudo dockerd`
   in the background.
2. Use the `docker` group: `sg docker -c "docker ..."`, or add the user to it.

The storage driver is `fuse-overlayfs`, configured in `/etc/docker/daemon.json`.

## Environment files

Copy all three examples on first setup:

```sh
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Fill `POSTGRES_PASSWORD` and `MEILI_MASTER_KEY` in the root `.env`, and keep `DATABASE_URL` in
`apps/api/.env` aligned with those credentials. Generate `AUTH_SECRET` for `apps/web/.env` with
`openssl rand -base64 32`.

> **Boot gotcha.** Do not leave `OIDC_ISSUER=` as an empty string in `apps/api/.env` when using
> `AUTH_MODE=shim`. An empty value fails zod URL validation and the API will not boot. Omit the
> line or comment it out.

## Prisma

From `apps/api`, on first boot and after any schema change:

```sh
bunx prisma generate        # required before seed or tests if the client is missing
bunx prisma migrate deploy  # or migrate dev locally
bunx prisma db seed
```

`@lazyit/shared` must be built before the seed runs:

```sh
bun run build --filter=@lazyit/shared
```

## Dev auth

With `AUTH_MODE=shim`, authenticated API calls need an `X-User-Id: <uuid>` header. The seed
creates `admin@lazyit.local`; query its id from Postgres and use it for smoke tests. `/health/*`
is public.

`POST /users` returns 503 without Zitadel management configured — expected in shim-only dev.
Prefer asset or dashboard endpoints for a first check.

## Smoke test

```sh
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
curl -H "X-User-Id: <admin-uuid>" http://localhost:3001/assets
open http://localhost:3000
open http://localhost:3001/api/docs
```

## Lint

Repo-wide `bun run lint` may fail on pre-existing eslint findings in `apps/web` — a known
backlog that CI reports without gating. Tests and build are the stronger signal that the
environment is correct. The blocking gate is lint on changed files only; see the charter.

Related: [[setup]] · [[claude-workflow]] · [[git-workflow]]
