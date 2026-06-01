---
title: ArticleLink
tags: [domain, entity]
status: accepted
created: 2026-06-01
updated: 2026-06-01
---

# ArticleLink

> 🟢 implemented · Area: Knowledge Base · Implementation order: 7

## Purpose

Associates an [[article]] with **either** an [[asset]] **or** an [[application]] — exactly one
target — making the KB IT-native: "the runbook for THIS server", "the access procedure for THIS
app". Introduced in [[0042-article-versioning-and-linking]].

## Relationships

- **belongs to** one [[article]] (`articleId`, **required** FK, `onDelete: Cascade`).
- **targets** exactly one of:
  - one [[asset]] (`assetId`, nullable FK, `onDelete: Cascade`), or
  - one [[application]] (`applicationId`, nullable FK, `onDelete: Cascade`).
- **created by** an optional [[user]] (`createdById`, `onDelete: SetNull`).

`Cascade` on all three because a link is meaningless without its endpoints and carries no audit
value — a (rare) hard-delete of an endpoint removes its links. Articles/assets/applications normally
**soft**-delete, so a link to a soft-deleted endpoint simply stops surfacing in reads (the read
filter hides the endpoint), it isn't removed.

## Business rules

- **Exactly one target.** `assetId` XOR `applicationId` — never both, never neither. Guaranteed by a
  DB **CHECK** (`article_links_exactly_one_target`); the zod `CreateArticleLinkSchema.refine` rejects
  a malformed body at the edge (400).
- **No duplicate links.** At most one link per `(article, target)` — two **partial unique indexes**
  (`article_links_article_asset_key` / `article_links_article_application_key`, each `WHERE` its
  target `IS NOT NULL`; a single composite unique can't work because NULLs are distinct in
  Postgres). Raw SQL in the migration, mirroring the AssetAssignment / soft-delete-reuse precedent
  ([[0041-soft-delete-reuse-and-restore]]). A duplicate `POST` returns 409.
- **Current-state, not auditable history.** A link is created (`POST`) and removed (`DELETE`, a hard
  delete) — never edited or soft-deleted. (If a change-trail is ever needed it becomes an
  append-only ledger — a later ADR.)
- **Author-only writes.** Only the article's author may add/remove links (same gate as edits); the
  route is `@Roles('ADMIN','MEMBER')` ([[0040-rbac-roles]]). The target must reference a **live**
  (non-soft-deleted) asset/application (400 otherwise).
- **Reads** are open to anyone who can read the article.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (a current-state join, not a soft-deletable entity and not an
  append-only audit log — [[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `ArticleLink` → table `article_links`. Validation schemas (`ArticleLinkSchema`,
`CreateArticleLinkSchema`) live in `@lazyit/shared` (`packages/shared/src/schemas/article-link.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `articleId` | `cuid` | required FK → [[article]], `onDelete: Cascade`. |
| `assetId` | `cuid?` | nullable FK → [[asset]], `onDelete: Cascade`. Set XOR `applicationId`. |
| `applicationId` | `cuid?` | nullable FK → [[application]], `onDelete: Cascade`. Set XOR `assetId`. |
| `createdById` | `uuid?` | optional FK → [[user]] (`@db.Uuid`), `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |

Constraints/indexes (raw SQL — Prisma can't express them): CHECK exactly-one-target; two partial
unique indexes (one per target); `@@index` on `articleId`, `assetId`, `applicationId`.

## Endpoints

`apps/api/src/articles/` and `apps/api/src/assets/` (`ArticlesModule` / `AssetsModule`).

- `POST /articles/:id/links` — add a link (body: `assetId` XOR `applicationId`). Author-only,
  `ADMIN`/`MEMBER`.
- `DELETE /articles/:id/links/:linkId` — remove a link (404 if it doesn't belong to the article).
  Author-only, `ADMIN`/`MEMBER`.
- `GET /articles/:id/links` — list an article's links (any reader of the article).
- `GET /assets/:id/articles` — reverse lookup: the **PUBLISHED** articles linked to an asset (lean
  list shape, no `content`).
- `GET /applications/:id/articles` — the application reverse lookup, symmetric to the asset one
  (PUBLISHED only, lean list shape). Shipped in the ADR-0030 amendment (2026-06-01).

Related: [[article]] · [[article-version]] · [[asset]] · [[application]] · [[user]] ·
[[0042-article-versioning-and-linking]] · [[0021-knowledge-base-design]] · [[0005-id-strategy]] ·
[[0006-soft-delete-and-auditing]] · [[0040-rbac-roles]] · [[0041-soft-delete-reuse-and-restore]]
