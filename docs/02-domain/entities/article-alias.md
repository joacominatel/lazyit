---
title: ArticleAlias
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# ArticleAlias

> 🟢 implemented · Area: Knowledge Base · Implementation order: tbd

## Purpose

A **nav-only symlink** that makes one [[article]] appear inside a [[folder]] other than its home —
so a single runbook can be browsed from several places without copying it. Introduced in
[[0059-kb-folders-links-and-import]]. Presentation only: an alias **never widens access**
([[0060-kb-folder-access-control]]).

## Relationships

- **places** one [[article]] (`articleId`) into one [[folder]] (`folderId`) — a current-state join,
  like [[article-link]].
- The aliased article keeps its own **home** [[folder]] and its own access scope; the alias only adds
  a navigation appearance.

## Business rules

- **No access-granting column in MVP** — an alias is purely navigational and can never grant access
  to an article the aliasing user can't already reach (**no-escalation**, proposed **INV-9** —
  [[0060-kb-folder-access-control]]). The table has only `(id, folderId, articleId, createdAt)`.
- **At most one alias per (folder, article)** — a `UNIQUE(folderId, articleId)` index (the join has no
  `deletedAt`, so a plain unique, not the partial form); a duplicate is a **409**.
- **No alias into the home folder** — the service rejects (**400**) an alias whose `folderId` equals the
  article's home `categoryId` (you cannot alias an article into its own home).
- **Author-only writes** — only the article's author may add/remove an alias (the same write gate as an
  edit, [[0022-draft-visibility-auth-shim]]).
- **Both FKs `Cascade`** — an alias is meaningless without its article or its folder and carries no
  audit value (the [[article-link]] posture exactly); a hard delete of either endpoint removes it.
- **Current-state, not auditable history** — created (`POST /articles/:id/aliases`) and
  **hard-DELETE**d (`DELETE /articles/:id/aliases/:aliasId`), never edited, never soft-deleted.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` **only** — a current-state join, hard-deleted, not soft-deletable and
  not an append-only audit log ([[0006-soft-delete-and-auditing]]).

## Endpoints

`apps/api/src/articles/` (on [[article]]'s controller): `POST /articles/:id/aliases` (author only;
400 if the folder is missing or the home folder; 409 on a duplicate), `DELETE
/articles/:id/aliases/:aliasId` (author only; hard delete; 404 if it isn't this article's alias),
`GET /articles/:id/aliases` (any reader of the article). Schemas (`ArticleAliasSchema`,
`CreateArticleAliasSchema`) in `@lazyit/shared`.

## Implemented in #392; still deferred

- **Built (#392, ADR-0059 §2):** the `article_aliases` table, the unique + reject-own-home + cascade
  semantics, and the create/delete/list endpoints + shared schemas.
- **Still deferred:** an access-granting alias variant is explicitly **out of scope** and reserved to
  [[0060-kb-folder-access-control]] (#365) — aliases never widen access.

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[folder]] · [[article-link]] · [[article-wiki-link]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
