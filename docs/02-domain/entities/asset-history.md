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
  `{ userId }` on **both `ASSIGNED` and `RELEASED`** — so a multi-owner asset's timeline can tell
  which owner was assigned/released). Unvalidated, same debt as `Asset.specs` ([[0007-flexible-asset-specs-jsonb]]).
- `performedById` — optional FK → [[user]], `onDelete: SetNull`; the **human** actor, resolved from the
  verified principal (`@CurrentPrincipal()` → `request.user`, not a token claim; the `X-User-Id` header
  is the dev-only shim path — [[0038-jit-user-provisioning]], [[0022-draft-visibility-auth-shim]]).
  `null` = system / unknown.
- `serviceAccountId` — optional FK → [[service-account]], `onDelete: SetNull`; the **non-human** actor
  when a service account performed the action ([[0048-service-accounts]]). A DB **CHECK** enforces
  *at most one* of (`performedById`, `serviceAccountId`) per row — honest attribution, never a fake human
  ([[INVARIANTS]] INV-SA-4). `ActorService.resolveActor(principal)` picks the right column.
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Events (`AssetHistoryEventType`)

`CREATED` · `STATUS_CHANGED` · `ASSIGNED` · `RELEASED` · `LOCATION_CHANGED` · `MODEL_CHANGED` ·
`SPECS_CHANGED` · `DELETED` · `RESTORED` (emitted by `POST /assets/:id/restore`, the counterpart of
`DELETED` — [[0041-soft-delete-reuse-and-restore]]) · `UPDATED` (the "updated via re-import" marker —
a bulk import that matches a live asset by serial UPDATEs it, and when no tracked dimension changed this
marker is written so the re-import still leaves one audit row; [[0069-migrator-import]] #1061).

## Emission

**Explicit service calls** (no interceptor), **transactional** with the change ([[0033-asset-history-event-model]]):

- [[asset]] service — `CREATED` (create); per-field `STATUS_CHANGED` / `LOCATION_CHANGED` /
  `MODEL_CHANGED` / `SPECS_CHANGED` (update diff, one event per changed field); `DELETED` (soft delete);
  `UPDATED` (re-import marker only — written by the migrator's serial-match update path when no per-field
  change event fired, so a no-delta re-import still audits; [[0069-migrator-import]] #1061).
- [[asset-assignment]] service — `ASSIGNED` (open) and `RELEASED` (release).

## Endpoint

`GET /assets/:id/history?limit=&before=` — newest first; `limit` defaults to 50 (max 100); `before`
is an exclusive cursor on the autoincrement id. 404 if the asset is missing or soft-deleted.

## Business rules

- **Append-only and immutable.** Rows are written, never updated or deleted.

## Conventions

- **ID:** `autoincrement()` — log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (no `updatedAt` / `deletedAt`, [[0006-soft-delete-and-auditing]]).

Related: [[asset]] · [[asset-assignment]] · [[user]] · [[service-account]] ·
[[0033-asset-history-event-model]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0022-draft-visibility-auth-shim]] · [[0048-service-accounts]] · [[INVARIANTS]]
