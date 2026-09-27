---
paths:
  - "apps/api/**"
---

# Backend conventions

NestJS on Express, strict TypeScript, Prisma. The HTTP server is **not** `Bun.serve()` and data
access is **not** `Bun.sql` or `pg` — those choices are deliberate.
→ `docs/03-decisions/0009-bun-first-vs-app-stack.md`

## Data model

- Models are singular PascalCase; tables are pluralized snake_case via `@@map`.
- **IDs**: `uuid()` for sensitive or externally exposed entities (mainly `User`), `cuid()` for
  most domain entities, `autoincrement()` for logs and history.
  → `docs/03-decisions/0005-id-strategy.md`
- **Timestamps**: `createdAt` everywhere. `updatedAt` and `deletedAt` on mutable domain
  entities. Append-only tables — history, ledgers — get `createdAt` only.
  → `docs/03-decisions/0006-soft-delete-and-auditing.md`
- **Never hard-delete domain data.** Soft delete, and make sure the read path filters it.
- Type-specific asset attributes live in the `specs` jsonb column, validated by zod in
  `@lazyit/shared`. → `docs/03-decisions/0007-flexible-asset-specs-jsonb.md`

Read the entity note in `docs/02-domain/entities/` before changing a model. The domain rules
are there, not in the schema.

## Migrations

Additive and nullable or defaulted. No destructive drop, no `NOT NULL` without a default, no
rename that strands rows. If existing rows genuinely need fixing, ship the backfill — a data
step, a self-heal path, or a one-time reconcile job. Never assume the table is empty; it is
not, on every instance already running.

## Validation

Enforce on write, stay tolerant on read. Legacy rows must still load without a 400 or a crash;
prefer correcting them on the next natural write. This is what keeps an upgrade from breaking
data that predates the rule.

## Async work

BullMQ on Valkey via `@nestjs/bullmq`. Memory-heavy or untrusted jobs run in sandboxed
processors. → `docs/03-decisions/0053-async-workers-bullmq-valkey.md`

## Tests

**Jest, run under Node** — `node node_modules/.bin/jest`. Jest 30 does not initialize under
Bun's runtime; this is decided, not a workaround waiting to be cleaned up (ADR-0096). `bun test`
is for `packages/shared`, `apps/web`, `apps/agent`, and standalone scripts.

Unit tests always; core and complex logic thoroughly.
→ `docs/03-decisions/0012-testing-strategy.md`

## Lint

`apps/api` eslint carries the `prettier/prettier` rule and it will fail the blocking CI gate.
Run `bunx eslint` on your changed files **from inside `apps/api`** before pushing.

## Environment

Bun's automatic `.env` loading does not apply here: the API runs as a Node child of
`nest start --env-file .env`. `prisma.config.ts` imports `dotenv/config` for the same reason —
the Prisma CLI runs on Node.
