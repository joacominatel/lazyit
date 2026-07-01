---
title: AssetCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-06-30
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

## Endpoints

`apps/api/src/asset-categories/` (`AssetCategoriesModule`): `GET /asset-categories` (excludes
soft-deleted), `GET /asset-categories/:id`, `POST`, `PATCH /:id`, `DELETE /:id` (soft delete),
`POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]).
Documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[asset-model]] · [[asset]] · [[conventions]] · [[0018-api-documentation-swagger]]
