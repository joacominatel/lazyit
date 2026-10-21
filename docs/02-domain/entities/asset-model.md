---
title: AssetModel
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-21
---

# AssetModel

> 🟢 implemented · Area: Assets (core) · Implementation order: 2

## Purpose

The generic make/model definition an [[asset]] is an instance of — e.g. "Dell Latitude
7440", "Cisco Catalyst 9300". Holds attributes common to all units of that model
(manufacturer, model name, generic specs), so individual assets don't repeat them.

## Relationships

- **optionally classified by** one [[asset-category]] (`categoryId`, **nullable** FK,
  `onDelete: SetNull`).
- **has** N [[asset]] instances.

## Business rules

- A model captures *type-level* facts; per-unit facts (serial, the flexible `specs`, owner)
  belong to the [[asset]].
- On [[asset]] creation, a live model's `specs` are materialized into `Asset.specs` as an editable
  snapshot. Explicit asset specs win over model defaults, and later model edits do not sync into
  existing assets.
- **Delete with one resolution (SEC-041).** A delete affects the model's **live assets** and the
  **open purchase lines** mapped to it — live lines of a live `DRAFT` or `ORDERED` purchase (a status a
  newer build adds counts as closed) that still expect units. While any of them exists, the delete
  needs **one** resolution for all of them, never one per row:
  - `detach` — the assets keep no model, the lines lose their model mapping;
  - `move` — all of them go to one target model: live and not the model itself (`400` otherwise), in
    **any** category. An asset's category follows its model, so a move into another category moves the
    assets there too.

  Without a resolution the delete is a `409` `DELETE_RESOLUTION_REQUIRED` with
  `{ assets, purchaseOrderLines }`. The resolution and the soft delete run in **one transaction**
  (30 s timeout). Locks, in order: both models and the assets `FOR UPDATE`, the purchases of the mapped
  lines `FOR SHARE` (purchase before line, like every purchase write, and settled against a status change
  or archive in flight), then the open lines `FOR UPDATE`. Each moved asset gets a
  `MODEL_CHANGED` [[asset-history]] row (`{ from, to }`, `to: null` on detach), all written in one
  insert, and each line a `LINE_UPDATED` [[purchase-order-event]] for `assetModelId`. History keeps its
  reference: archived assets, received lines and the lines of cancelled purchases still point at the
  archived model. Restoring the model re-links nothing. The FK's `onDelete: SetNull` only matters for a
  hard delete, which the API never issues.
- **Restore needs a live category.** Restoring a model whose category is still archived is a `409`:
  restore the category first. Restores do not cascade, as for a [[location]] under an archived parent.
- **Models archived before the delete resolution** still have their assets and lines pointing at them.
  Restoring one brings those links back; deleting it again goes through the resolution.
- **A live category on write (SEC-041).** A create with a `categoryId`, or an update that changes it, is
  a `400` when the category is missing or archived. An update that leaves a legacy archived category in
  place is accepted, so such a model stays editable. The named category is locked `FOR SHARE` in the
  write's transaction, before the model row, so a concurrent category delete cannot strand the model
  there (#1604).
- `sku` is unique among **live** rows when present (a live duplicate returns `409`); a soft-deleted
  sku is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `AssetModel` → table `asset_models`. Validation schemas (`AssetModelSchema`,
`CreateAssetModelSchema`, `UpdateAssetModelSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/asset-model.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | required (e.g. "Dell Latitude 5520"). |
| `manufacturer` | `string` | required (e.g. "Dell"). |
| `sku` | `string?` | Optional. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted sku is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). `null` on `PATCH` clears it (#1441). |
| `description` | `string?` | optional; `null` on `PATCH` clears it (#1441). |
| `specs` | `jsonb?` | model-level default specs (e.g. "ships with 16GB"). **Distinct from `Asset.specs`** (type-level vs per-unit). Any JSON object within the `ASSET_SPECS_MAX_*` write bound shared with `Asset.specs` (#1329); reads stay unbounded so older rows still load ([[0007-flexible-asset-specs-jsonb]]). |
| `categoryId` | `cuid?` | optional FK → [[asset-category]], `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |
| `usageCount` | `int?` | **read-only, computed — not a column** (#1540). Only on the `GET /asset-models` page items: the number of **live** assets of this model; `0` when unused. Computed on both slices — an archived model (`?deleted=only`) still shows the live assets that point at it. Absent from `GET /:id` and the write responses. |

## UI behavior

Settings → Taxonomies → Asset models lets operators edit `specs` as simple key/value defaults.
Those defaults are copied into the asset form when a model is selected, where the operator can adjust
the values before saving the concrete unit.

## Endpoints

`apps/api/src/asset-models/` (`AssetModelsModule`): `GET /asset-models` — **paginated** `Page<AssetModel>`
envelope with a server-side case-insensitive **`q`** over name/manufacturer/sku, an optional
`?categoryId=` filter, an allowlisted `sort` (`name`/`manufacturer`/`sku`/`createdAt`/`updatedAt`,
default `createdAt desc`) and the `deleted` slice, each item carrying the computed `usageCount` — migrated off the raw array so the searchable model
picker can search/page authoritatively (issue #199, [[0030-list-pagination-contract]] §8). Then
`GET /asset-models/:id`, `POST`, `PATCH /:id`, `GET /:id/delete-impact` (`assetModel:delete` — the
counts plus the first 50 live assets and open lines, each list only when the caller may read that kind,
`AssetModelDeleteImpactSchema`; a line carries its `purchaseOrderId`, the purchase `reference` and its
`description`), `DELETE /:id` (soft delete; `?strategy=detach` or `?strategy=move&targetId=`, see
above), `POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]).
A missing or archived `categoryId` on write returns `400`. `PATCH /:id` with `categoryId: null`
**clears** the category (the model becomes uncategorized; its assets keep pointing at it) — the same
state a category delete with `detach` produces (CEO 2026-09-25, #1315).
`sku: null` and `description: null` on `PATCH /:id` **clear** those fields (both columns are
nullable; a cleared SKU is simply absent, and the partial unique index treats NULLs as distinct, so any
number of models can have none). An empty string is still refused — `null` is the one way to clear
(#1441).

Related: [[asset]] · [[asset-category]] · [[conventions]] · [[0018-api-documentation-swagger]]
