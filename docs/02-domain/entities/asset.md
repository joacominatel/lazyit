---
title: Asset
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-06-16
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
- **has** N [[asset-history]] entries — 🟢 implemented; see `GET /assets/:id/history`.

## Business rules

- Asset-specific attributes that vary by type live in a flexible `specs` jsonb field
  ([[0007-flexible-asset-specs-jsonb]]).
- When creating an asset from a live [[asset-model]], the model's default `specs` are copied into
  this field as a snapshot. Asset-provided specs override matching model keys, so an individual unit
  can diverge immediately.
- `status` is a **required** enum (`AssetStatus`), **no default** — every asset is classified
  (consistent with [[location]]`.type`).
- `serial` and `assetTag` are each unique **among live rows** when present (a live duplicate returns
  `409`); a soft-deleted value is freed for reuse / restore ([[0041-soft-delete-reuse-and-restore]]).
- **`id` vs `assetTag` — two different identities.** `id` is the internal `cuid()` primary key
  (system-generated, opaque, used in URLs/FKs); `assetTag` is the **human-facing** label a team
  writes on the physical sticker (`LAZY-00042`). They are independent: `assetTag` is optional, mutable,
  and live-only-unique; `id` is permanent. Never use `assetTag` as a foreign key.
- **Configurable asset-tag scheme (opt-in, OFF by default — [[0063-configurable-asset-tag-scheme]]).**
  An instance may configure an org-wide scheme so a new asset gets its `assetTag` **auto-assigned**:
  a `prefix` + a mandatory running number (`prefix + zeroPad(num, width) + suffix`, e.g. `LAZY-00042`).
  The number comes from a single monotonic counter in the `AssetTagScheme` config row, incremented
  atomically inside the asset-create transaction, so concurrent creates never collide. **OFF by
  default:** with no scheme (or a disabled one) asset creation is unchanged — `assetTag` is whatever
  the operator typed (or null). An **explicit `assetTag` always wins** (the scheme only fills the gap).
  the sequence is **monotonic, not gapless** (rolled-back / retried / deleted numbers are not
  back-filled).
- **Skip-existing invariant + estate awareness ([[0068-asset-tag-existing-estate-awareness]]).** An
  auto-allocated tag is **never** a tag already on a live asset: on allocation the counter advances to
  the next number whose rendered tag is free, jumping past a contiguous occupied block in one step (so
  e.g. existing `IT-1000, IT-1002, IT-1005` → allocations `IT-1001, IT-1003, IT-1004, IT-1006…`). The
  live-only partial-unique index stays the concurrency backstop. At config time a **seed suggestion**
  (`GET /config/asset-tag-scheme/seed-suggestion`) parses the existing matching tags and proposes
  `startNumber = max + 1` so the counter seeds above the occupied range.
- **Backfill ([[0068-asset-tag-existing-estate-awareness]] §3/§4).** Enabling the scheme does **not**
  retroactively tag existing assets — that is a deliberate, audited bulk action (`settings:manage`)
  with a read-only **preview** (`GET …/backfill/preview`, writes nothing — `proposedTag` is indicative)
  and an **apply** (`POST …/backfill/apply`, forward-only, no undo, one `AssetHistory` row per retag).
  Two modes: `untagged-only` (default, safe — only assets with no tag) and `normalize-non-conforming`
  (opt-in, behind a warning — also retags tags that don't match the scheme; **conforming manual tags
  are never touched**). Optional `modelId` filter + per-row deselect.
- FKs (`modelId`, `locationId`) are `onDelete: SetNull`: deleting a model/location **detaches**
  assets, never deletes them (auditability > strict referential integrity). Combined with soft
  delete everywhere, references are preserved in practice.
- Ownership is **never a column** on the asset — it is the [[asset-assignment]] join, so
  ownership history is automatic ([[0019-asset-assignment-integrity]]).

> [!note] `specs` governance — advisory per-category dictionary (2026-06-30, #851)
> `Asset.specs` (and [[asset-model]]`.specs`) still accept **any JSON object**
> (`z.record(z.string(), z.unknown())`) — the wire schema deliberately never narrows. Governance is
> now **advisory**: an [[asset-category]] may declare a `specsSchema` dictionary
> ([[0078-asset-category-specs-dictionary]]) that drives **UI hints + soft warnings** (missing-required
> / wrong-type / not-in-enum / unknown-key) for the `specs` of assets whose model points at it —
> resolved `asset → model → category`, computed by the pure `validateSpecsAgainstDictionary` helper.
> It is **never hard validation** (no `400`) and existing rows are never migrated, so the old
> `TODO(specs)` is closed without breaking anything. The web's custom-fields editor authors **scalar
> string values** (one `{ name, value }` row each); pre-existing non-scalar entries (arrays/objects) are
> **preserved untouched** on edit — they round-trip and render as compact JSON, just not editable inline.

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
| `assetTag` | `string?` | Optional human-facing company label (the physical sticker; distinct from the internal `id`). Same live-only PARTIAL unique index as `serial` ([[0041-soft-delete-reuse-and-restore]]). **Auto-assigned** on create when the opt-in `AssetTagScheme` is enabled and no explicit value is supplied ([[0063-configurable-asset-tag-scheme]]); OFF by default. |
| `status` | `AssetStatus` | required enum, **no default**. |
| `specs` | `jsonb?` | per-unit type-specific attributes; any JSON object for now (see debt note). The web edits this via a **custom-fields editor** (a list of `{ name, value }` string rows). On create, selecting a model with default specs pre-fills those rows; the operator can change them before saving. Detail renders specs as a label-cased key/value list, not raw JSON. |
| `notes` | `string?` | optional. |
| `company` | `string?` | optional **grouping** label (Snipe-IT-style) to group/filter/report assets — **NOT** per-record scoping ([[0076-asset-company-grouping-field]]; Modo B rejected, #841). Anyone with `asset:read` sees ALL assets regardless of company. Free-text + autocomplete over already-used values (`GET /assets/companies`); no Company entity. Mirrors `notes` (optional trimmed string, max 200). |
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
  with optional filters **`?categoryId=&locationId=&status=&company=&q=&assignedToUserId=`**: `categoryId`
  matches the asset's **model's** category, `status` is validated against the enum (invalid → `400`),
  `company` is an exact-match grouping filter over the free-text `company` column
  ([[0076-asset-company-grouping-field]]; a grouping facet, not an access boundary),
  `q` is a case-insensitive substring over `name` / `serial` / `assetTag`, and `assignedToUserId`
  (a [[user]] `uuid`; invalid → `400`) restricts to assets with a **live** assignment
  (`releasedAt = null`) to that user — the owner filter, over the timestamped-join relation.
- `GET /assets/companies` — the distinct, non-empty `company` values across live assets (sorted;
  `asset:read`) — powers the form autocomplete datalist and the list filter ([[0076-asset-company-grouping-field]]).
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

- **Hard/blocking** per-category `specs` validation. The **advisory** dictionary is done (#851, see the
  `specs` governance note above and [[0078-asset-category-specs-dictionary]]); flipping it into an
  enforced `400` is a deliberate future upgrade path, not v1.
- **Advanced asset search** — `?q=` today is a simple case-insensitive substring (ILIKE) over
  `name`/`serial`/`assetTag`, **unindexed** (fine at small-team scale). Full-text / indexed search
  is deferred to its own task.

Related: [[asset-model]] · [[location]] · [[asset-category]] · [[asset-assignment]] ·
[[asset-history]] · [[asset-centric]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0018-api-documentation-swagger]] · [[0033-asset-history-event-model]]
