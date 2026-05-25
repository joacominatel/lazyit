---
title: "ADR-0019: AssetAssignment referential integrity & lifecycle"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0019: AssetAssignment referential integrity & lifecycle

## Status

accepted — 2026-05-25. Implements the ownership join promised by [[0004-asset-centric-design]];
builds on [[0006-soft-delete-and-auditing]] (lifecycle joins) and [[0005-id-strategy]].

## Context

[[asset-assignment]] is the timestamped join recording **who owns an [[asset]] over time**.
[[0004-asset-centric-design]] requires ownership to be "a timestamped join, never a column", and
[[0006-soft-delete-and-auditing]] already classifies such joins as **lifecycle** rows (closed via
`releasedAt`, never soft-deleted). Implementing it forced concrete choices the existing ADRs leave
open:

1. **What happens to assignments when their asset or user is deleted?** Asset's *other* FKs
   (`modelId`, `locationId`) are `onDelete: SetNull` ([[asset]]) — detach, don't destroy. Is that
   right for the ownership link too?
2. **Can the same person hold two active assignments on the same asset?** Ownership is
   deliberately **multi-owner** (several users may own one asset at once), but a duplicate *active*
   row for the *same* (asset, user) is just noise.
3. **How is an assignment ended and edited**, given it's append-only history?

## Considered options

**(1) Required FKs `assetId` / `userId`:**

- **`Cascade`** — deleting an asset/user deletes its assignments. ❌ Destroys history; violates
  auditability ([[vision]]).
- **`SetNull`** — detach, like `modelId`/`locationId`. ❌ Impossible: both columns are
  **required** (an assignment with no asset or no user is meaningless).
- **`Restrict`** — block deleting an asset/user that still has assignment rows. ✅ Preserves
  history; the asset/user can still be **soft-deleted** (an `UPDATE` — see Consequences).

**(2) Optional audit FKs `assignedById` / `releasedById` (who performed the action):**

- **`Restrict`** — can't delete anyone who ever assigned/released. Overly strict for optional
  metadata.
- **`SetNull`** — losing the actor nulls the link but keeps the assignment. ✅ Fits their optional
  nature.

**(3) "One active assignment per (asset, user)":**

- **Plain `@@unique([assetId, userId])`** — ❌ would forbid ever re-assigning the same person to
  the same asset after release.
- **Partial unique index `… WHERE releasedAt IS NULL`** — ✅ uniqueness applies only to *active*
  rows; released history is exempt and multi-owner is preserved. Not expressible in the Prisma
  schema → raw SQL in the migration.

**(4) Lifecycle surface:** soft delete (`deletedAt`) vs explicit `releasedAt`; whether to expose
`DELETE`.

## Decision

- **`assetId`, `userId` → `onDelete: Restrict`.** An asset/user with assignment history cannot be
  **hard-deleted**; history is protected. The asymmetry with `modelId`/`locationId` (`SetNull`) is
  intentional — those FKs are descriptive, ownership is not.
- **`assignedById`, `releasedById` → `onDelete: SetNull`**, both optional (`null` = system/unknown).
- **Partial unique index** `asset_assignments_assetId_userId_active_key` on `(assetId, userId)
  WHERE releasedAt IS NULL`, added as raw SQL in the migration (see [[prisma-migrations]] §3). The
  service also pre-checks for a friendly `409`; the index is the race-proof backstop.
- **No `deletedAt`; no `DELETE` endpoint.** Assignments are append-only
  ([[0006-soft-delete-and-auditing]]): opened by `POST`, ended by `PATCH /:id/release` (sets
  `releasedAt = now()`), with only `notes` and `releasedAt` mutable. Identity (`assetId`, `userId`,
  `assignedAt`) is immutable.

## Consequences

- **Positive:** ownership history is tamper-resistant (can't be deleted out from under an asset);
  multi-owner works; re-assignment after release works; exactly one clean active row per
  (asset, user).
- **Soft vs hard delete (important):** the API's `DELETE /assets/:id` and `DELETE /users/:id` are
  **soft** (`UPDATE deletedAt`), so they are **not** blocked by `Restrict` — that guard only fires
  on a real row `DELETE` (e.g. a stray `prisma.asset.delete()`), which raises `P2003` → `400` via
  the global filter. `Restrict` is therefore a **database-level safety net**, not an API behaviour.
  A future rule may also refuse to *soft*-delete an asset/user with active assignments, but that's
  application logic, not this FK.
- **Trade-offs:** the partial index is invisible to `schema.prisma` (lives only in the migration);
  documented at the model and in [[prisma-migrations]]. `Restrict` means future hard-delete tooling
  must release/relocate assignments first.
- **Follow-ups:** [[asset-history]] (append-only audit log) is still pending; a possible
  soft-delete-time guard on assets/users that still have active assignments.
```

Related: [[asset-assignment]] · [[asset]] · [[user]] · [[0004-asset-centric-design]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] · [[prisma-migrations]]
