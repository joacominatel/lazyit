---
title: "ADR-0032: Soft-delete enforcement via a Prisma client extension"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0032: Soft-delete enforcement via a Prisma client extension

## Status

accepted — 2026-05-26. Second front of the backend-completion epic (#4, sub-issue #7). Implements
the follow-up anticipated by [[0006-soft-delete-and-auditing]] ("add a default `deletedAt IS NULL`
scope on mutable entities — Prisma extension/middleware"). Backend infra; no domain rules change.

## Context

[[0006-soft-delete-and-auditing]] split entities by mutability: mutable domain entities carry
`deletedAt` (soft delete), append-only tables and lifecycle joins do not. Until now, **every read**
on a soft-deletable model carried a manual `where: { deletedAt: null }` guard, duplicated across the
11 feature services. That is repetitive and — worse — easy to forget: a single missed guard silently
leaks soft-deleted rows. ADR-0006 already flagged "consider a Prisma middleware/extension to enforce
it" as the intended fix.

## Considered options

- **Keep manual per-query guards.** ❌ Duplicated, forgettable, leak-prone — the status quo we are
  removing.
- **Prisma `$use` middleware.** ❌ Removed in Prisma 7 (no longer part of the client).
- **Prisma client `$extends` query component.** ✅ The supported Prisma 7 mechanism: a `query`
  extension can intercept operations and rewrite their args (inject the `deletedAt: null` filter).

## Decision

- A **`$extends` query extension** intercepts `$allOperations` on `$allModels` and, for the
  soft-deletable models in `SOFT_DELETABLE_MODELS` (`User`, `Location`, `AssetCategory`, `AssetModel`,
  `Asset`, `ArticleCategory`, `Article`, `ApplicationCategory`, `Application`, `ConsumableCategory`,
  `ServiceAccount` — `Consumable` is deliberately OUT, its service filters `deletedAt` explicitly to
  serve the ADMIN archived-view slice), injects
  `where: { deletedAt: null }` into **read** operations: `findFirst`, `findFirstOrThrow`, `findMany`,
  `count`, `aggregate`, `groupBy`. The pure logic lives in `withSoftDeleteFilter`
  (`apps/api/src/prisma/soft-delete.extension.ts`) and is unit-tested in isolation; the extension is
  wired in `PrismaService`.
- **Escape hatch:** a read that passes `{ includeSoftDeleted: true }` skips the filter — the custom
  arg is stripped before Prisma sees it. Intended for restore and audit flows (none exist yet; the
  mechanism is in place).
- **Writes are untouched:** the soft delete itself is an `update` that stamps `deletedAt`, and a
  future restore must be able to target an already-deleted row. `delete`/`update`/`create` pass
  through unchanged.
- **`findUnique` / `findUniqueOrThrow` are not filtered** — their `where` accepts only unique fields,
  so `deletedAt` cannot be added there. Convention: use `findFirst` for soft-delete-aware lookups by
  id (already the codebase style; no soft-deletable model uses `findUnique`).
- **Integration:** `PrismaService` (still the injected token) applies the extension in its
  constructor and returns a `Proxy` that routes model access (`prisma.user`, …) and the `$`-prefixed
  client methods to the *extended* client, while lifecycle methods (`$connect`/`$disconnect`) stay on
  the base instance and the extended client shares the one connection/pool. Services keep injecting
  `PrismaService` and calling `this.prisma.<model>` unchanged — only the redundant guards were
  removed.
- **Guards removed** from every read across the 11 services, including the create-time live-checks
  (`resolveActor`, `assertUserUsable`, `assertApplicationUsable`, `assertCategoryUsable`,
  `resolveCurrentUser`), which now rely on the extension to return `null` for a soft-deleted
  reference (so they still answer 400 "not a live …").

## Consequences

- **Positive:** soft-delete filtering is enforced **centrally and by default**; a newly written read
  cannot forget it; services are simpler; the live-checks keep their behaviour for free.
- **Implicit behaviour:** the filter is no longer visible at the call site — readers must know the
  extension exists (documented here and in [[code-conventions]]). **A future model with a `deletedAt`
  column must be added to `SOFT_DELETABLE_MODELS`**, or its reads won't be filtered.
- **`findUnique` bypasses the filter** (caveat above) — a deliberate, documented limitation.
- **Nested relation reads are not filtered:** query extensions only intercept top-level operations,
  so a soft-deletable relation loaded via `include`/`select` is not auto-scoped. No service relied on
  nested `deletedAt` filtering today, so nothing regressed; revisit if an `include` must hide
  soft-deleted relations.

## Related

[[0006-soft-delete-and-auditing]] · [[0003-prisma-orm]] · [[0002-nestjs-backend]] ·
[[code-conventions]] · [[prisma-migrations]]
