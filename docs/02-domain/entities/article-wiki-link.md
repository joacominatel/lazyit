---
title: ArticleWikiLink
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# ArticleWikiLink

> 🟢 implemented · Area: Knowledge Base · Implementation order: tbd

## Purpose

A **materialized article↔article edge** — one row per `[[slug]]` reference found in an
[[article]]'s body — computed on save to power **backlinks** ("what references this article?") and
fast link resolution. Introduced in [[0059-kb-folders-links-and-import]]. Distinct from
[[article-link]] (the IT-native article↔asset/application join): this is article↔**article**.

## Relationships

- **from** one source [[article]] (`sourceArticleId`).
- **to** a target identified by **`targetSlug`** (the raw `[[slug]]`), with a nullable
  **`resolvedTargetId`** → [[article]] (filled when the slug currently resolves to a live article).
- An **unresolved** `[[slug]]` (no live target) is **render-time state** — a non-clickable token with
  a tooltip — **not** a hard FK; the edge row still exists with `resolvedTargetId` null.

## Business rules

- **Rebuilt on save, in the write transaction.** On every article write that **changes `content`**
  (create / a content-changing edit / import) the source's edges are **hard-rebuilt** — `deleteMany
  where sourceArticleId` then `createMany` one row per **distinct** parsed `[[slug]]` — **inside the
  same `$transaction`** as the article + version snapshot, so the edge can never drift from the body
  ([[0042-article-versioning-and-linking]] discipline). A metadata/title-only edit leaves the edges
  untouched. The `[[slug]]` parser + de-dup is a **pure shared util** (`parseWikiLinks` in
  `@lazyit/shared`); it strips a `|display` alias and a `#heading` anchor and `slugify`s the target.
- **Best-effort resolution.** Each `targetSlug` is resolved to a **live** article id in one query
  (`resolvedTargetId`), else null — a forward reference. A save never blocks on an unresolved slug.
- **Backlinks** ("References") are the reverse read: all rows whose `resolvedTargetId` = an article
  (`GET /articles/:id/backlinks`), returning the **source** id/slug/title for the list.
- **Access still applies** — the backlink read **404s if the target isn't readable** and **ANDs the
  source visibility gate** (a draft source's backlink never leaks to a non-author —
  [[0022-draft-visibility-auth-shim]]); soft-deleted sources are excluded by the automatic read filter
  ([[0032-soft-delete-middleware]]). Folder access composes on top later (no-escalation, proposed
  **INV-9** — [[0060-kb-folder-access-control]]).
- **FKs:** `Cascade` from the source; `SetNull` on `resolvedTargetId` (a **hard-delete** safety net —
  a normal soft delete leaves it stale, harmless, re-resolved on the next rebuild).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` **only** — a current-state join, hard-rebuilt on save, not soft-deletable
  and not an append-only audit log ([[0006-soft-delete-and-auditing]]).

## Endpoints

`GET /articles/:id/backlinks` (any reader; 404 if the target isn't readable) — the "References"
section. There is **no** write endpoint: the edge is a derived projection rebuilt on the article
write. Schemas (`ArticleWikiLinkSchema`, `ArticleBacklinkSchema`) in `@lazyit/shared`; the parser is
`parseWikiLinks` (`@lazyit/shared/utils/wiki-link`).

## Implemented in #392; still deferred

- **Built (#392, ADR-0059 §3/§4):** the `article_wiki_links` table, the transactional rebuild-on-save
  (service + import worker), the backlinks read with the visibility gate, and the shared
  schemas/parser. Resolves the article↔article-links deferral from
  [[0042-article-versioning-and-linking]].
- **Built (#398, ADR-0059 §5):** the bulk `.zip` import's **best-effort intra-batch rewire**. After a
  `.zip` batch is created, the worker re-resolves still-unresolved edges (`resolvedTargetId IS NULL`)
  whose `targetSlug` matches a slug **minted earlier in the same batch** — so a forward-referencing
  cross-linked vault arrives already wired, not as a wall of tooltips. A slug nobody minted stays an
  unresolved forward reference (the §3 tooltip), never a failure.
- **Still deferred:** a **slug-change inbound-rewire** pass (a target slug edit can stale a link to an
  unresolved tooltip — never a wrong target); folder-access composition (#365); article↔location links.

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[folder]] · [[article-link]] · [[article-alias]] · [[0042-article-versioning-and-linking]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
