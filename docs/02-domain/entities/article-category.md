---
title: ArticleCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# ArticleCategory

> 🟢 implemented · Area: Knowledge Base · Implementation order: 7

> [!note] Evolving into [[folder]] (KB v2)
> [[0059-kb-folders-links-and-import]] evolves this **flat** `ArticleCategory` into the hierarchical
> [[folder]]: a self-ref `parentId` gives a tree, and the existing **required one-category-per-article
> FK becomes the one home [[folder]] per article**. Folder-name uniqueness becomes per-parent (a
> live-only PARTIAL unique index — [[0041-soft-delete-reuse-and-restore]]). The folder is also the
> **access boundary** ([[0060-kb-folder-access-control]]) — a bounded, named data-scoping axis layered
> on the unchanged `article:read` capability, a deliberate carve-out from the per-record-ACL rejection
> of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]. The content below describes the current flat
> model; see [[folder]] for the evolved entity.

## Purpose

A grouping for knowledge-base [[article]]s — Networking, Servers, Procedures, Troubleshooting, …
Organizes the KB for browsing. **User-managed**, exactly like [[asset-category]]: created, edited
and soft-deleted from the app; the seed set is just an initial, non-special list.

## Relationships

- **groups** N [[article]]s — via `Article.categoryId`, a **required** FK with `onDelete: Restrict`.

## Business rules

- `name` is unique among **live** rows only; a soft-deleted name is freed for reuse / restore
  ([[0041-soft-delete-reuse-and-restore]]).
- Seeded with eight starter categories (Networking, Servers, Access Management, Datacenter,
  Procedures, Troubleshooting, Onboarding, Tools) with heroicon `icon`s and a `order`. The seed is
  idempotent (find-among-live-then-create, never clobbers edits) — see `apps/api/prisma/seed.ts`.
- **Deleting a category that still has live articles is refused with `409`.** `categoryId` is a
  required FK, so orphaning is impossible; reassign or delete those articles first.
- Soft delete ([[0006-soft-delete-and-auditing]]).

> [!note] The delete guard is application logic, not the FK
> Our `DELETE` is a **soft** delete (`UPDATE deletedAt`), which does **not** trigger the FK's
> `onDelete: Restrict` (that only fires on a hard row delete). So the "can't delete a category in
> use" rule is enforced by a `count` check in the service; the `Restrict` is a database-level
> safety net for stray hard deletes. Same pattern as [[asset-assignment]]
> ([[0021-knowledge-base-design]], [[0019-asset-assignment-integrity]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `ArticleCategory` → table `article_categories`. Validation schemas
(`ArticleCategorySchema`, `CreateArticleCategorySchema`, `UpdateArticleCategorySchema`) live in
`@lazyit/shared` (`packages/shared/src/schemas/article-category.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | Required. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted name is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). |
| `description` | `string?` | optional. |
| `icon` | `string?` | a heroicon name for the web UI (e.g. "ServerStackIcon"). Not validated. |
| `order` | `int?` | optional sort key for sidebar/listings; nulls sort last. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

## Endpoints

`apps/api/src/article-categories/` (`ArticleCategoriesModule`): `GET /article-categories` (excludes
soft-deleted, ordered by `order` then `name`), `GET /article-categories/:id`, `POST`,
`PATCH /:id`, `DELETE /:id` (soft delete; `409` if the category still has live articles),
`POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]). Bodies
validated against the shared schemas and documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[article]] · [[folder]] · [[asset-category]] · [[shared-package]] ·
[[0021-knowledge-base-design]] · [[0059-kb-folders-links-and-import]] ·
[[0060-kb-folder-access-control]] · [[0019-asset-assignment-integrity]] ·
[[0006-soft-delete-and-auditing]] · [[0018-api-documentation-swagger]]
