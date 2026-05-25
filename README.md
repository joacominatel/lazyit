# lazyit

Self-hosted, internal web app for small IT/Systems teams (5–20 people): **asset inventory,
application access, tickets, consumables and a knowledge base.** ServiceNow-grade capability, but
modern, opinionated and IT-native — **asset-centric** and **auditable by default**.

> **The full documentation is an Obsidian vault in [`docs/`](docs/README.md) — the source of
> truth.** Start there. This README is just the entry point.

## Stack

Bun (runtime/tooling) · Turborepo · Next.js 16 + React 19 + Tailwind v4 (web) · NestJS 11 +
Prisma 7 (api) · PostgreSQL 18 · `@lazyit/shared` (zod contracts). The app **runs on Node**; Bun is
the package manager and build/tooling default ([`ADR-0009`](docs/03-decisions/0009-bun-first-vs-app-stack.md)).

## Layout

```
apps/web           Next.js frontend (@lazyit/web, :3000)
apps/api           NestJS + Prisma backend (@lazyit/api, :3001)
packages/shared    @lazyit/shared — zod schemas & types shared web↔api
infra/             Docker images, prod-like compose, Caddy, prod env template
docs/              documentation vault (source of truth)
docker-compose.yml Postgres for dev
.github/workflows/ CI
```

## Develop

```sh
bun install                              # install all workspaces
cp .env.example .env                     # Postgres creds for the dev DB
cp apps/api/.env.example apps/api/.env   # DATABASE_URL, PORT, WEB_ORIGIN
cp apps/web/.env.example apps/web/.env   # NEXT_PUBLIC_API_URL
bun run db:up                            # start Postgres (docker compose)
cd apps/api && bunx prisma migrate dev && bunx prisma db seed && cd -
bun run dev                              # web → :3000, api → :3001 (Swagger at :3001/api/docs)
```

Other scripts: `bun run build` · `bun run lint` · `bun run test` · `bun run db:down`.
Full setup and the Prisma workflow: [`docs/04-development/setup.md`](docs/04-development/setup.md)
· [`docs/05-runbooks/prisma-migrations.md`](docs/05-runbooks/prisma-migrations.md).

## Run the production-shaped stack (Docker)

Everything in containers behind Caddy with local HTTPS — see
[`infra/README.md`](infra/README.md) and the runbooks.

```sh
cp infra/env/.env.prod.example infra/env/.env.prod   # fill in (replace every CHANGE_ME)
docker compose -f infra/docker-compose.prod.yml up -d --build
# open https://localhost:8443
```

- First boot / local: [`docs/05-runbooks/docker-prod-like-first-boot.md`](docs/05-runbooks/docker-prod-like-first-boot.md)
- Deploy to a host: [`docs/05-runbooks/deploy-self-hosted.md`](docs/05-runbooks/deploy-self-hosted.md)
- Backups: [`docs/05-runbooks/backups.md`](docs/05-runbooks/backups.md)
- Build/boot troubleshooting: [`docs/05-runbooks/docker-build-troubleshooting.md`](docs/05-runbooks/docker-build-troubleshooting.md)
- Architecture: [`docs/01-architecture/deployment.md`](docs/01-architecture/deployment.md)

> **Auth is deferred** to an external IdP and not implemented yet — the current build is
> unauthenticated and **must not be exposed publicly**
> ([`ADR-0016`](docs/03-decisions/0016-auth-strategy-deferred.md)).
