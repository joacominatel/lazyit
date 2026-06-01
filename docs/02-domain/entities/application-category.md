---
title: ApplicationCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# ApplicationCategory

> 🟢 implemented · Area: Access · Implementation order: 5

## Purpose

A grouping for [[application]]s — SaaS, Internal, Service, Third Party, Infrastructure, Other.
Organizes the application catalog for browsing. **User-managed**, exactly like [[asset-category]]
and [[article-category]]: created, edited and soft-deleted from the app; the seed set is just an
initial, non-special list.

## Relationships

- **groups** N [[application]]s — via `Application.categoryId`, an **optional** FK with
  `onDelete: SetNull`.

## Business rules

- `name` is unique among **live** rows only; a soft-deleted name is freed for reuse / restore
  ([[0041-soft-delete-reuse-and-restore]]).
- Seeded with six starter categories (SaaS, Internal, Service, Third Party, Infrastructure, Other)
  with heroicon `icon`s and an `order`. The seed is idempotent (find-among-live-then-create, never
  clobbers edits) — see `apps/api/prisma/seed.ts`.
- **Deleting a category is always allowed** (soft delete). Because `Application.categoryId` is an
  optional `SetNull` FK, deleting a category simply **detaches** its applications — it never orphans
  a required relation, so there is **no `409` guard** (contrast [[article-category]], whose FK is
  `Restrict`). See [[0023-access-management-design]].
- Soft delete ([[0006-soft-delete-and-auditing]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `ApplicationCategory` → table `application_categories`. Validation schemas
(`ApplicationCategorySchema`, `CreateApplicationCategorySchema`, `UpdateApplicationCategorySchema`)
live in `@lazyit/shared` (`packages/shared/src/schemas/application-category.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | Required. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted name is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). |
| `description` | `string?` | optional. |
| `icon` | `string?` | a heroicon name for the web UI (e.g. "CloudIcon"). Not validated. |
| `order` | `int?` | optional sort key for listings; nulls sort last. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

## Endpoints

`apps/api/src/application-categories/` (`ApplicationCategoriesModule`): `GET /application-categories`
(excludes soft-deleted, ordered by `order` then `name`), `GET /application-categories/:id`, `POST`,
`PATCH /:id`, `DELETE /:id` (soft delete; detaches its applications), `POST /:id/restore`
(ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]). Bodies validated against
the shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[application]] · [[asset-category]] · [[article-category]] · [[shared-package]] ·
[[0023-access-management-design]] · [[0006-soft-delete-and-auditing]] ·
[[0018-api-documentation-swagger]]
