---
title: AccessGrant
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# AccessGrant

> 🟢 implemented · Area: Access · Implementation order: 5

## Purpose

The timestamped join recording that a [[user]] has access to an [[application]], over time — the
answer to "**who can access what?**". Like [[asset-assignment]], it carries lifecycle timestamps so
granting and (critically for offboarding) **revoking** access is auditable ([[problem-space]]). See
[[0023-access-management-design]].

## Relationships

- **belongs to** one [[user]] — the grantee (`userId`, **required** FK, `onDelete: Restrict`).
- **belongs to** one [[application]] (`applicationId`, **required** FK, `onDelete: Restrict`).
- **optionally references** a [[user]] as `grantedBy` and/or `revokedBy` — audit of who acted
  (`onDelete: SetNull`; `null` when the system acted or it's unknown).

## Business rules

- **Append-only lifecycle join** ([[0006-soft-delete-and-auditing]]): rows are **never deleted**. A
  grant with `revokedAt = null` is *active*; setting `revokedAt` ends it without losing the record.
  There is **no `DELETE` endpoint** — revoke instead.
- **Multi-grant (no uniqueness constraint):** a user may hold **several active grants** on the same
  application at different `accessLevel`s (e.g. `admin` on the console + `readonly` on the API).
  This deliberately **contrasts [[asset-assignment]]**, which forbids duplicate active rows via a
  partial unique index — access has no such rule ([[0023-access-management-design]]).
- **`accessLevel` is free-form**, app-defined (`admin`, `developer`, `viewer`, …). lazyit stores it
  verbatim and never interprets it; each [[application]] owns its vocabulary.
- **`expiresAt` is informative only** — no scheduler auto-revokes at expiry. An expired-but-not-
  revoked grant is still *active*; the list endpoints can **hide** it with `includeExpired=false`,
  but nothing in the database changes ([[0023-access-management-design]]).
- **Immutable identity:** `userId`, `applicationId` and `grantedAt` are set once. Only `notes`,
  `revokedAt` and `expiresAt` are mutable.
- **Create-time integrity:** `userId` and `applicationId` must reference **live** (non-soft-deleted)
  rows, or the API returns `400` — don't grant access to a decommissioned app or a departed user.
- **Referential integrity:** the required FKs are `onDelete: Restrict` — a [[user]] or
  [[application]] with grant rows **cannot be hard-deleted**.

> [!note] Actor comes from the `X-User-Id` shim, not the body
> `grantedById` (on create) and `revokedById` (on revoke) are taken from the optional `X-User-Id`
> header (the caller → a JWT later), **never** the request body ([[0022-draft-visibility-auth-shim]],
> [[0023-access-management-design]]). Absent header → `null` actor (system/unknown), allowed by the
> `SetNull`/optional design. This **partially supersedes** [[asset-assignment]]'s actor pattern
> (which reads `assignedById`/`releasedById` from the body, predating the shim); a follow-up will
> converge AssetAssignment onto the shim ([[0023-access-management-design]]).

> [!warning] Soft delete vs hard delete — `Restrict` is a DB safety net
> The API's `DELETE /applications/:id` and `DELETE /users/:id` are **soft** deletes
> (`UPDATE deletedAt`), so they are **not** blocked by `Restrict` — that guard only fires on a real
> row `DELETE` (→ `P2003`/`400`). So an app/user *can* be soft-deleted while it has active grants;
> the create-time live-check reduces, but doesn't eliminate, dangling references. Same nuance as
> [[asset-assignment]] ([[0019-asset-assignment-integrity]], [[0023-access-management-design]]).

> [!warning] Endpoints are insecure until auth lands
> The `X-User-Id` header is spoofable; there is no authorization on reads or writes yet — anyone can
> grant or revoke access ([[0016-auth-strategy-deferred]], [[0022-draft-visibility-auth-shim]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]). Note `userId` / `grantedById` / `revokedById` are
  **`uuid`** (`@db.Uuid`) because [[user]] uses `uuid`; `applicationId` is `cuid`.
- **Timestamps:** `createdAt`, `updatedAt`. **No `deletedAt`** — `revokedAt` expresses lifecycle,
  not soft delete ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `AccessGrant` → table `access_grants`. Validation schemas (`AccessGrantSchema`,
`CreateAccessGrantSchema`, `RevokeAccessGrantSchema`, `UpdateAccessGrantNotesSchema`,
`UpdateAccessGrantExpirySchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/access-grant.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `userId` | `uuid` | FK → [[user]] (grantee), required, `@db.Uuid`, `onDelete: Restrict`. |
| `applicationId` | `cuid` | FK → [[application]], required, `onDelete: Restrict`. |
| `accessLevel` | `string?` | free-form, app-defined (e.g. "admin"); lazyit never interprets it. |
| `grantedAt` | `datetime` | `@default(now())`; part of identity. Optional on create (backdate imports). |
| `revokedAt` | `datetime?` | `null` while active; set to end the grant. Not a soft delete. |
| `expiresAt` | `datetime?` | informative; no auto-revoke. `null` = no expiry. |
| `grantedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. From `X-User-Id`; null = system. |
| `revokedById` | `uuid?` | FK → [[user]], `@db.Uuid`, `onDelete: SetNull`. From `X-User-Id`; null = system. |
| `notes` | `string?` | optional free text; editable; `null` clears. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([userId])`, `@@index([applicationId])`. **No uniqueness constraint** (multi-grant).

## Endpoints

`apps/api/src/access-grants/` (`AccessGrantsModule`). The `X-User-Id` header is **optional** on
create/revoke and becomes the actor. Documented via Swagger ([[0018-api-documentation-swagger]]).

- `POST /access-grants` — open a grant. `userId`/`applicationId` must be live → else `400` (FK
  errors also map to `400`). `grantedById` = `X-User-Id` (null if absent).
- `GET /access-grants?userId=&applicationId=&activeOnly=&includeExpired=` — list, newest first.
  `activeOnly` **defaults to true** (`revokedAt = null`); `includeExpired` **defaults to true**
  (pass `false` to hide active grants already past `expiresAt`).
- `GET /access-grants/:id` — one by id (`404` if missing).
- `PATCH /access-grants/:id/revoke` — body `{ notes? }`; sets `revokedAt = now()`,
  `revokedById = X-User-Id`. Already revoked → `409`.
- `PATCH /access-grants/:id/notes` — body `{ notes }` (`null` clears). Metadata edit, no actor.
- `PATCH /access-grants/:id/expiry` — body `{ expiresAt }` (`null` = permanent). Metadata edit,
  no actor; never revokes/reactivates.
- **No `DELETE`** — by design (append-only).

Plus the natural sub-resource endpoints on the related entities:

- `GET /users/:id/access-grants?activeOnly=&includeExpired=` — grants of one [[user]] (`404` if the
  user is missing/soft-deleted).
- `GET /applications/:id/access-grants?activeOnly=&includeExpired=` — grants on one [[application]].

## Not yet implemented (deferred)

- [[access-request]] (approval workflow) — grants are created directly for now
  ([[0023-access-management-design]]).
- **Auto-revoke on `expiresAt`** via a scheduler/worker; a soft-delete-time guard on apps/users with
  active grants; **retrofitting [[asset-assignment]]** to the same `X-User-Id` actor pattern.

Related: [[user]] · [[application]] · [[application-category]] · [[access-request]] ·
[[asset-assignment]] · [[shared-package]] · [[0023-access-management-design]] ·
[[0019-asset-assignment-integrity]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0016-auth-strategy-deferred]] · [[0022-draft-visibility-auth-shim]] ·
[[0018-api-documentation-swagger]]
