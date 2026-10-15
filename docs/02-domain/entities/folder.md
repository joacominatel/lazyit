---
title: Folder
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-10-14
---

# Folder

> 🟢 implemented (structure + access + cascade delete) · Area: Knowledge Base · Implementation order: tbd

> [!note] The flat [[article-category]] evolved
> `Folder` is the hierarchical successor to the flat [[article-category]]
> ([[0059-kb-folders-links-and-import]]): it adds a self-ref `parentId` (a tree) and the existing
> required one-category-per-article FK becomes the **one home folder per article**. It is also the
> KB **access boundary** ([[0060-kb-folder-access-control]]). The **structure** — the tree, the
> per-parent name uniqueness, the cycle/orphan guards — shipped in #392; the **access layer** — the
> `accessRules` jsonb column, the DB-first read evaluator, the 404-not-403 existence-hiding, the
> no-escalation alias check and the search-leak fix — shipped in #404; the **cascade delete** shipped
> in #415. The Prisma **model and table keep the names `ArticleCategory` / `article_categories`** and
> the endpoints stay `/article-categories` — only the self-FK + the `accessRules` column were added;
> the rename to `Folder` / `folders` is a deliberate follow-up. See [[article-category]] for the (now
> hierarchical) model; the ADRs hold the full detail.

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
- **No cycles** — a folder may not be its own ancestor. On reparent the service walks the subject's
  subtree (the same guard the manager chain — [[0058-user-manager-and-clone-actions]] — and the
  workflow step graph — [[0054-applications-workflow-engine]] §8 — use); a proposed parent inside it is a
  **400**. The walk covers **soft-deleted** folders too, so a deleted folder in the chain cannot hide a
  loop its later restore would close, and it is cycle-safe, so a loop already in the data still ends. A
  new folder has no children, so a create can't cycle.
