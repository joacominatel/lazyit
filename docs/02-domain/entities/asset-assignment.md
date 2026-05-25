---
title: AssetAssignment
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# AssetAssignment

> 🟢 implemented · Area: Assets (core) · Implementation order: 3

## Purpose

The timestamped join linking an [[asset]] to its owners ([[user]]) over time. Carrying
`assignedAt` / `releasedAt` turns ownership into **automatic history** instead of a single mutable
column — the heart of the asset-centric model ([[asset-centric]], [[0004-asset-centric-design]]).
Ownership is **many-to-many and concurrent**: an asset may have several active owners at once.

## Relationships

- **belongs to** one [[asset]] (`assetId`, required, `onDelete: Restrict`).
- **belongs to** one [[user]] — the owner (`userId`, required, `onDelete: Restrict`).
- **optionally references** a [[user]] as `assignedBy` and/or `releasedBy` — audit of who acted
  (`onDelete: SetNull`; `null` when the system acted or it's unknown). Recorded from the
  `X-User-Id` shim, not the body — see the callout below.

## Business rules

- **Append-only lifecycle join** ([[0006-soft-delete-and-auditing]]): rows are **never deleted**.
  An assignment with `releasedAt = null` is *active*; setting `releasedAt` ends it without losing
  the record. There is **no `DELETE` endpoint** — asking to delete an assignment is a conceptual
  error; release it instead.
- **Concurrent / multi-owner (decided 2026-05-25):** an asset may have **multiple active
  assignments** at once (several `releasedAt = null` rows for different users) — e.g. a shared
  server with several responsible people. Releasing one owner doesn't affect the others.
- **One active assignment per `(asset, user)` (confirmed at implementation):** a **partial unique
  index** `… WHERE releasedAt IS NULL` forbids duplicate *active* rows for the same person on the
  same asset, while still allowing many users per asset and re-assignment after release. Prisma
  can't express a partial index, so it's raw SQL in the migration ([[0019-asset-assignment-integrity]],
  [[prisma-migrations]] §3). A friendly `409` pre-check backs it up; the index is the race-proof
  guarantee.
- **Immutable identity:** `assetId`, `userId` and `assignedAt` are set once and never change. Only
  `notes` and `releasedAt` are mutable. Reassigning a single owner = release that assignment +
  create a new one.
- **Referential integrity ([[0019-asset-assignment-integrity]]):** the required FKs are
  `onDelete: Restrict` — an [[asset]] or [[user]] with assignment rows **cannot be hard-deleted**.

> [!note] Actor comes from the `X-User-Id` shim, not the body
> `assignedById` (on open) and `releasedById` (on release) are taken from the optional `X-User-Id`
> header (the caller → a JWT later), **never** the request body
> ([[0022-draft-visibility-auth-shim]], [[0024-asset-assignment-actor-shim]]). Absent header →
> `null` actor (system/unknown), allowed by the `SetNull`/optional design; a present header must be
> a well-formed id for a **live** (non-soft-deleted) user, else `400`. This converges AssetAssignment
> onto [[access-grant]]'s actor pattern — [[0024-asset-assignment-actor-shim]] superseded the
> original body-based design of [[0019-asset-assignment-integrity]] (a breaking contract change,
> safe pre-auth with no external clients).

> [!warning] Soft delete vs hard delete — `Restrict` is a DB safety net
> The API's `DELETE /assets/:id` and `DELETE /users/:id` are **soft** deletes (`UPDATE deletedAt`),
> so they are **not** blocked by `Restrict` — that guard only triggers on a real row `DELETE`
> (which surfaces as `400`/P2003). So an asset *can* be soft-deleted while it has active
> assignments today; `Restrict` only protects against accidental hard deletes. A soft-delete-time
> guard could be added later — see [[0019-asset-assignment-integrity]].

## Conventions

- **ID:** `cuid()` — non-sensitive domain entity ([[0005-id-strategy]]). Note `userId` /
  `assignedById` / `releasedById` are **`uuid`** (`@db.Uuid`) because [[user]] uses `uuid`;
  `assetId` is `cuid`.
- **Timestamps:** `createdAt`, `updatedAt`. **No `deletedAt`** — `releasedAt` expresses lifecycle,
  not soft delete ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `AssetAssignment` → table `asset_assignments`. Validation schemas
(`AssetAssignmentSchema`, `CreateAssetAssignmentSchema`, `ReleaseAssetAssignmentSchema`,
`UpdateAssetAssignmentNotesSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/asset-assignment.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `assetId` | `cuid` | FK → [[asset]], required, `onDelete: Restrict`. |
| `userId` | `uuid` | FK → [[user]] (owner), required, `@db.Uuid`, `onDelete: Restrict`. |
| `assignedAt` | `datetime` | `@default(now())`; part of identity. Optional on create — pass it only to backdate an imported record. |
| `releasedAt` | `datetime?` | `null` while active; set to end the assignment. Not a soft delete. |
| `assignedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. Who assigned (null = system/unknown). |
| `releasedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. Who released. |
| `notes` | `string?` | optional free text (assignment or release reason); editable; `null` clears. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([assetId])`, `@@index([userId])`, plus the partial unique index above.

## Endpoints

`apps/api/src/asset-assignments/` (`AssetAssignmentsModule`):

- `POST /asset-assignments` — open an assignment; body `{ assetId, userId, assignedAt?, notes? }`.
  Optional `X-User-Id` header → `assignedById` (a bad/dead actor → `400`). Duplicate *active*
  `(asset, user)` → `409`; invalid `assetId`/`userId` → `400` (FK).
- `GET /asset-assignments?assetId=&userId=&activeOnly=` — list, newest first. `activeOnly`
  **defaults to `true`** (only `releasedAt = null`); pass `activeOnly=false` to include released.
- `GET /asset-assignments/:id` — one by id (`404` if missing).
- `PATCH /asset-assignments/:id/release` — body `{ notes? }`; optional `X-User-Id` header →
  `releasedById` (a bad/dead actor → `400`); sets `releasedAt = now()`. Already released → `409`.
- `PATCH /asset-assignments/:id/notes` — body `{ notes }` (`null` clears). The only free edit.
- **No `DELETE`** — by design (append-only).

Plus the natural sub-resource endpoints on the related entities:

- `GET /assets/:id/assignments?activeOnly=` — assignments of one [[asset]] (`404` if the asset is
  missing/soft-deleted).
- `GET /users/:id/assignments?activeOnly=` — assignments of one [[user]].

All documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[asset]] · [[user]] · [[asset-history]] · [[asset-centric]] ·
[[0004-asset-centric-design]] · [[0006-soft-delete-and-auditing]] ·
[[0019-asset-assignment-integrity]] · [[0024-asset-assignment-actor-shim]] ·
[[0022-draft-visibility-auth-shim]] · [[prisma-migrations]]
