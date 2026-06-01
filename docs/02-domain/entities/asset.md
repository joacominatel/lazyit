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
- **is owned via** N [[asset-assignment]] records — 🟢 ownership over time (concurrent, multi-owner).
- **has** N [[asset-history]] entries — ⚪ **not yet implemented** (deferred).
- **is referenced by** N [[ticket]]s — ⚪ not yet implemented.

## Business rules

- Asset-specific attributes that vary by type live in a flexible `specs` jsonb field
  ([[0007-flexible-asset-specs-jsonb]]).
- `status` is a **required** enum (`AssetStatus`), **no default** — every asset is classified
  (consistent with [[location]]`.type`).
- `serial` and `assetTag` are each unique **among live rows** when present (a live duplicate returns
  `409`); a soft-deleted value is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]).
- FKs (`modelId`, `locationId`) are `onDelete: SetNull`: deleting a model/location **detaches**
  assets, never deletes them (auditability > strict referential integrity). Combined with soft
  delete everywhere, references are preserved in practice.
- Ownership is **never a column** on the asset — it is the [[asset-assignment]] join, so
  ownership history is automatic ([[0019-asset-assignment-integrity]]).

> [!warning] Known debt — dynamic `specs` validation
> `Asset.specs` (and [[asset-model]]`.specs`) currently accept **any JSON object**
> (`z.record(z.string(), z.unknown())`). The intent ([[0007-flexible-asset-specs-jsonb]]) is to
> validate `specs` against a per-[[asset-category]] schema (e.g. a future
> `AssetCategory.specsSchema`), which does not exist yet. Tracked as a `TODO(specs)` in the
> shared zod schemas. The web's custom-fields editor only authors **scalar string values**
> (one `{ name, value }` row each), but pre-existing non-scalar entries (arrays/objects) are
> **preserved untouched** on edit — they round-trip and render as compact JSON, they just
> aren't editable inline.

> [!note] Expanded read shape (reads only)
> `GET /assets` and `GET /assets/:id` return an **`AssetWithRelations`**: the asset plus its `model`
> (with the model's `category` nested), its `location`, and `activeAssignments` — the **active**
> owners (`releasedAt = null`), each with its `user` inlined. This lets the web render the
> table/detail in one call instead of fanning out to several list endpoints (resolved by a single
> nested Prisma `include` — a constant number of queries, no N+1). `model`/`location` are `null`
> when unset; `activeAssignments` is `[]` when there are no active owners. **Writes are unchanged** —
> `POST`/`PATCH` still take and return the lean `Asset`. Schemas: `AssetWithRelationsSchema`,
> `AssetModelWithCategorySchema`, `AssetAssignmentWithUserSchema` in `@lazyit/shared`
> (`packages/shared/src/schemas/asset-expanded.ts`).
>
> **Soft-deleted users are included** in `activeAssignments` (returned with their `deletedAt` set):
> an owner who left the company still appears as an active owner until the assignment is explicitly
> released — ownership history is preserved (consistent with [[asset-assignment]]'s `onDelete:
> Restrict` and the auditability principle). The web decides how to display them.

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
| `serial` | `string?` | Optional. Unique among **live** rows only — a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL; no `@unique`), so a soft-deleted serial is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]). |
| `assetTag` | `string?` | Optional internal company label. Same live-only PARTIAL unique index as `serial` ([[0041-soft-delete-reuse-and-restore]]). |
| `status` | `AssetStatus` | required enum, **no default**. |
| `specs` | `jsonb?` | per-unit type-specific attributes; any JSON object for now (see debt note). The web edits this via a **custom-fields editor** (a list of `{ name, value }` string rows) and renders it on the detail page as a label-cased key/value list, not raw JSON. |
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

`apps/api/src/assets/` (`AssetsModule`):

- `GET /assets` — **expanded** list (`AssetWithRelations[]`, excludes soft-deleted, newest first)
  with optional filters **`?categoryId=&locationId=&status=&q=`**: `categoryId` matches the asset's
  **model's** category, `status` is validated against the enum (invalid → `400`), and `q` is a
  case-insensitive substring over `name` / `serial` / `assetTag`.
- `GET /assets/:id` — one **expanded** asset (`404` if missing/soft-deleted).
- `GET /assets/:id/assignments?activeOnly=` — the asset's ownership records, each with its `user`
  inlined (`AssetAssignmentWithUser[]`); `activeOnly` defaults to true, pass `false` for full
  history (active + released). See [[asset-assignment]].
- `GET /assets/:id/history?limit=&before=` — the asset's append-only event log
  (`AssetHistory[]`, newest first; cursor on the autoincrement id, `limit` default 50 / max 100).
  `404` if missing/soft-deleted. See [[asset-history]].
- `POST` · `PATCH /:id` · `DELETE /:id` (soft delete) — lean `Asset` shape; an invalid
  `modelId`/`locationId` on write returns `400` (FK → [[0018-api-documentation-swagger]]). Each write
  takes an **optional `X-User-Id`** header (the actor) and emits an [[asset-history]] event
  (`CREATED` / `STATUS_CHANGED` / … / `DELETED`) transactionally ([[0033-asset-history-event-model]]).
- `POST /assets/:id/restore` — **ADMIN-only** ([[0040-rbac-roles]]). Clears `deletedAt` and emits a
  `RESTORED` [[asset-history]] event transactionally; returns the expanded asset. Idempotent on a live
  asset; can `409` if a live asset took the freed serial/assetTag meanwhile
  ([[0041-soft-delete-reuse-and-restore]]).

## Not yet implemented (deferred)

- Dynamic per-category `specs` validation (see debt note above).
- **Advanced asset search** — `?q=` today is a simple case-insensitive substring (ILIKE) over
  `name`/`serial`/`assetTag`, **unindexed** (fine at small-team scale). Full-text / indexed search
  is deferred to its own task.

Related: [[asset-model]] · [[location]] · [[asset-category]] · [[asset-assignment]] ·
[[asset-history]] · [[asset-centric]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0018-api-documentation-swagger]] · [[0033-asset-history-event-model]]
