---
title: Asset
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Asset

> 🟢 implemented · Area: Assets (core) · Implementation order: 2

## Purpose

The first-class citizen of lazyit ([[asset-centric]]): a single tracked thing the IT team
owns and is accountable for — a laptop, server, switch, license, etc. Each asset is a
concrete instance of a generic [[asset-model]].

## Relationships

- **is an instance of** an optional [[asset-model]] (`modelId`, nullable FK, `onDelete: SetNull`).
- **lives at** an optional [[location]] (`locationId`, nullable FK, `onDelete: SetNull`).
- **is owned via** N [[asset-assignment]] records — ⚪ **not yet implemented** (deferred).
- **has** N [[asset-history]] entries — ⚪ **not yet implemented** (deferred).
- **is referenced by** N [[ticket]]s — ⚪ not yet implemented.

## Business rules

- Asset-specific attributes that vary by type live in a flexible `specs` jsonb field
  ([[0007-flexible-asset-specs-jsonb]]).
- `status` is a **required** enum (`AssetStatus`), **no default** — every asset is classified
  (consistent with [[location]]`.type`).
- `serial` and `assetTag` are each unique when present (a duplicate returns `409`).
- FKs (`modelId`, `locationId`) are `onDelete: SetNull`: deleting a model/location **detaches**
  assets, never deletes them (auditability > strict referential integrity). Combined with soft
  delete everywhere, references are preserved in practice.
- Ownership is **never a column** on the asset — it will be the [[asset-assignment]] join
  (deferred), so ownership history is automatic.

> [!warning] Known debt — dynamic `specs` validation
> `Asset.specs` (and [[asset-model]]`.specs`) currently accept **any JSON object**
> (`z.record(z.string(), z.unknown())`). The intent ([[0007-flexible-asset-specs-jsonb]]) is to
> validate `specs` against a per-[[asset-category]] schema (e.g. a future
> `AssetCategory.specsSchema`), which does not exist yet. Tracked as a `TODO(specs)` in the
> shared zod schemas.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `Asset` → table `assets`. Validation schemas (`AssetSchema`, `CreateAssetSchema`,
`UpdateAssetSchema`, `AssetStatusSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/asset.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | required (e.g. "SW-CORE-01"); naming convention is the user's, not enforced. |
| `serial` | `string?` | `@unique`, optional — unique when present. |
| `assetTag` | `string?` | `@unique`, optional — internal company label, unique when present. |
| `status` | `AssetStatus` | required enum, **no default**. |
| `specs` | `jsonb?` | per-unit type-specific attributes; any JSON object for now (see debt note). |
| `notes` | `string?` | optional. |
| `purchaseDate` | `datetime?` | optional; ISO-8601 string over the wire ([[0018-api-documentation-swagger]]). |
| `warrantyEnd` | `datetime?` | optional; ISO-8601 string over the wire. |
| `modelId` | `cuid?` | optional FK → [[asset-model]], `onDelete: SetNull`. |
| `locationId` | `cuid?` | optional FK → [[location]], `onDelete: SetNull`. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete. |

`AssetStatus` values: `OPERATIONAL`, `IN_MAINTENANCE`, `IN_STORAGE`, `RETIRED`, `LOST`, `UNKNOWN`.

## Endpoints

`apps/api/src/assets/` (`AssetsModule`): `GET /assets` (excludes soft-deleted) with optional
filters **`?categoryId=&locationId=&status=`** — `categoryId` filters by the asset's model's
category, `status` is validated against the enum (invalid → `400`). Plus `GET /assets/:id`,
`POST`, `PATCH /:id`, `DELETE /:id` (soft delete). An invalid `modelId`/`locationId` on write
returns `400` (FK → [[0018-api-documentation-swagger]]).

## Not yet implemented (deferred)

- [[asset-assignment]] (ownership join, concurrent many-to-many with [[user]]) and
  [[asset-history]] (append-only audit log) — the next task.
- Dynamic per-category `specs` validation (see debt note above).
- Any endpoint mixing [[asset]] with [[user]].

Related: [[asset-model]] · [[location]] · [[asset-category]] · [[asset-assignment]] ·
[[asset-history]] · [[asset-centric]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0018-api-documentation-swagger]]
