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
- Shared contracts (zod schemas, inferred types, constants, pure utils used by both web and
  api) live in `@lazyit/shared` — one definition, imported via `workspace:*`. Never duplicate
  a contract in an app. What may live there is governed by a contract → [[shared-package]].

## Backend (NestJS)

- Organize by **module per bounded area** ([[02-domain/_MOC|Domain]]): assets, tickets,
  access, consumables, knowledge base.
- Use dependency injection; e.g. a single injectable `PrismaService` (next code step after
  the domain model — [[0002-nestjs-backend]], [[0003-prisma-orm]]).
- Validate input with zod schemas from `@lazyit/shared`.
- **Integers backed by a Postgres `Int` column use `int4()`** from `@lazyit/shared`, never a bare
  `z.number().int()` — the latter inherits zod's safe-integer bounds, which overflow the column
  (P2020 → 500) and make Swagger UI autofill `MAX_SAFE_INTEGER` ([[0036-int4-bounded-integers]]).
- **Soft delete is automatic** ([[0032-soft-delete-middleware]]): a Prisma `$extends` filter scopes
  reads on soft-deletable models to `deletedAt: null` — don't re-add manual `where: { deletedAt: null }`
  guards. Use `findFirst` (not `findUnique`) for soft-delete-aware lookups by id; pass
  `{ includeSoftDeleted: true }` to bypass (restore / audit).

## Observability — logging

Structured logging is **Pino** via **`nestjs-pino`** ([[0031-logging-strategy]]). In practice:

- **Don't `console.log`.** Inject `PinoLogger` (or a Nest `Logger`) and log structured objects —
  `this.logger.info({ assetId }, 'asset created')`. Nest's own logs already route through Pino.
- **Levels are a four-word vocabulary** mapped onto Pino: `trace`/`debug` → **DEBUG**, `info` →
  **INFO**, `warn` → **WARNING**, `error`/`fatal` → **CRITICAL**.
- **Never log secrets or bodies.** `authorization`, `cookie` and the `x-user-id` header are redacted;
  request/response bodies are not logged. The caller's id is logged as the `actor` field.
- **Request id is automatic** — every line of a request carries it (honored from `X-Request-Id` or
  generated, echoed on the response). Don't roll your own correlation id.
- **Errors:** throwing is enough — the global `AllExceptionsFilter` logs ≥ 500 faults with their
  stack. Don't `catch`-and-log-and-rethrow just to record an error.

## Frontend (Next.js)

- App Router, TypeScript, Tailwind v4 ([[0010-nextjs-frontend]], [[0011-tailwind-styling]]).
  shadcn/ui is the planned component layer (not yet installed); document component
  conventions here when UI work starts.

## The Bun-first boundary

> [!important] Read [[0009-bun-first-vs-app-stack]]
> Bun is **scoped** (decided 2026-05-25, written into the root `CLAUDE.md`):
> - **Bun** = runtime, package manager, scripts/tooling, and tests for `shared`/scripts.
> - **App layer** = NestJS (Express) for HTTP, Prisma for data, **Jest** for API tests.
>
> Don't "fix" Express→`Bun.serve` or Prisma→`Bun.sql` to match the old blanket Bun-first
> wording; that divergence is deliberate and now documented in `CLAUDE.md`.

## Testing

- Unit tests **always**; core/complex logic gets thorough, many-cased testing. Priority is
  the application core, not scaffolding/UI. Full policy: [[0012-testing-strategy]].
- Runners: **Jest** (`apps/api`) · **`bun test`** (`packages/shared`). Frontend unit tests and
  e2e are **deferred**. No global coverage gate — rigor on the core via review.

## Workflow

- Every change follows [[claude-workflow]]: context first, ask-don't-assume, front/back via
  separate subagents, file-scoped commits, and **docs kept in sync** (review `docs/` on any
  core change; never commit docs that reference removed files or a changed philosophy).

Related: [[claude-workflow]] · [[workflows]] · [[setup]] · [[conventions]] · [[shared-package]] ·
[[0009-bun-first-vs-app-stack]] · [[0012-testing-strategy]]
