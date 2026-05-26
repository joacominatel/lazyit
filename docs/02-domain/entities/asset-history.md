---
title: AssetHistory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-26
---

# AssetHistory

> 🟢 implemented · Area: Assets (core) · Implementation order: 3 · see [[0033-asset-history-event-model]]

## Purpose

An **append-only** log of discrete state changes for an [[asset]] — creation, status transitions,
location / model moves, spec edits, ownership changes (assign / release) and soft-delete. Provides
the "what changed, when, by whom?" trail that auditing requires ([[problem-space]]).

## Fields

- `id` — `autoincrement()`; a log id, never exposed externally ([[0005-id-strategy]]).
- `assetId` — FK → [[asset]], required, `onDelete: Restrict` (an asset with history can't be
  hard-deleted; soft delete bypasses it).
- `eventType` — `AssetHistoryEventType` enum (below).
- `payload` — optional jsonb; contextual data (e.g. `{ from, to }` on `STATUS_CHANGED`,
  `{ userId }` on `ASSIGNED`). Unvalidated, same debt as `Asset.specs` ([[0007-flexible-asset-specs-jsonb]]).
- `performedById` — optional FK → [[user]], `onDelete: SetNull`; the actor, from the `X-User-Id`
  shim ([[0022-draft-visibility-auth-shim]]). `null` = system / unknown.
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Events (`AssetHistoryEventType`)

`CREATED` · `STATUS_CHANGED` · `ASSIGNED` · `RELEASED` · `LOCATION_CHANGED` · `MODEL_CHANGED` ·
`SPECS_CHANGED` · `DELETED` · `RESTORED` (reserved — no restore endpoint emits it yet).

## Emission

**Explicit service calls** (no interceptor), **transactional** with the change ([[0033-asset-history-event-model]]):

- [[asset]] service — `CREATED` (create); per-field `STATUS_CHANGED` / `LOCATION_CHANGED` /
  `MODEL_CHANGED` / `SPECS_CHANGED` (update diff, one event per changed field); `DELETED` (soft delete).
- [[asset-assignment]] service — `ASSIGNED` (open) and `RELEASED` (release).

## Endpoint

`GET /assets/:id/history?limit=&before=` — newest first; `limit` defaults to 50 (max 100); `before`
is an exclusive cursor on the autoincrement id. 404 if the asset is missing or soft-deleted.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted.

## Conventions

- **ID:** `autoincrement()` — log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (no `updatedAt` / `deletedAt`, [[0006-soft-delete-and-auditing]]).

Related: [[asset]] · [[asset-assignment]] · [[user]] · [[0033-asset-history-event-model]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[0022-draft-visibility-auth-shim]]
