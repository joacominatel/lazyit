---
title: ArticleCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# ArticleCategory

> 🟢 implemented · Area: Knowledge Base · Implementation order: 7

> [!note] Now hierarchical — the [[folder]] (KB v2)
> [[0059-kb-folders-links-and-import]] evolved this category into the hierarchical [[folder]]
> (shipped #392): a self-ref `parentId` gives a tree, and the existing **required
> one-category-per-article FK is the one home [[folder]] per article**. Folder-name uniqueness is now
> per-parent (a live-only PARTIAL unique index on `(parentId, name)` — [[0041-soft-delete-reuse-and-restore]]),
> with a DFS **cycle guard** and a **no-silent-orphan** child-folder 409. The **model and table keep
> the names `ArticleCategory` / `article_categories`** and the endpoints stay `/article-categories`
> (the rename to `Folder` / `folders` is a follow-up). The folder is also the **access boundary**
> ([[0060-kb-folder-access-control]], #365 — not yet built) — a bounded, named data-scoping axis layered
> on the unchanged `article:read` capability, a deliberate carve-out from the per-record-ACL rejection
> of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]. The fields/rules below add the `parentId`
> tree; see [[folder]] for the full hierarchical entity.

## Purpose

A grouping for knowledge-base [[article]]s — Networking, Servers, Procedures, Troubleshooting, …
Organizes the KB for browsing. **User-managed**, exactly like [[asset-category]]: created, edited
and soft-deleted from the app; the seed set is just an initial, non-special list.

## Relationships

- **groups** N [[article]]s — via `Article.categoryId`, a **required** FK with `onDelete: Restrict`.
- **parent of / child of** other categories (folders) via the self-ref `parentId` (#392; nullable, a
  root has none; `onDelete: SetNull` hard-delete safety net).

## Business rules

- `name` is unique among **live** rows only, scoped to the **parent** (#392) — a live-only PARTIAL
  unique index on `(parentId, name) WHERE "deletedAt" IS NULL`, `NULLS NOT DISTINCT` so the root level
  still rejects duplicate names ([[0041-soft-delete-reuse-and-restore]]). A soft-deleted name is freed
  for reuse / restore within its parent.
- **No cycles** (#392) — a folder may not be its own ancestor; a reparent that would close a loop is a
  **400** (a DFS walk up the chain, like the manager chain — [[0058-user-manager-and-clone-actions]]).
- Seeded with eight starter categories (Networking, Servers, Access Management, Datacenter,
  Procedures, Troubleshooting, Onboarding, Tools) with heroicon `icon`s and a `order`. The seed is
  idempotent (find-among-live-then-create, never clobbers edits) — see `apps/api/prisma/seed.ts`.
- **Deleting a category that still has live articles is refused with `409`.** `categoryId` is a
  required FK, so orphaning is impossible; reassign or delete those articles first.
- **Deleting a category that still has live CHILD folders is refused with `409`** (#392) — a non-empty
  subtree is never silently orphaned; reparent or delete the children first.
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
| `name` | `string` | Required. Unique among **live** rows only, **per parent** (#392) — a PARTIAL unique index on `(parentId, name) WHERE "deletedAt" IS NULL`, `NULLS NOT DISTINCT` (raw SQL; no `@unique`), so a soft-deleted name is freed within its parent ([[0041-soft-delete-reuse-and-restore]]). |
| `parentId` | `cuid?` | self-ref FK → ArticleCategory (#392). `null` = a **root** folder. `onDelete: SetNull` (hard-delete safety net). `@@index([parentId])`. |
| `description` | `string?` | optional. |
| `icon` | `string?` | a heroicon name for the web UI (e.g. "ServerStackIcon"). Not validated. |
| `order` | `int?` | optional sort key for sidebar/listings; nulls sort last. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

## Endpoints

`apps/api/src/article-categories/` (`ArticleCategoriesModule`): `GET /article-categories` (excludes
soft-deleted, ordered by `order` then `name`), `GET /article-categories/:id`, `POST` (optional
`parentId` → nest; absent = root; `400` if the parent isn't live), `PATCH /:id` (`parentId` nullable —
`null` moves to root, a cuid reparents; `400` on a cycle), `DELETE /:id` (soft delete; `409` if the
folder still has live articles **or** live child folders), `POST /:id/restore` (ADMIN-only — clears
`deletedAt`, [[0041-soft-delete-reuse-and-restore]]). Bodies validated against the shared schemas and
documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[article]] · [[folder]] · [[asset-category]] · [[shared-package]] ·
[[0021-knowledge-base-design]] · [[0059-kb-folders-links-and-import]] ·
[[0060-kb-folder-access-control]] · [[0019-asset-assignment-integrity]] ·
[[0006-soft-delete-and-auditing]] · [[0018-api-documentation-swagger]]
