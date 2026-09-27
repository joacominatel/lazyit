---
title: AssetModel
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
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
- **Soft delete only** — we never hard-delete, so existing [[asset]]s keep referencing a
  soft-deleted model. The FK's `onDelete: SetNull` is only a safety net for a (non-occurring)
  hard delete: it would detach assets rather than delete them (audit > strict integrity).
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
| `specs` | `jsonb?` | model-level default specs (e.g. "ships with 16GB"). **Distinct from `Asset.specs`** (type-level vs per-unit). Any JSON object for now ([[0007-flexible-asset-specs-jsonb]]). |
| `categoryId` | `cuid?` | optional FK → [[asset-category]], `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

## UI behavior

Settings → Taxonomies → Asset models lets operators edit `specs` as simple key/value defaults.
Those defaults are copied into the asset form when a model is selected, where the operator can adjust
the values before saving the concrete unit.

## Endpoints

`apps/api/src/asset-models/` (`AssetModelsModule`): `GET /asset-models` — **paginated** `Page<AssetModel>`
envelope with a server-side case-insensitive **`q`** over name/manufacturer/sku, an optional
`?categoryId=` filter, an allowlisted `sort` (`name`/`manufacturer`/`sku`/`createdAt`/`updatedAt`,
default `createdAt desc`) and the `deleted` slice — migrated off the raw array so the searchable model
picker can search/page authoritatively (issue #199, [[0030-list-pagination-contract]] §8). Then
`GET /asset-models/:id`, `POST`, `PATCH /:id`, `DELETE /:id` (soft delete), `POST /:id/restore`
(ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]). An invalid `categoryId` on
write returns `400` (FK → [[0018-api-documentation-swagger]]). `PATCH /:id` with `categoryId: null`
**clears** the category (the model becomes uncategorized; its assets keep pointing at it) — the same
state `onDelete: SetNull` produces when a category is deleted (CEO 2026-09-25, #1315).
`sku: null` and `description: null` on `PATCH /:id` **clear** those fields (both columns are
nullable; a cleared SKU is simply absent, and the partial unique index treats NULLs as distinct, so any
number of models can have none). An empty string is still refused — `null` is the one way to clear
(#1441).

Related: [[asset]] · [[asset-category]] · [[conventions]] · [[0018-api-documentation-swagger]]
