---
title: ArticleVersion
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# ArticleVersion

> ⚪ planned · Area: Knowledge Base · Implementation order: 7

> [!note] Explicitly deferred (not just unbuilt)
> The Knowledge Base ships **without versioning** by decision ([[0021-knowledge-base-design]]):
> a simple wiki for small teams. [[article]] overwrites its `content` in place. This note records
> the intended shape *when* versioning is added — a **non-destructive** future addition (a new
> table with an FK from [[article]], no reshaping of `Article`).

## Purpose

A historical snapshot of an [[article]]'s content. Each edit would create a new version, so the
KB gains a full revision history ("what did this runbook say last quarter?").

## Relationships

- **belongs to** one [[article]].
- **authored by** one [[user]].

## Business rules

- **Append-only** in spirit: a version, once written, is not edited — a new version is
  created instead.
- The parent [[article]] points at (or derives) its current version.

## Conventions

- **ID:** `autoincrement()` works for an ordered version log; `cuid()` acceptable if
  versions are referenced externally — confirm at implementation ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` (+ `updatedAt` only if versions are ever mutable; default
  append-only → `createdAt` only, per [[0006-soft-delete-and-auditing]]).

Related: [[article]] · [[article-category]] · [[0021-knowledge-base-design]] ·
[[0006-soft-delete-and-auditing]]
