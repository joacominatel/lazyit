---
title: AssetHistory
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# AssetHistory

> ⚪ planned · Area: Assets (core) · Implementation order: 3

## Purpose

An **append-only** log of state changes for an [[asset]] — status transitions, location
moves, ownership changes, spec edits. Provides the "what changed, when, by whom?" trail
that auditing requires ([[problem-space]]).

## Relationships

- **belongs to** one [[asset]].
- May reference the [[user]] who caused the change (actor).

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted.
- Typically written by the application/service layer on every meaningful asset change
  (later possibly via a Prisma middleware / interceptor).

## Conventions

- **ID:** `autoincrement()` — log entity, never exposed externally ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only.

> [!note] No `updatedAt` / `deletedAt` here
> As an append-only log, this table intentionally **omits** `updatedAt` and `deletedAt` —
> per the accepted rule (split by mutability) in [[conventions]] and
> [[0006-soft-delete-and-auditing]].

Related: [[asset]] · [[asset-assignment]] · [[conventions]] · [[0006-soft-delete-and-auditing]]
