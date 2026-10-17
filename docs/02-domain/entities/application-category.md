---
title: ApplicationCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-15
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
- **Delete with one resolution (AUD-085).** While live applications are filed under the category, the
  delete needs **one** resolution for all of them: `detach` (they keep no category) or `move` (they all
  go to another live application category, not the one being deleted — `400` otherwise). Without one
  it is a `409` `DELETE_RESOLUTION_REQUIRED` with the count. The move and the soft delete share one
  transaction; applications have no history table, so nothing else is written. Archived applications
  keep their reference, and restoring the category re-links nothing. The `SetNull` FK only matters
  for a hard delete, which the API never issues. See [[0023-access-management-design]].
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
| `usageCount` | `int?` | **read-only, computed — not a column** (#1540). Only on `GET /application-categories`: the number of **live** applications filed under this category; `0` when unused. Absent from `GET /:id` and the write responses. |

## Endpoints

`apps/api/src/application-categories/` (`ApplicationCategoriesModule`): `GET /application-categories`
(excludes soft-deleted, ordered by `order` then `name`; each row carries the computed `usageCount`, so
Settings → Taxonomies shows what is in use before an archive), `GET /application-categories/:id`, `POST`,
`PATCH /:id`, `GET /:id/delete-impact` (`category:delete` — the count plus the first 50 applications
when the caller may read applications), `DELETE /:id` (soft delete; `?strategy=detach` or
`?strategy=move&targetId=`, see above), `POST /:id/restore`
(ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]). Bodies validated against
the shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[application]] · [[asset-category]] · [[article-category]] · [[shared-package]] ·
[[0023-access-management-design]] · [[0006-soft-delete-and-auditing]] ·
[[0018-api-documentation-swagger]]
