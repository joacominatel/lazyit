---
title: Folder
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# Folder

> 🟢 implemented (structure) · Area: Knowledge Base · Implementation order: tbd

> [!note] The flat [[article-category]] evolved
> `Folder` is the hierarchical successor to the flat [[article-category]]
> ([[0059-kb-folders-links-and-import]]): it adds a self-ref `parentId` (a tree) and the existing
> required one-category-per-article FK becomes the **one home folder per article**. It is also the
> KB **access boundary** ([[0060-kb-folder-access-control]]). The **structure** — the tree, the
> per-parent name uniqueness, the cycle/orphan guards — shipped in #392; **access semantics** remain
> #365's job. The Prisma **model and table keep the names `ArticleCategory` / `article_categories`**
> and the endpoints stay `/article-categories` — only a self-FK column was added; the rename to
> `Folder` / `folders` is a deliberate follow-up. See [[article-category]] for the (now hierarchical)
> model; the ADRs hold the full detail.

## Purpose

A node in the Knowledge Base hierarchy: the home of [[article]]s and other folders, and the unit at
which access is granted. Replaces the flat [[article-category]] with a real tree, so a 5–20-person
IT team can mirror its docs structure (Networking → Firewalls → …) and scope visibility per branch.

## Relationships

- **parent of / child of** other folders via self-ref `parentId` (nullable; a root folder has none).
- **home of** N [[article]]s — each article has **one home folder** (the evolved
  `Article.categoryId` → `folderId`, required FK).
- **also surfaces** [[article]]s living elsewhere via nav-only [[article-alias]] symlinks (aliases
  never widen access — [[0060-kb-folder-access-control]]).
- **access boundary** — the per-folder ACL that gates *which* articles a caller sees
  ([[0060-kb-folder-access-control]]); the `article:read` capability still gates whether they can
  act at all.

## Business rules

- **Folder-name uniqueness is per parent** — a live-only **PARTIAL** unique index on
  `(parentId, name) WHERE "deletedAt" IS NULL` (raw SQL, never a PSL `@unique` —
  [[0041-soft-delete-reuse-and-restore]]; it `DROP`s the old flat `name` partial unique and recreates
  it scoped to the parent), so `Servers/Linux` and `Workstations/Linux` coexist and a soft-deleted
  folder frees its name **within its parent** for reuse/restore. The index is `NULLS NOT DISTINCT`, so
  the **root** level (parentId NULL) still rejects two folders sharing a name — matching the prior flat
  behaviour.
- **No cycles** — a folder may not be its own ancestor. On create/reparent the service runs a **DFS
  walk up the chain** from the proposed parent (the same pattern the manager chain — [[0058-user-manager-and-clone-actions]]
  — and the workflow step graph — [[0054-applications-workflow-engine]] §8 — use); reaching the subject
  is a **400**. A new folder has no children, so a create can't cycle.
- **No silent orphaning on delete** — soft-deleting a folder that still has live **child folders** is a
  **409** (same posture as the existing live-articles 409). Reparent or delete the children first. Both
  guards are application logic: the soft delete (UPDATE deletedAt) never fires the FK referential
  action, so the schema FKs are only hard-delete safety nets.
- **One home folder per article** (the evolved required FK); aliases provide additional, nav-only
  appearances.
- **Bulk `.zip` import mirrors the archive's tree into folders** (#398, [[0059-kb-folders-links-and-import]]
  §5). A `.zip`'s nested directories are **find-or-created** as folders under the chosen root home
  folder — walking segment by segment, find-or-create by `(parentId, name)` among live rows (honouring
  the per-parent partial-unique), so the same name under two parents (`Servers/Linux` vs
  `Workstations/Linux`) yields two distinct folders. A folder created mid-import is reused for sibling
  entries (a path cache), so the tree is built once per job inside the sandboxed worker child.
- **Access attaches to the folder, not to article rows** — a deliberate, bounded carve-out from the
  per-record-ACL rejection of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]. Evaluated **DB-first
  at the API**, enforced at the **DB**, never UI-only; a folder-hidden article returns **404, not
  403** (existence-hiding, reusing [[0022-draft-visibility-auth-shim]]). ADMIN keeps god-mode (INV-8).
  Proposed **INV-9** ([[0060-kb-folder-access-control]]).
- Soft delete ([[0006-soft-delete-and-auditing]]); reads filter `deletedAt: null`.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain entity).

## Endpoints

The endpoints stay `/article-categories` (`ArticleCategoriesModule`) — see [[article-category]] — with
`parentId` now accepted on create (optional; absent = root) and update (nullable; `null` = move to
root, a cuid = reparent). A reparent that would create a cycle is **400**; a delete of a folder with
live sub-folders is **409**.

## Implemented in #392; still deferred

- **Built (#392, ADR-0059 §1):** the `parentId` self-FK, the per-parent partial-unique name, the DFS
  cycle guard, the no-silent-orphan child-folder 409, and `parentId` on the create/update/read wire
  shape (`@lazyit/shared` `Folder*` aliases over `ArticleCategory*`).
- **Still deferred:** the per-folder **access** layer is #365 ([[0060-kb-folder-access-control]]); the
  `ArticleCategory` → `Folder` model/table **rename** is a follow-up (a separate migration); a
  guided-reparent UX on delete (the rule is "no silent orphaning"; the mechanism is the 409 today).

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[article-category]] · [[article-alias]] · [[article-wiki-link]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
