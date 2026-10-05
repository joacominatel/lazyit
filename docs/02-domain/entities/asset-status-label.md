---
title: AssetStatusLabel
tags: [domain, entity]
status: accepted
created: 2026-10-05
updated: 2026-10-05
---

# AssetStatusLabel (custom asset status)

> 🟢 implemented · Area: Assets (core) · [[0101-custom-asset-statuses]] · #1524

## Purpose

A **custom asset status**: a name the team defines — "In repair at vendor", "On the bench", "Loaner pool" —
mapped to exactly **one** built-in `AssetStatus`, its `kind`. It gives a team its own vocabulary without
changing what any rule reads: the dashboard, the `?status=` filter, the `IN_STORAGE` default, imports, the
reporting agent and the AI all keep working on the asset's built-in [[asset]]`.status`.

**Optional.** No team has to define one, and an asset can keep a bare built-in status forever. Assets only:
location types stay a fixed enum ([[0017-location-type-enum]]).

## Relationships

- **names the status of** N [[asset]]s — `Asset.statusLabelId`, nullable FK, `onDelete: SetNull` (never fires:
  a label is only soft-deleted, after its assets are moved off it).

## Business rules

- **The invariant:** `asset.statusLabelId != null ⇒ asset.status == label.kind`. Enforced by `AssetsService`
  on every asset write path — create, `PATCH`, bulk status (`POST /assets/batch/status`), bulk receive
  (`POST /assets/batch/receive`) and receive from a purchase line:
  - a label sets the asset's `status` to its `kind`;
  - a body with both a `status` and a label of another kind is a `400`;
  - a missing or archived label is a `400`;
  - a `PATCH` with `status` alone keeps the label when the status does not change (the label maps to it) and
    clears it when it does;
  - `statusLabelId: null` clears the label and keeps the built-in status;
  - on bulk status, `status` + `statusLabelId: null` asks for the **bare** built-in status: an asset already in
    that status but carrying a label is changed (label cleared, `STATUS_CHANGED` recorded), not skipped. A
    `status` alone keeps the old behavior (an asset already in that status is skipped, label and all).
- `name` is unique among **live** labels — a raw-SQL partial unique index `asset_status_labels_name_active_key`
  `WHERE "deletedAt" IS NULL`, case-sensitive like the category names; a duplicate is a `409`
  ([[0041-soft-delete-reuse-and-restore]]).
- **`kind` cannot change while any asset — live or archived — carries the label (`409`).** Its assets would
  silently change built-in status. Move them first, or create a new label.
- **Deleting a label in use needs a destination**: another live label (`reassignLabelId`) or a bare built-in
  status (`reassignStatus`) — exactly one, else `400`. In **one transaction**: every carrying asset (live and
  archived) moves there (`statusLabelId` and `status`), each with a `STATUS_CHANGED` [[asset-history]] row,
  then the label is soft-deleted. So no asset ever points at an archived label (unlike the bare soft delete
  of categories, models and locations — SEC-041). An unused label needs no destination.
- **Restore** brings the label back with no assets; a live label holding its name meanwhile is a `409`.
- **Concurrency.** The invariant spans two tables, so writes serialize on the label row: an asset write that
  sets a label locks it `FOR SHARE`; a kind change and a delete lock it `FOR UPDATE`.
- **History.** `STATUS_CHANGED` also fires when only the label changes (same built-in status). Payload
  `{ from, to }` (built-in) plus `fromLabel` / `toLabel` (`{ id, name }` or `null`) whenever either side has a
  label ([[0033-asset-history-event-model]] amendment 2026-10-05).
- **Not carried (deliberately):** the search index document and the inventory CSV keep the built-in status
  only; the import maps the built-in status.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`; registered in `SOFT_DELETABLE_MODELS`
  ([[0032-soft-delete-middleware]]).

## Fields

Prisma model `AssetStatusLabel` → table `asset_status_labels`. Schemas in `@lazyit/shared`
(`packages/shared/src/schemas/asset-status-label.ts`): `AssetStatusLabelSchema`, `CreateAssetStatusLabelSchema`,
`UpdateAssetStatusLabelSchema`, `DeleteAssetStatusLabelQuerySchema`, `DeleteAssetStatusLabelResultSchema`,
`AssetStatusLabelListQuerySchema`; the compact `AssetStatusLabelRefSchema` (`{ id, name, kind, color }`) an
asset read inlines lives in `asset.ts`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `name` | `string` | 1–100, trimmed; unique among live labels (partial index). |
| `kind` | `AssetStatus` | The built-in status it maps to. Frozen while any asset carries the label. |
| `color` | `string?` | `#RRGGBB` (validated on write only); `null` = the kind's own colour. |
| `description` | `string?` | ≤ 1000. |
| `order` | `int?` | 0–100 000, sort position within its kind; `null` sorts last. |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | soft delete. |
| `assetCount` | `int` | **read-only, computed** on the list and detail reads: the number of **live** assets carrying it. |

## Endpoints

`apps/api/src/asset-status-labels/` (`AssetStatusLabelsModule`). **No permission of its own** — the category
set ([[0046-roles-permissions-v2]]):

- `GET /asset-status-labels` (`category:read`) — live labels with `assetCount`, ordered by kind (the
  `AssetStatus` declaration order), then `order` (unset last), then name. `?deleted=only` lists the archived
  ones (ADMIN only, `403` otherwise — the ADR-0041 archived-list rule).
- `GET /asset-status-labels/:id` (`category:read`) — one live label with `assetCount`; `404` otherwise.
- `POST /asset-status-labels` (`category:write`) — `{ name, kind, color?, description?, order? }`.
- `PATCH /asset-status-labels/:id` (`category:write`) — any subset; `color` / `description` / `order` take
  `null`. A `kind` change while in use → `409`.
- `DELETE /asset-status-labels/:id?reassignLabelId=|reassignStatus=` (`category:delete`) — returns the
  archived label plus `movedAssetCount`.
- `POST /asset-status-labels/:id/restore` (`category:delete`).

On the asset side: `GET /assets?statusLabelId=` (and the CSV export) filters by one label; `?status=` keeps
filtering by the built-in status, so it includes every label of that kind. The list, the detail and
`/assets/mine` inline `statusLabel` (the ref); write responses carry `statusLabelId` only.

## AI assistant

`reference_lookup` kind `assetStatusLabel`; `asset_status_label_create` / `_update` / `_archive` (with
`moveTo` / `moveToStatus`) / `_restore`; a `customStatus` reference on `asset_create`, `asset_create_batch`,
`asset_update`, `asset_update_batch`; `asset_get` / `asset_search` show `customStatus` and the search filters
by `statusLabelId`. See [[ai-assistant/tools-and-execution|tools]].

Related: [[asset]] · [[asset-history]] · [[asset-category]] · [[0101-custom-asset-statuses]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0033-asset-history-event-model]]
