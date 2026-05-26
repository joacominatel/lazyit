---
title: "ADR-0034: Consumables design (cached stock + append-only movements)"
tags: [adr]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0034: Consumables design (cached stock + append-only movements)

## Status

accepted — 2026-05-26. Fourth front of the backend-completion epic (#4, sub-issue #11). Implements
the consumables area that [[0008-consumables-vs-assets]] separated from assets; reuses the
soft-delete extension ([[0032-soft-delete-middleware]]) and the `X-User-Id` shim via the shared
`ActorService` ([[0033-asset-history-event-model]] / [[0022-draft-visibility-auth-shim]]).

## Context

[[0008-consumables-vs-assets]] decided consumables are **stock-counted** (a quantity on hand), not
tracked individually like assets. Implementing forces concrete choices: how stock is represented,
what a movement means, and how under-stocking is prevented.

## Considered options

**(1) Stock representation — computed-on-read vs cached column.** Summing the movement ledger on
every read is O(movements) and awkward to filter/sort by. → **cached `currentStock`** on
`Consumable`, maintained transactionally by each movement. The append-only [[consumable-movement]]
ledger is the source of truth; the cache is a derived, always-updated-in-the-same-transaction value.

**(2) `ADJUSTMENT` semantics — signed delta vs absolute set.** `quantity` is always positive (so a
signed delta can't go down). → **`ADJUSTMENT` sets `currentStock` to `quantity`** (an absolute
physical recount); `IN` adds, `OUT` subtracts. This makes "I counted 50 on the shelf" a first-class
operation.

**(3) Negative stock — allow vs forbid.** → **forbid**: an `OUT` that would drive `currentStock`
below 0 raises **409** and the whole transaction rolls back (no movement, no cache change).

## Decision

- **`ConsumableCategory`** — user-managed grouping (`name` unique, `description?`, `icon?`, `order?`,
  soft delete). Like [[application-category]]: FK `onDelete: SetNull`, **no 409 guard** on delete.
- **`Consumable`** — `name`, `sku?` (unique), `categoryId?` (`SetNull`), `description?`,
  `currentStock` (Int, cached, default 0, **never edited directly**), `minStock?` (reorder
  threshold), `unit` (free string, default `"units"`), `notes?`, soft delete + timestamps.
- **`ConsumableMovement`** — append-only ([[0006-soft-delete-and-auditing]]): autoincrement `id`,
  `consumableId` (FK `Restrict`), `type` (`IN` / `OUT` / `ADJUSTMENT`), `quantity` (Int, **positive**),
  `reason?`, `performedById?` (shim actor, `SetNull`), `notes?`, `createdAt` only.
- **Stock is maintained transactionally** (`prisma.$transaction`): each movement reads
  `currentStock`, computes the next value (`IN` add / `OUT` subtract / `ADJUSTMENT` set), **409 if an
  `OUT` would go negative**, then updates `Consumable.currentStock` and appends the movement — both
  or neither.
- **`performedById`** from the `X-User-Id` shim via the shared `ActorService`.
- **Endpoints**: CRUD for both entities; `POST /consumables/:id/movements`;
  `GET /consumables/:id/movements?type=&from=&to=`; `GET /consumables?lowStock=true` (filters
  `currentStock <= minStock` via a Prisma **field reference**, only where `minStock` is set).
- **Seed categories**: `Cables`, `Adapters`, `Peripherals`, `Office supplies`, `Other`.

## Consequences

- **Positive:** O(1) stock reads and easy low-stock filtering; the ledger gives a full, auditable,
  append-only stock history; cache and ledger can't diverge within a request (one transaction).
- **Cache trust:** `currentStock` is only correct because every mutation goes through a movement in a
  transaction — code must **never** write `currentStock` directly. A periodic reconcile job (sum the
  ledger, compare) is a possible future safety net.
- **`ADJUSTMENT` can't set 0** (quantity is ≥ 1); reach zero with an `OUT` of the remainder. Minor.
- **Deferred:** low-stock **alerting / notifications** (today it's only a query filter); supplier /
  unit-cost tracking; barcode/SKU scanning.

Related: [[consumable]] · [[consumable-category]] · [[consumable-movement]] ·
[[0008-consumables-vs-assets]] · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
[[0032-soft-delete-middleware]] · [[0022-draft-visibility-auth-shim]] · [[prisma-migrations]]
