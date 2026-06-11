---
title: Folder
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# Folder

> ⚪ planned · Area: Knowledge Base · Implementation order: tbd

> [!note] The flat [[article-category]] evolved
> `Folder` is the hierarchical successor to the flat [[article-category]]
> ([[0059-kb-folders-links-and-import]]): it adds a self-ref `parentId` (a tree) and the existing
> required one-category-per-article FK becomes the **one home folder per article**. It is also the
> KB **access boundary** ([[0060-kb-folder-access-control]]). See [[article-category]] for the
> current flat model; the ADRs hold the full detail.

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

- **Folder-name uniqueness is per parent** — a live-only **PARTIAL** unique index
  `WHERE "deletedAt" IS NULL` (raw SQL, never a PSL `@unique` — [[0041-soft-delete-reuse-and-restore]]),
  so a soft-deleted name is freed for reuse/restore.
- **One home folder per article** (the evolved required FK); aliases provide additional, nav-only
  appearances.
- **Access attaches to the folder, not to article rows** — a deliberate, bounded carve-out from the
  per-record-ACL rejection of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]. Evaluated **DB-first
  at the API**, enforced at the **DB**, never UI-only; a folder-hidden article returns **404, not
  403** (existence-hiding, reusing [[0022-draft-visibility-auth-shim]]). ADMIN keeps god-mode (INV-8).
  Proposed **INV-9** ([[0060-kb-folder-access-control]]).
- Soft delete ([[0006-soft-delete-and-auditing]]); reads filter `deletedAt: null`.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain entity).

## Not yet implemented

- Planned — not yet built; tracked by issue #364 ([[0059-kb-folders-links-and-import]]). The access
  layer is #365 ([[0060-kb-folder-access-control]]).

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[article-category]] · [[article-alias]] · [[article-wiki-link]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
