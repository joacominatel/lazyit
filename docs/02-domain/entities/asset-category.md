---
title: AssetCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-21
---

# AssetCategory

> 🟢 implemented · Area: Assets (core) · Implementation order: 2

## Purpose

Classification for [[asset-model]]s — e.g. Laptop, Desktop, Server, Switch, Firewall.
Drives grouping and filtering, and — via an optional **advisory specs dictionary**
([[0078-asset-category-specs-dictionary]]) — which `specs` shape an [[asset]] of that type is
*expected* (never *forced*) to have.

## Relationships

- **classifies** N [[asset-model]]s — optional FK `AssetModel.categoryId` (`onDelete: SetNull`).

## Business rules

- **User-managed:** categories are created, edited and soft-deleted from the app. An initial
  set is **seeded** (`prisma/seed.ts`: Server, Switch, Router, Firewall, Laptop, Desktop,
  Mobile, Printer, Storage, UPS, Peripheral, Other) but the seeded rows are **not special** —
  they can be edited or removed like any other.
- `name` is unique among **live** rows (a live duplicate create returns `409`); a soft-deleted name
  is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]).
- **Delete with one resolution (SEC-041).** While live [[asset-model]]s are filed under the category,
  the delete needs **one** resolution for all of them: `detach` (they keep no category) or `move` (they
  all go to another live asset category, not the one being deleted — `400` otherwise). Their live
  assets follow their model, so the preview and the `409` count them too. Without a resolution the
  delete is a `409` `DELETE_RESOLUTION_REQUIRED` with `{ assetModels, assets }`. The re-point and the
  soft delete share one transaction under a `FOR UPDATE` lock on both categories, with the live models
  locked `FOR NO KEY UPDATE` in id order. A model write naming the category holds it `FOR SHARE`, so
  the two serialize (#1604); models have no history
  table, so nothing else is written. Archived models keep their reference, and restoring the category
  re-links nothing. The `SetNull` FK only matters for a hard delete, which the API never issues.
- **Categories archived before the delete resolution** still have their models pointing at them; a
  model write that keeps that category is accepted, one that names it newly is a `400`
  ([[asset-model]]).
- **Specs dictionary (advisory — [[0078-asset-category-specs-dictionary]], #851).** A category MAY
  declare a `specsSchema`: a small **declarative** field list
  (`{ key, label, type: 'string'|'number'|'boolean'|'enum', required?, enumValues? }[]`) that governs
  the `specs` of assets whose model points at this category (resolved `asset → model → category`). It
  is **advisory-first**: the shared pure helper `validateSpecsAgainstDictionary` turns it into UI hints
  + soft warnings (missing-required / wrong-type / not-in-enum / unknown-key) — **never** a `400`, and
  existing rows are never migrated. `null`/absent = no governance (any jsonb accepted). Authored in
  **Settings → Taxonomies → Asset categories**.

> [!note] Reconciliation (2026-05-25)
> An earlier draft of this note called categories "a small, curated set … not free-form tags."
> That is **superseded**: categories are **user-managed** (full CRUD + soft delete). The
> opinionated default is delivered as a **seed**, not a hardcoded list.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Prisma model `AssetCategory` → table `asset_categories`. Validation schemas
(`AssetCategorySchema`, `CreateAssetCategorySchema`, `UpdateAssetCategorySchema`) live in
`@lazyit/shared` (`packages/shared/src/schemas/asset-category.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | Required. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted name is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). |
| `description` | `string?` | optional. |
| `icon` | `string?` | optional, **free string** — a heroicon name for the web UI (e.g. `"ServerStackIcon"`), not validated. |
| `specsSchema` | `json?` | optional **advisory** specs dictionary — a declarative `{ key, label, type, required?, enumValues? }[]` (validated by `AssetSpecsDictionarySchema`). `null` = no governance. Drives hints/warnings for `Asset.specs`, never hard validation ([[0078-asset-category-specs-dictionary]]). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete; reads filter `deletedAt: null`. |
| `usageCount` | `int?` | **read-only, computed — not a column** (#1540). Only on `GET /asset-categories`: the number of **live** assets whose **live** model is filed under this category (`asset → model → category`; an asset of a soft-deleted model is not counted here — its archived model's row carries it). `0` when unused. Absent from `GET /:id` and the write responses. |

## Endpoints

`apps/api/src/asset-categories/` (`AssetCategoriesModule`): `GET /asset-categories` (excludes
soft-deleted; each row carries the computed `usageCount`, so Settings → Taxonomies shows what is in use
before an archive — one read, batched relation counts, never per row), `GET /asset-categories/:id`, `POST`, `PATCH /:id`,
`GET /:id/delete-impact` (`category:delete` — the counts plus the first 50 live models and live assets,
each list only when the caller may read that kind, `AssetCategoryDeleteImpactSchema`), `DELETE /:id`
(soft delete; `?strategy=detach` or `?strategy=move&targetId=`, see above), `POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]).
Documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[asset-model]] · [[asset]] · [[conventions]] · [[0018-api-documentation-swagger]]
