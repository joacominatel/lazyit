---
title: ArticleAlias
tags: [domain, entity]
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# ArticleAlias

> ⚪ planned · Area: Knowledge Base · Implementation order: tbd

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
  [[0060-kb-folder-access-control]]).
- **At most one alias per (folder, article)** — a `(folderId, articleId)` **partial-unique** index
  ([[0041-soft-delete-reuse-and-restore]] pattern); a duplicate is rejected.
- **Current-state, not auditable history** — created and **hard-DELETE**d (never edited, never
  soft-deleted), exactly like [[article-link]].

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` **only** — a current-state join, hard-deleted, not soft-deletable and
  not an append-only audit log ([[0006-soft-delete-and-auditing]]).

## Not yet implemented

- Planned — not yet built; tracked by issue #364 ([[0059-kb-folders-links-and-import]]). An
  access-granting alias variant is explicitly **out of MVP scope** (aliases never widen access).

Related: [[0059-kb-folders-links-and-import]] · [[0060-kb-folder-access-control]] · [[article]] ·
[[folder]] · [[article-link]] · [[article-wiki-link]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[INVARIANTS]]
