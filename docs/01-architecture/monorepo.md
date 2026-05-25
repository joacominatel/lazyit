---
title: Monorepo Layout
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Monorepo Layout

lazyit is a single repository managed with **Bun workspaces** and **Turborepo**.

```
lazyit/
├── apps/
│   ├── web/         # Next.js 16 frontend (@lazyit/web)
│   └── api/         # NestJS 11 + Prisma backend (@lazyit/api)
├── packages/
│   └── shared/      # @lazyit/shared — types & zod schemas shared front↔back
├── docs/            # this vault
├── docker-compose.yml
├── .env.example
├── turbo.json
└── package.json     # workspace root: workspaces = ["apps/*", "packages/*"]
```

## Workspaces

- **`@lazyit/web`** — Next.js app. Depends on `@lazyit/shared` via `workspace:*`.
- **`@lazyit/api`** — NestJS app + Prisma. Depends on `@lazyit/shared` via `workspace:*`.
- **`@lazyit/shared`** — framework-agnostic TypeScript. Built to `dist/` (CommonJS + `.d.ts`)
  via `tsc`; `main`/`types`/`exports` → `dist/` (the base `tsconfig.json` stays no-emit). Exports
  `APP_NAME` and the `User` schemas/types so far. Why a build → [[0014-shared-package-build]].
  **What may live here is governed by a contract → [[shared-package]].**

## Orchestration

Root `package.json` scripts delegate to Turborepo:

| Script | Effect |
| --- | --- |
| `bun run dev` | `turbo dev` — runs web, api (and shared if applicable) together |
| `bun run build` | `turbo build` |
| `bun run lint` | `turbo lint` |
| `bun run db:up` / `db:down` | `docker compose up -d` / `down` |

## Package-boundary rules

- **`shared` depends on nothing** in the monorepo. It is the leaf; apps depend on it,
  never the reverse.
- **Cross-cutting contracts go in `shared`** — DTO/zod schemas and types used by both
  web and api live here so there is exactly one definition. See [[conventions]].
- **No app imports another app.** `web` and `api` communicate over HTTP, not imports.

## Why a monorepo

Rationale and trade-offs in [[0001-monorepo-bun-turborepo]].

Related: [[stack]] · [[deployment]] · [[setup]]
