---
title: The @lazyit/shared Package
tags: [architecture]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# The `@lazyit/shared` Package

`packages/shared` (`@lazyit/shared`) is the **single source of truth for everything `web`
and `api` must agree on**. This note is the contract for what may live here — keep it tight
so the package doesn't become a junk drawer.

> Today it exports `APP_NAME` plus the `User` schemas/types ([[user]]). The contract below
> governs what gets added.

## The boundary rule

> [!important] Litmus test
> **If both `web` and `api` must agree on its shape or behavior → it belongs in `shared`.
> If only one side needs it → it stays in that app.**

`shared` is the monorepo **leaf**: it depends on nothing in the repo, and nothing about a
specific framework. Apps depend on it via `workspace:*`, never the reverse ([[monorepo]]).

## What belongs here

- **Zod schemas** — the source of truth for validation. The API validates DTOs against them;
  the web validates forms against them. (Per [[0007-flexible-asset-specs-jsonb]], per-category
  asset `specs` schemas live here too.)
- **Types & interfaces** — preferably **inferred** from the zod schemas (`z.infer<...>`), plus
  hand-written shared types where there's no schema.
- **Enums & constants** — shared status vocabularies, ticket priorities, role names, etc.
- **Pure, framework-agnostic utilities** — small pure functions used by both sides
  (formatting, parsing, computed values like deriving stock from movements). No side effects.

## What does NOT belong here

- **Framework code** — React components/hooks, Next-specific code, NestJS providers/decorators.
- **Anything importing from `apps/web` or `apps/api`** — that inverts the dependency.
- **Prisma / database types** — those are an API concern; they stay in `apps/api`.
- **Environment / config access, I/O, side effects** — `shared` is pure and deterministic.
- **Heavy dependencies** — keep deps minimal (zod is the expected one).

## Conventions

- **Strict TypeScript**, **built** with `tsc -p tsconfig.build.json` to `dist/` (CommonJS +
  `.d.ts`); `main`/`types`/`exports` point at `dist/`. The base `tsconfig.json` stays no-emit
  (editor / Bun). Turbo runs the build before dependents (`build`/`dev`/`test` `dependsOn`
  `^build`). Why a build (and not source-direct): [[0014-shared-package-build]].
- Organize `src/` by kind — `schemas/` (zod + inferred types), `constants/`, `utils/` (pure fns),
  `clone/` (the per-entity "clone a record" sanitizers — pure mappers from a persisted record to a
  `CreateX`-shaped partial, used to pre-fill the create forms) — then re-export from the barrel
  `src/index.ts` (extensionless imports); import as `@lazyit/shared`.
- Validation flow: define the **zod schema here** → API uses it for request validation, web
  uses it for forms → share the type via `z.infer`. One definition, no duplication.
- Tests for `shared` run with `bun test` ([[0012-testing-strategy]]).

Related: [[monorepo]] · [[code-conventions]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0012-testing-strategy]]