- **Tree writes are serialized** (audit 2026-10-10, AUD-010/AUD-023) — every write that changes the
  tree's shape (a move, a nested create, a delete, a cascade delete, a restore) runs its checks and its
  write in **one transaction** holding a single transaction-scoped Postgres **advisory lock** on the
  folder tree. Two opposing moves therefore cannot both pass the cycle check, and a sub-folder cannot be
  created under a folder that is being deleted. A delete also locks its folder rows `FOR UPDATE`, which
  waits out an article insert already in flight into them (the FK's key-share lock) so the emptiness
  check or the cascade sees it. Article creation does not lock its folder yet, so an article whose
  folder check ran before the delete began can still land after it (the open half of AUD-023).
- **Restore needs a live parent** (AUD-022) — restoring a sub-folder whose parent is still soft-deleted
  is a **409**: restore the parent first. Restores do not cascade ([[0041-soft-delete-reuse-and-restore]]),
  so without this a folder could come back live under a deleted one, unreachable for every non-admin.
  Folders already left in that state by an earlier restore keep loading exactly as before.
- **No silent orphaning on delete (non-cascade)** — soft-deleting a folder that still has live
  **child folders** is a **409** (same posture as the existing live-articles 409). Reparent or delete
  the children first. Both guards are application logic: the soft delete (UPDATE deletedAt) never fires
  the FK referential action, so the schema FKs are only hard-delete safety nets.
- **Cascade delete** (#415) — `DELETE /article-categories/:id?cascade=true` (`category:delete`,
  ADMIN-only) soft-deletes the folder, **all descendant folders** (full subtree, cycle-safe walk), and **all
  articles** whose home `categoryId` is anywhere in that subtree, in a **single `$transaction`**.
  Hard-deletes all [[article-alias]] rows whose `folderId` is in the deleted subtree OR whose
  `articleId` points to a newly soft-deleted article (dead aliases are pure noise). Returns
  `{ deletedFolders: number, deletedArticles: number }`. Idempotent/safe: 404 if the folder is
  already deleted or non-existent; an empty folder cascades cleanly (`{ deletedFolders: 1,
  deletedArticles: 0 }`). The author-only article gate is bypassed (ADMIN folder operation). Stale
  `ArticleWikiLink.resolvedTargetId` values pointing at soft-deleted articles are left in place — the
  read paths already filter these (ADR-0059 §3/§4). Each article the cascade soft-deletes is **deindexed
  from Meilisearch** post-commit (fire-and-forget, mirroring the single-article delete path), so the
  cascade never leaves **ghost search hits** behind (#595).
- **One home folder per article** (the evolved required FK); aliases provide additional, nav-only
  appearances.
- **Bulk `.zip` import mirrors the archive's tree into folders** (#398, [[0059-kb-folders-links-and-import]]
  §5). A `.zip`'s nested directories are **find-or-created** as folders under the chosen root home
  folder — walking segment by segment, find-or-create by `(parentId, name)` among live rows (honouring
  the per-parent partial-unique), so the same name under two parents (`Servers/Linux` vs
  `Workstations/Linux`) yields two distinct folders. A folder created mid-import is reused for sibling
  entries (a path cache), so the tree is built once per job inside the sandboxed worker child.
- **Access attaches to the folder, not to article rows** — a deliberate, bounded carve-out from the
  per-record-ACL rejection of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]. The restriction is
  stored on the folder as a **`accessRules` jsonb** column: `null`/empty = **PUBLIC** (default — any
  authenticated `article:read` holder), or an **OR-combined** list of the CLOSED rule vocabulary
  (`users` / `role` / `appGrant` / `assetAssignment`, validated by zod in `@lazyit/shared`). Evaluated
  **DB-first at the API** (`FolderAccessService`), enforced at the **DB** (the dynamic `appGrant` /
  `assetAssignment` kinds resolve via the **live** [[access-grant]] `revokedAt IS NULL` /
  [[asset-assignment]] `releasedAt IS NULL` joins, so access **follows offboarding automatically**),
  never UI-only. A folder-hidden article returns **404, not 403** (existence-hiding, reusing
  [[0022-draft-visibility-auth-shim]]). **Inherit-and-narrow** (§1): a child is at least as restricted
  as its nearest restricted ancestor and can never widen past it (effective rule = own ∩ ancestors').
  ADMIN keeps god-mode (INV-8); a [[service-account]] **fails closed** on a restricted folder (§8). The
  rules also gate **`/search`** (the article query is scoped **Meili-side** to the caller's visible
  folders so readable hits below the `limit` window are no longer dropped, #598; a per-caller in-app
  post-filter is **retained as a defense-in-depth backstop** for index lag — authz never relies on Meili
  alone) and the **alias** path (no-escalation: you can never alias an article you can't read). The
  read-path tree load is **memoized per request** (`FolderTreeCache`) — the static folder tree loads once
  per request, while the live grant/assignment joins still resolve fresh each call, so a revoked grant
  drops access on the next read with no staleness (#599). **INV-9** ([[0060-kb-folder-access-control]]).
- **Setting/clearing a folder's rules is `settings:manage`-gated** (ADMIN-only, `PUT
  /article-categories/:id/access-rules`) — re-scoping WHO may read a folder is an authorization-
  management action, distinct from `category:write` (authoring the folder itself).
- **The rule CONTENT is gated; the rule's EXISTENCE is not** (#1299, [[0060-kb-folder-access-control]]
  §3 amendment). `accessRules` itself is returned **only** to a `settings:manage` reader (#554);
  beside it, every folder read carries a **derived `hasAccessRules` boolean** readable by **any**
  `category:read` caller, VIEWER included. It is **computed at read time** from `accessRules` through
  the same `FolderAccessService` resolution the §4 evaluator uses — **no column, no migration, no
  stored value** — and it says only **that** the folder carries a restriction: never the rule kinds,
  the user list, the role, or any count. It is a fact about the **folder**, not about the reader:
  `true` is not "you cannot see this" (a caller inside the rule reads the folder normally and still
  sees `true`). It exists so the web can warn that **moving an article into or out of a restricted
  folder changes who may read it** (§9's widening confirmation, which cannot be rendered without it).
  On the wire the field is **optional**: a server that predates it omits it, and an absent value means
  *unknown*, never *public*.
- Soft delete ([[0006-soft-delete-and-auditing]]); reads filter `deletedAt: null`.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain entity).

## Endpoints

The endpoints stay `/article-categories` (`ArticleCategoriesModule`) — see [[article-category]] — with
`parentId` now accepted on create (optional; absent = root) and update (nullable; `null` = move to
root, a cuid = reparent). A reparent that would create a cycle is **400**; a delete of a folder with
live sub-folders is **409** (non-cascade), and so is restoring a sub-folder whose parent is still
deleted. **`DELETE /article-categories/:id?cascade=true`** (`category:delete`,
ADMIN-only) performs the cascade delete described above and returns `{ deletedFolders, deletedArticles }`.
**`PUT /article-categories/:id/access-rules`** (`settings:manage`, ADMIN-only) sets or clears the
folder's access rules (body `{ accessRules: <rule list> | null }`). Both folder reads (`GET /article-categories`
and `GET /article-categories/:id`) carry the derived **`hasAccessRules`** boolean for every
`category:read` caller, plus `accessRules` itself only for a `settings:manage` one; the list read also
carries the per-folder `articleCount` (`null` for a folder the caller cannot read).

## Implemented in #392 + #404 + #415; still deferred

- **Built (#392, ADR-0059 §1):** the `parentId` self-FK, the per-parent partial-unique name, the
  cycle guard, the no-silent-orphan child-folder 409, and `parentId` on the create/update/read wire
  shape (`@lazyit/shared` `Folder*` aliases over `ArticleCategory*`).
- **Built (#404, ADR-0060):** the `accessRules` jsonb column + the closed zod rule vocabulary
  (`FolderAccessRulesSchema`); the DB-first read evaluator (`FolderAccessService`) with the §2 PUBLIC
  fast-path, the §3 OR rules over live joins, §1 inherit-and-narrow, §5 ADMIN god-mode and §8 SA
  fail-closed; the article read-path 404-not-403 gate; the no-escalation alias re-check; and the
  `/search` per-caller folder-access post-filter (the search-leak fix). The per-folder rule **editor
  UI** is a separate frontend slice.
- **Hardened (#598/#599/#595):** the `/search` article query is now scoped **Meili-side**
  (`categoryId IN [...]`) so readable hits below the `limit` window are returned and `total` is the
  engine's readable count (the in-app post-filter is kept as a defense-in-depth backstop, #598); the
  read-path folder-tree load is **memoized per request** while live joins stay dynamic (#599); and a
  **cascade folder delete deindexes** its soft-deleted articles from Meilisearch (no ghost hits, #595).
- **Built (#415):** the `?cascade=true` flag on `DELETE /:id` — subtree walk, single-transaction
  soft-delete of all descendant folders + articles, hard-delete of all alias rows in the subtree
  (folder-side and article-side), ADMIN-only (same `category:delete` gate), returns
  `{ deletedFolders, deletedArticles }`.
- **Built (#1299, ADR-0060 §3/§9 amendment):** the derived **`hasAccessRules`** flag on both folder
  reads — an additive, read-only, computed field (`FolderAccessService.restrictedFolderIds`) that
  shares the request-scoped folder-tree load with the §4 evaluation, so the list read pays no extra
  query. The `settings:manage` gate on `accessRules` itself is unchanged.
- **Built (#1539):** `GET /articles?categoryId=…&includeSubfolders=true` lists a folder's whole live
  subtree — one query over the live folder tree, walked in memory and cycle-safe, with the §4 folder
  pin still ANDed on top, so a restricted descendant stays out for a caller who cannot read it. A
  `/search` article hit that survives the folder post-filter now ships its `categoryId` (a folder the
  caller can already read) instead of having it stripped; dropped hits are unchanged.
- **Still deferred:** the `ArticleCategory` → `Folder` model/table **rename** is a follow-up (a
  separate migration); a guided-reparent UX on delete (the rule is "no silent orphaning"; the mechanism
  is the 409 today); the Phase-2 alias-as-share (§7, reserved).

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[article-category]] · [[article-alias]] · [[article-wiki-link]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
