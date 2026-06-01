---
title: ConsumableMovement
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-26
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
- `performedById?` — FK → [[user]], `onDelete: SetNull`; the actor, from the `X-User-Id` shim
  ([[0022-draft-visibility-auth-shim]]).
- `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]); no `updatedAt` / `deletedAt`.

## Business rules

- **Append-only and immutable**; corrections are new movements (e.g. an `ADJUSTMENT`), never edits.
- Each movement **transactionally** updates `Consumable.currentStock`: `IN` adds, `OUT` subtracts
  (**409** if it would go negative — nothing is written), `ADJUSTMENT` sets the absolute counted
  value. `quantity` is always positive.

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
  absolute recount). This is the secondary path, not the default.

Related: [[consumable]] · [[consumable-category]] · [[user]] · [[0034-consumables-design]] ·
[[0006-soft-delete-and-auditing]] · [[0005-id-strategy]]
