---
title: ArticleVersion
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# ArticleVersion

> ⚪ planned · Area: Knowledge Base · Implementation order: 7

## Purpose

A historical snapshot of an [[article]]'s content. Each edit creates a new version, so the
KB has a full revision history ("what did this runbook say last quarter?").

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

Related: [[article]] · [[article-category]] · [[0006-soft-delete-and-auditing]]
