---
title: Monorepo Layout
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-06-23
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
├── compose.yaml             # dev backing services (Postgres, Meilisearch, Zitadel)
├── compose.override.yaml    # dev-only overrides (loopback port bindings), auto-loaded
├── infra/
│   └── docker-compose.prod.yaml  # the `prod` profile (Caddy, full containerized stack)
├── .env.example
├── turbo.json
└── package.json     # workspace root: workspaces = ["apps/*", "packages/*"]
```

## Workspaces

- **`@lazyit/web`** — Next.js app. Depends on `@lazyit/shared` via `workspace:*`.
- **`@lazyit/api`** — NestJS app + Prisma. Depends on `@lazyit/shared` via `workspace:*`.
- **`@lazyit/shared`** — framework-agnostic TypeScript. Built with `bun run scripts/build.ts`,
  which runs **two `tsc` emits**: a CommonJS build to `dist/` (the main `.` barrel, consumed by
  apps/api's CommonJS Jest and the Node-compiled API) plus a separate **ESM** emit to `dist/esm/crypto/`
  for the `@lazyit/shared/crypto` subpath (the `@noble/*` primitives are ESM-only). `main`/`types`/
  `exports` → `dist/` (the base `tsconfig.json` stays no-emit). It now exports the **full domain zod
  schemas/types** (assets, users, applications, access grants, consumables, articles, locations, …),
  the **`Page` / `PageQuery`** pagination envelope, the **authZ Permission catalog**, the **workflow**
  engine contract, and the **Secret Manager** wire shapes — plus the crypto primitives behind the
  separate **`@lazyit/shared/crypto`** subpath. Why a build → [[0014-shared-package-build]].
  **Full inventory and what may live here is governed by a contract → [[shared-package]].**

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
