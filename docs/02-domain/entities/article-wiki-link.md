---
title: ArticleWikiLink
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# ArticleWikiLink

> ⚪ planned · Area: Knowledge Base · Implementation order: tbd

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

- **Rebuilt on save.** On every article write the source's edges are **hard-rebuilt** from the
  parsed body (delete-then-insert) — the table is a derived projection, never hand-edited.
- **Backlinks** are the reverse read: all rows whose `resolvedTargetId` = an article power its
  "References" / backlinks section.
- **Access still applies** — a backlink/edge never reveals an article the caller can't access
  (folder access + draft visibility compose; no-escalation, proposed **INV-9** —
  [[0060-kb-folder-access-control]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` **only** — a current-state join, hard-rebuilt on save, not soft-deletable
  and not an append-only audit log ([[0006-soft-delete-and-auditing]]).

## Not yet implemented

- Planned — not yet built; tracked by issue #364 ([[0059-kb-folders-links-and-import]]). Resolves the
  article↔article-links deferral from [[0042-article-versioning-and-linking]]. article↔location links
  remain deferred.

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[folder]] · [[article-link]] · [[article-alias]] · [[0042-article-versioning-and-linking]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
