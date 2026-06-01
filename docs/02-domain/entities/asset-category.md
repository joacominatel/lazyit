---
title: AssetCategory
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# AssetCategory

> 🟢 implemented · Area: Assets (core) · Implementation order: 2

## Purpose

Classification for [[asset-model]]s — e.g. Laptop, Desktop, Server, Switch, Firewall.
Drives grouping and filtering and (potentially) which `specs` shape an [[asset]] of that type
is expected to have.

## Relationships

- **classifies** N [[asset-model]]s — optional FK `AssetModel.categoryId` (`onDelete: SetNull`).

## Business rules

- **User-managed:** categories are created, edited and soft-deleted from the app. An initial
  set is **seeded** (`prisma/seed.ts`: Server, Switch, Router, Firewall, Laptop, Desktop,
  Mobile, Printer, Storage, UPS, Peripheral, Other) but the seeded rows are **not special** —
  they can be edited or removed like any other.
- `name` is unique among **live** rows (a live duplicate create returns `409`); a soft-deleted name
  is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]).
- May later define a recommended `specs` schema/template for its models — deferred (see the
  Known-debt note on [[asset]] and [[0007-flexible-asset-specs-jsonb]]).

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
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete; reads filter `deletedAt: null`. |

## Endpoints

`apps/api/src/asset-categories/` (`AssetCategoriesModule`): `GET /asset-categories` (excludes
soft-deleted), `GET /asset-categories/:id`, `POST`, `PATCH /:id`, `DELETE /:id` (soft delete),
`POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]).
Documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[asset-model]] · [[asset]] · [[conventions]] · [[0018-api-documentation-swagger]]
