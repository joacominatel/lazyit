---
title: Code Conventions
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Code Conventions

Conventions for application code. Data-model conventions live in [[conventions]] (Domain).

## Language

- **English everywhere** — code, identifiers, comments, and these docs.

## TypeScript

- **Strict** TypeScript across all workspaces.
- Shared contracts (DTOs, zod schemas, types used by both web and api) live in
  `@lazyit/shared` — one definition, imported via `workspace:*`. Never duplicate a contract
  in an app ([[monorepo]]).

## Backend (NestJS)

- Organize by **module per bounded area** ([[02-domain/_MOC|Domain]]): assets, tickets,
  access, consumables, knowledge base.
- Use dependency injection; e.g. a single injectable `PrismaService` (next code step after
  the domain model — [[0002-nestjs-backend]], [[0003-prisma-orm]]).
- Validate input with zod schemas from `@lazyit/shared`.

## Frontend (Next.js)

- App Router, TypeScript, Tailwind v4. UI kit likely shadcn/ui (not yet decided — [[stack]]).

## The Bun-first boundary

> [!important] Read [[0009-bun-first-vs-app-stack]]
> Bun is **scoped** (decided 2026-05-25, written into the root `CLAUDE.md`):
> - **Bun** = runtime, package manager, scripts/tooling, and tests for `shared`/scripts.
> - **App layer** = NestJS (Express) for HTTP, Prisma for data, **Jest** for API tests.
>
> Don't "fix" Express→`Bun.serve` or Prisma→`Bun.sql` to match the old blanket Bun-first
> wording; that divergence is deliberate and now documented in `CLAUDE.md`.

## Testing

- API: Jest (`apps/api`). Shared/scripts: `bun test`.

Related: [[workflows]] · [[setup]] · [[conventions]] · [[0009-bun-first-vs-app-stack]]
