---
title: AssetAssignment
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-21
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
  (`onDelete: SetNull`; `null` when the system acted or it's unknown) — or, when a
  [[service-account]] acted, that account as `assignedBySa` / `releasedBySa`. Recorded from the
  authenticated principal, never the body — see the callout below.
- **optionally references** a [[user]] as `acknowledgedBy` (`onDelete: SetNull`) — who confirmed
  receipt (ADR-0089 Part B, #1029). By the self-scoped write it always equals `userId` (the owner
  acknowledges their OWN assignment). See "Check-out acknowledgement" below.

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
- **Live-row guard on assign (round-2 correctness):** `create()` rejects (`400`) an `assetId` or
  `userId` that does not reference a **live (non-soft-deleted)** row — you can't assign a
  decommissioned asset or a departed user. Mirrors the same guard on [[access-grant]]
  (`assertUsable`); the soft-delete read filter ([[0032-soft-delete-middleware]]) makes the lookup
  return null for deleted rows, so the check is a single `findFirst`.
- **`assignedAt` is never in the future (audit 2026-10-10, AUD-026):** it exists to backdate an
  imported or historical record, but a future value is a `400` on create — a release stamps
  `releasedAt = now()`, which would land before it and store the ownership interval inverted.
  Write-only: rows stored before the rule still load and release as before.
- **Immutable identity:** `assetId`, `userId` and `assignedAt` are set once and never change. The
  mutable lifecycle metadata is `notes`, `releasedAt`, and the acknowledgement fields below.
  Reassigning a single owner = release that assignment + create a new one.
- **Check-out acknowledgement (ADR-0089 Part B, #1029):** additive lifecycle metadata —
  `acknowledgedAt DateTime?`, `acknowledgedById String? @db.Uuid` (FK [[user]], `onDelete: SetNull`),
  `acknowledgeNote String?` — recording that the person a device was checked out to **confirmed they
  hold it**. This is **not** an append-only violation: `AssetAssignment` is already a mutable
  lifecycle join (like `releasedAt`), and the immutable trail is the `ACKNOWLEDGED` [[asset-history]]
  event. **Self-service, set-once, race-safe:** the transition scopes to the caller's OWN active
  assignment (`where: { id, userId: caller, releasedAt: null, acknowledgedAt: null }`) — a
  double-click / concurrent call flips the row at most once (mirrors `release()`'s conditional write),
  and already-acknowledged / released / not-yours all return `409`. On success a **targeted**
  notification (`asset_assignment.acknowledged`) nudges the human who assigned the device.
  The route has no permission gate, so its response is the **self-read shape** (`id`, `userId` and
  the trimmed owner, `AssetListAssignmentSchema` — what `GET /assets/mine` inlines), never `notes` or
  who assigned / released the device (#1518).
- **Referential integrity ([[0019-asset-assignment-integrity]]):** the required FKs are
  `onDelete: Restrict` — an [[asset]] or [[user]] with assignment rows **cannot be hard-deleted**.

> [!note] The actor is the authenticated principal, never the body
> The actor of an open or a release is resolved from the verified principal
> (`@CurrentPrincipal()` → `request.principal`, `ActorService.resolveActor`), **never** from the
> request body. A human lands in `assignedById` / `releasedById`; a [[service-account]] lands in
> `assignedBySaId` / `releasedBySaId` instead, with a DB **CHECK** enforcing at most one actor per
> slot — never a fake human ([[0048-service-accounts]], [[INVARIANTS]] INV-SA-4). `null` in both
> means the system acted or the actor is unknown.
>
> History: [[0024-asset-assignment-actor-shim]] first moved the actor from the body to the
> `X-User-Id` header ([[0022-draft-visibility-auth-shim]]). That header now survives only under
> `AUTH_MODE=shim` (dev and test), where the guard resolves it into the same principal.

> [!warning] Soft delete vs hard delete — `Restrict` is a DB safety net
> The API's `DELETE /assets/:id` and `DELETE /users/:id` are **soft** deletes (`UPDATE deletedAt`),
> so they are **not** blocked by `Restrict` — that guard only triggers on a real row `DELETE`
> (which surfaces as `400`/P2003). So an asset *can* be soft-deleted while it has active
> assignments today; `Restrict` only protects against accidental hard deletes. A soft-delete-time
> guard could be added later — see [[0019-asset-assignment-integrity]].

## Conventions

- **ID:** `cuid()` — non-sensitive domain entity ([[0005-id-strategy]]). Note `userId` /
  `assignedById` / `releasedById` / `acknowledgedById` are **`uuid`** (`@db.Uuid`) because [[user]]
  uses `uuid`; `assetId` and the service-account columns are `cuid`.
- **Timestamps:** `createdAt`, `updatedAt`. **No `deletedAt`** — `releasedAt` expresses lifecycle,
  not soft delete ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `AssetAssignment` → table `asset_assignments`. Validation schemas
(`AssetAssignmentSchema`, `CreateAssetAssignmentSchema`, `ReleaseAssetAssignmentSchema`,
`UpdateAssetAssignmentNotesSchema`, `AcknowledgeAssignmentSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/asset-assignment.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `assetId` | `cuid` | FK → [[asset]], required, `onDelete: Restrict`. |
| `userId` | `uuid` | FK → [[user]] (owner), required, `@db.Uuid`, `onDelete: Restrict`. |
| `assignedAt` | `datetime` | `@default(now())`; part of identity. Optional on create — pass it only to backdate an imported record; a future value is a `400`. |
| `releasedAt` | `datetime?` | `null` while active; set to end the assignment. Not a soft delete. |
| `assignedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. The **human** who assigned (null = system/unknown). |
| `releasedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. The **human** who released. |
| `assignedBySaId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`. The **non-human** who assigned. At-most-one-actor CHECK with `assignedById`. |
| `releasedBySaId` | `cuid?` | FK → [[service-account]], `onDelete: SetNull`. The **non-human** who released. At-most-one-actor CHECK with `releasedById`. |
| `acknowledgedAt` | `datetime?` | When the owner confirmed receipt (ADR-0089 Part B). `null` = not acknowledged. Set once. |
| `acknowledgedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. Always equals `userId` (self-scoped write). |
| `acknowledgeNote` | `string?` | Optional note captured at acknowledgement (the wire body field is `note`). |
| `notes` | `string?` | optional free text (assignment or release reason); editable; `null` clears. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([assetId])`, `@@index([userId])`, plus the partial unique index above.

The shared read schema carries every column above. The acknowledgement fields and
`assignedBySaId` / `releasedBySaId` are `.nullish()` there because they were added to an existing
schema.

## Endpoints

`apps/api/src/asset-assignments/` (`AssetAssignmentsModule`):

- `POST /asset-assignments` — open an assignment (`asset:write`); body
  `{ assetId, userId, assignedAt?, notes? }`. The actor comes from the principal. Duplicate *active*
  `(asset, user)` → `409`; a missing or soft-deleted `assetId`/`userId` → `400`; an `assignedAt` in
  the future → `400`.
- `GET /asset-assignments?assetId=&userId=&activeOnly=` — list (`asset:read`), newest first. `activeOnly`
  **defaults to `true`** (only `releasedAt = null`); pass `activeOnly=false` to include released.
- `GET /asset-assignments/:id` — one by id (`asset:read`; `404` if missing).
- `PATCH /asset-assignments/:id/release` (`asset:write`) — body `{ notes? }`; sets
  `releasedAt = now()` and the releasing actor from the principal. Already released → `409`.
- `PATCH /asset-assignments/:id/notes` (`asset:write`) — body `{ notes }` (`null` clears). The only
  free edit.
- `POST /asset-assignments/:id/acknowledge` — **self-service** acknowledgement of receipt (ADR-0089
  Part B, #1029); body `{ note? }`. Any authenticated **human**; **no permission** — the authorization
  is "it's your OWN active assignment" (the `/access-requests/mine` self-scope carve-out), and a
  service account is `403`'d (`ServicePrincipalForbiddenGuard`). Already acknowledged / released /
  not-yours → `409`. Sets `acknowledgedAt = now()`, `acknowledgedById = caller`, optional
  `acknowledgeNote`; records an `ACKNOWLEDGED` [[asset-history]] event and, post-commit, a targeted
  `asset_assignment.acknowledged` nudge to the assigner.
- **No `DELETE`** — by design (append-only).

> [!note] Emits [[asset-history]] events
> Opening an assignment records an `ASSIGNED` event, releasing one records `RELEASED`, and
> acknowledging receipt records `ACKNOWLEDGED` (payload `{ userId }` = the acknowledging owner) — each
> transactionally with the change, with the actor from the principal ([[0033-asset-history-event-model]]).

Plus the natural sub-resource endpoints on the related entities:

- `GET /assets/:id/assignments?activeOnly=` — assignments of one [[asset]] (`404` if the asset is
  missing/soft-deleted).
- `GET /users/:id/assignments?activeOnly=` — assignments of one [[user]].

All documented via Swagger ([[0018-api-documentation-swagger]]).

Related: [[asset]] · [[user]] · [[service-account]] · [[asset-history]] · [[asset-centric]] ·
[[0004-asset-centric-design]] · [[0006-soft-delete-and-auditing]] ·
[[0019-asset-assignment-integrity]] · [[0024-asset-assignment-actor-shim]] ·
[[0089-bulk-receiving-and-checkout-acknowledgement]] ·
[[0022-draft-visibility-auth-shim]] · [[0033-asset-history-event-model]] · [[0048-service-accounts]] ·
[[INVARIANTS]] · [[prisma-migrations]]
