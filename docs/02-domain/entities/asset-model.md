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
| `sku` | `string?` | Optional. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted sku is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). |
| `description` | `string?` | optional. |
| `specs` | `jsonb?` | model-level default specs (e.g. "ships with 16GB"). **Distinct from `Asset.specs`** (type-level vs per-unit). Any JSON object for now ([[0007-flexible-asset-specs-jsonb]]). |
| `categoryId` | `cuid?` | optional FK → [[asset-category]], `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

## Endpoints

`apps/api/src/asset-models/` (`AssetModelsModule`): `GET /asset-models` (excludes soft-deleted,
optional `?categoryId=` filter), `GET /asset-models/:id`, `POST`, `PATCH /:id`, `DELETE /:id`
(soft delete), `POST /:id/restore` (ADMIN-only — clears `deletedAt`,
[[0041-soft-delete-reuse-and-restore]]). An invalid `categoryId` on write returns `400`
(FK → [[0018-api-documentation-swagger]]).

Related: [[asset]] · [[asset-category]] · [[conventions]] · [[0018-api-documentation-swagger]]
