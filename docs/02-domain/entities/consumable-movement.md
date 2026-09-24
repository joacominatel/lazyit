---
title: ConsumableMovement
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-09-24
---

# ConsumableMovement

> 🟢 implemented · Area: Consumables · Implementation order: 7 · see [[0034-consumables-design]]

## Purpose

An **append-only** ledger row recording a single change to a [[consumable]]'s stock. The ledger is
the source of truth; `Consumable.currentStock` is a cache derived from it (kept in sync in the same
transaction).

## Fields

- `id` — `autoincrement()` (log entity, [[0005-id-strategy]]).
- `consumableId` — FK → [[consumable]], required, `onDelete: Restrict` (a consumable with movement
  history can't be hard-deleted).
- `type` — `IN` (add) · `OUT` (subtract) · `ADJUSTMENT` (set absolute). See [[0034-consumables-design]].
- `quantity` — Int, **always positive**.
- `reason?`, `notes?`.
- `performedById?` — FK → [[user]], `onDelete: SetNull`; the **human** actor, from the verified
  principal (the `X-User-Id` shim is dev-only — [[0038-jit-user-provisioning]],
  [[0022-draft-visibility-auth-shim]]).
- `serviceAccountId?` — FK → [[service-account]], `onDelete: SetNull`; the **non-human** actor when a
  service account performed the movement. A DB **CHECK** enforces at most one of (`performedById`,
  `serviceAccountId`) — honest attribution, never a fake human ([[0048-service-accounts]],
  [[INVARIANTS]] INV-SA-4).
- **Delivery target** ([[0098-consumable-delivery-targets]]). At most **one** of these may be set, and
  only on an `OUT`:
  - `targetUserId?` → [[user]]
  - `targetAssetId?` → [[asset]]
  - `targetLocationId?` → [[location]]

  All three FKs are `onDelete: Restrict`, because a delivery is history. Soft deletes are UPDATEs and are
  unaffected.
- `returnable` — Boolean, default `false`. A **snapshot** of `Consumable.returnable` taken when a
  targeted `OUT` is written. It is only ever `true` on a delivery.
- `returnOfId?` — a self-FK → the delivery (`OUT`) this `IN` **returns**, `onDelete: Restrict`.
- DB **CHECKs** (raw SQL, [[prisma-migrations]] §3):
  - `consumable_movements_at_most_one_target`
  - `consumable_movements_target_only_on_out`
  - `consumable_movements_return_only_on_in`
  - `consumable_movements_returnable_only_on_delivery`
- Indexes on each target column and on `returnOfId`.
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]); no `updatedAt` / `deletedAt`.

## Business rules

- **Append-only and immutable**; corrections are new movements (e.g. an `ADJUSTMENT`), never edits.
- Each movement **transactionally** updates `Consumable.currentStock`: `IN` adds, `OUT` subtracts
  (**409** if it would go negative — nothing is written), `ADJUSTMENT` sets the absolute counted
  value. `quantity` is always positive.

## Deliveries and returns

[[0098-consumable-delivery-targets]]. Everything goes through `POST /consumables/:id/movements`.

- **Delivery** — an `OUT` naming one target. The target must be a **live** row: a missing or
  soft-deleted user, asset or location → **400**. After the guarded decrement, the consumable's
  `returnable` is read inside the same transaction and stamped on the movement.
- **Return** — an `IN` with `returnOfId`.
  - The delivery row is locked first (`SELECT … FOR UPDATE`), so two concurrent returns serialize.
  - **400** if the delivery is missing, belongs to another consumable, is not a targeted `OUT`, or was
    not returnable when made.
  - **409** if the quantity exceeds the outstanding units (`delivery.quantity − SUM(returns)`). Partial
    returns are allowed.
  - The stock then goes back through the normal `IN` path.
  - A delivery made to a since-offboarded user can still be returned.
- **Asset timeline** — a delivery to an asset appends `CONSUMABLE_DELIVERED` to its [[asset-history]],
  and a return of one appends `CONSUMABLE_RETURNED`. Both are written in the movement's transaction,
  with the same actor.
- **Target descriptor on read.** Rows returned by `GET /consumables/:id/movements` and
  `GET /consumables/deliveries` carry a resolved `target`:
  - `{type:"user", id, displayName, isOffboarded}`
  - `{type:"asset", id, label, isDeleted}`
  - `{type:"location", id, name, isDeleted}`
  - `null` for an untargeted movement.

  The target is resolved even when soft-deleted, and it is flagged, never dangling. When the caller
  lacks the target domain's read permission (`user:read` / `asset:read` / `location:read`), the display
  fields and the flag are `null`.
- **Deliveries read** — `GET /consumables/deliveries`.
  - Exactly one target, plus `outstandingOnly`, `from`, `to` and the page window. Newest first.
  - Each item adds the consumable (with its `deletedAt`, since a soft-deleted consumable's deliveries
    stay listed), `returnedQuantity` and `outstandingQuantity`. Outstanding is 0 for a non-returnable
    delivery.
  - Listing by a user also requires `user:read`, by an asset `asset:read`, by a location
    `location:read` (403 otherwise).
- **Offboarding** moves no stock and closes no delivery. The offboarding sheet and the Return Act *list*
  the leaver's deliveries through this read.

## Frontend

Two affordances, same `POST /consumables/:id/movements` endpoint:

- **Quick adjust (the common case)** — a prominent `−1` / `+1` pair on each consumables **list** row
  and in the **detail** Stock panel. One click fires a minimal quantity-1 `OUT` / `IN` movement with
  **no `reason`/`notes`** (both optional in the contract), an **optimistic** `currentStock` bump
  across the list + detail caches, and a Sonner toast (rolling back on error). `−1` is disabled at 0
  stock; if an `OUT` races to 0 the API's 409 is surfaced as a toast. Shared component
  `apps/web/app/(app)/consumables/_components/quick-adjust-buttons.tsx` over the
  `useQuickAdjustStock` hook.
- **Detailed form (be specific)** — the `Add… / Remove… / Adjust…` buttons on the detail page open
  `StockMovementDialog` for a chosen quantity, type and optional reason/notes (and an `ADJUSTMENT`
  absolute recount). This is the secondary path, not the default. On `Remove…` it also offers an
  optional **Deliver to** (nobody by default · a person · an asset · a location) that turns the `OUT`
  into a delivery ([[0098-consumable-delivery-targets]]); the quick `−1` never carries a target.
- **Deliveries panel** — a secondary section on the [[user]], [[asset]] and [[location]] detail pages
  over `GET /consumables/deliveries`: what that target received, an outstanding-only filter and date
  presets, and (with `consumable:write`) **Deliver consumable** and **Return…** on an outstanding
  returnable delivery (an `IN` with `returnOfId`). A 403 on the read hides the panel.
- **Ledger** — the consumable's movement list shows the delivery target on `OUT` rows (flagged when the
  target is offboarded/deleted, "(restricted)" when the caller can't read its domain) and "Return of
  delivery #N" on return rows.
- **Offboarding** — the user's outstanding returnable deliveries ("to return") and non-returnable
  deliveries ("delivered") appear on the offboarding sheet and the printed Return Act; the operator can
  switch the section off or exclude single rows before printing. Offboarding itself moves no stock.

Related: [[consumable]] · [[consumable-category]] · [[user]] · [[asset]] · [[location]] ·
[[asset-history]] · [[service-account]] · [[0098-consumable-delivery-targets]] ·
[[0034-consumables-design]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0048-service-accounts]] · [[INVARIANTS]]
