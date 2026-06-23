---
title: ArticleVersion
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-06-23
---

# ArticleVersion

> 🟢 implemented · Area: Knowledge Base · Implementation order: 7

> [!note] Now implemented (was deferred)
> The KB MVP shipped without versioning ([[0021-knowledge-base-design]]) and [[article]] overwrote
> its `content` in place. [[0042-article-versioning-and-linking]] adds this **append-only** table —
> a non-destructive addition (a new table + FK, no reshaping of `Article`), restoring auditability
> ([[0006-soft-delete-and-auditing]]). Earlier docs wrongly implied this table already existed; it
> did not until [[0042-article-versioning-and-linking]].

## Purpose

A historical, **append-only** snapshot of an [[article]]'s editable state. Every create/edit that
changes a versioned field writes a new version, so the KB gains a full revision history ("what did
this runbook say last quarter?"). A bad edit no longer destroys the prior body.

## Relationships

- **belongs to** one [[article]] (`articleId`, **required** FK, `onDelete: Restrict` — an article
  with version history cannot be hard-deleted; it can still be soft-deleted, an UPDATE).
- **edited by** an optional [[user]] (`editedById`, `onDelete: SetNull`) — the actor who produced
  this revision (creator on v1, editor afterwards). A [[service-account]] can **never** author here:
  `Article.authorId` is a non-null [[user]] FK and the author-only gate is `User`-identity equality, so
  the article write path 403s an SA principal. The additive `serviceAccountId` actor column (the unified
  two-actor model + CHECK) is therefore **schema-present but unreachable by design**
  ([[INVARIANTS]] INV-SA-4).

## Business rules

- **Append-only** (like [[asset-history]]): a version is written once and **never** updated,
  deleted or soft-deleted. No `updatedAt`/`deletedAt`.
- **`version`** is monotonic **per article**: `1` on create/import, then `2`, `3`, … Allocated as
  `max(version)+1` **inside the same transaction** as the article write; the `@@unique([articleId,
  version])` is the hard guarantee against a concurrent double-allocation.
- **A snapshot is written when a versioned field changes** — `title`, `content`, `excerpt` or
  `status`:
  - `create` / `import` → **version 1**;
  - `PATCH` (`update`) → only when `title`/`content`/`excerpt` actually change (a metadata-only or
    no-op edit writes **no** version; `PATCH` never touches `status`);
  - `publish` / `unpublish` → snapshot (they change `status`); an idempotent no-op does not.
- **Visibility mirrors the article reads.** A DRAFT's history is visible only to its author (404 to
  anyone else), so a private draft's snapshots never leak ([[0022-draft-visibility-auth-shim]]).
- **No rollback** yet — this records history; replaying a past version onto the live article is
  deferred ([[0042-article-versioning-and-linking]]).

## Conventions

- **ID:** `autoincrement()` — an append-only log/history table, never exposed externally
  ([[0005-id-strategy]]). The externally meaningful key is `(articleId, version)`.
- **Timestamps:** `createdAt` only (append-only — [[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ArticleVersion` → table `article_versions`. Validation schema
(`ArticleVersionSchema`, `ArticleVersionPageSchema`) lives in `@lazyit/shared`
(`packages/shared/src/schemas/article-version.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `@default(autoincrement())`; a log id (not exposed as the natural key). |
| `articleId` | `cuid` | required FK → [[article]], `onDelete: Restrict`. |
| `version` | `int` | monotonic per article (1 on create). `@@unique([articleId, version])`. |
| `title` | `string` | frozen copy. |
| `content` | `text` | frozen copy (the markdown body). |
| `excerpt` | `string?` | frozen copy. |
| `status` | `ArticleStatus` | frozen copy (`DRAFT` \| `PUBLISHED`). |
| `editedById` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`. The **human** editor. |
| `serviceAccountId` | `cuid?` | optional FK → [[service-account]], `onDelete: SetNull`; unified two-actor model + at-most-one-actor CHECK. **Unreachable in practice** — the article write path 403s an SA author. |
| `createdAt` | `datetime` | `@default(now())`. |

Indexes: `@@unique([articleId, version])` (natural key + per-article timeline).

## Endpoints

`apps/api/src/articles/` (`ArticlesModule`). Read-only — versions are produced internally by the
service, never created/edited via the API.

- `GET /articles/:id/versions` — paginated version history ([[0030-list-pagination-contract]]),
  newest version first. Drafts visible only to their author (404 otherwise).
- `GET /articles/:id/versions/:version` — a single version by its per-article number (404 if absent
  or the article isn't readable by the caller).

Related: [[article]] · [[article-link]] · [[article-category]] · [[user]] · [[service-account]] ·
[[asset-history]] · [[0042-article-versioning-and-linking]] · [[0021-knowledge-base-design]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[0030-list-pagination-contract]] ·
[[0022-draft-visibility-auth-shim]] · [[0048-service-accounts]] · [[INVARIANTS]]
