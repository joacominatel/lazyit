---
title: Tech Stack
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Tech Stack

Versions below are **verified against the repository** as of 2026-05-25, not just planned.

| Layer | Choice | Version | Notes |
| --- | --- | --- | --- |
| Package manager / runtime | **Bun** | `1.3.14` | Workspaces; default runtime — see [[0001-monorepo-bun-turborepo]] |
| Monorepo orchestration | **Turborepo** | `^2.9` | `turbo dev` / `turbo build` / `turbo lint` |
| Frontend | **Next.js** (App Router) | `16.2.6` | React `19.2.4`, Tailwind v4, TypeScript |
| Backend | **NestJS** | `11.0.1` | `@nestjs/platform-express`, TypeScript strict |
| ORM | **Prisma** | `7.8.0` | `prisma-client` generator → `apps/api/generated/prisma` |
| Database | **PostgreSQL** | `18-alpine` | Docker Compose for dev — see [[0003-prisma-orm]] |
| Shared types | **`@lazyit/shared`** | `0.0.0` | `packages/shared`; zod schemas/types shared front↔back |
| Node (for CLIs) | Node | `26` (planned) | Available for tools that require it; `@types/node` is `^24` in api, `^20` in web |

## Ports

- Web (Next.js): `http://localhost:3000`
- API (NestJS): `http://localhost:3001`
- Postgres: `5432`

## Decided but not yet implemented

- **Frontend:** Next.js + Tailwind decided ([[0010-nextjs-frontend]], [[0011-tailwind-styling]]);
  **shadcn/ui** is the intended component layer but not yet installed.
- **Auth:** **deferred** — we integrate with an external IdP (OIDC), not a self-rolled flow;
  provider TBD (Authentik / Keycloak / Zitadel). See [[0016-auth-strategy-deferred]] and
  [[0015-deployment-model]].
- **Async workers:** likely BullMQ + Redis.

> [!warning] Bun-first vs app stack
> The repo's `CLAUDE.md` mandates `Bun.serve`, `Bun.sql`, `Bun.redis` and `bun test`, but
> the chosen app stack is NestJS (Express) + Prisma + Jest. Resolved in
> [[0009-bun-first-vs-app-stack]] (accepted): Bun is the **runtime, package manager and
> tooling default**, *not* the server/DB API layer. The scoped rule lives in `CLAUDE.md`.

## Why these

Each significant choice has an ADR:
[[0001-monorepo-bun-turborepo]] · [[0002-nestjs-backend]] · [[0003-prisma-orm]] ·
[[0010-nextjs-frontend]] · [[0011-tailwind-styling]] · [[0012-testing-strategy]].

Related: [[monorepo]] · [[shared-package]] · [[deployment]]
