---
title: Consumable
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-09-24
---

# Consumable

> 🟢 implemented · Area: Consumables · Implementation order: 7 · see [[0034-consumables-design]]

## Purpose

A **stock-counted** supply item — cables, adapters, toner, screws. Unlike an [[asset]] (tracked
individually), a consumable is a quantity on hand: we care about *how many*, not *which one*
([[0008-consumables-vs-assets]]).

## Fields

- `id` — `cuid()`.
- `name`, `sku?` (unique among **live** rows when present — a PARTIAL unique index
  `WHERE "deletedAt" IS NULL`, freed for reuse / restore on soft delete,
  [[0041-soft-delete-reuse-and-restore]]), `description?`, `notes?`.
- `categoryId?` — FK → [[consumable-category]], `onDelete: SetNull`.
- `currentStock` — Int, **cached** on-hand quantity (default 0). **Never edited directly** — only
  through a [[consumable-movement]], maintained transactionally ([[0034-consumables-design]]). The
  ledger is the source of truth; this column is a derived cache kept in sync in the same transaction.
- `minStock?` — reorder threshold for the low-stock filter (`currentStock <= minStock`).
- `unit` — free string (`"units"`, `"meters"`, `"boxes"`…), default `"units"`.
- `returnable` — Boolean, default `false` ([[0098-consumable-delivery-targets]]). A returnable item (a
  loaner headset, a projector remote) is expected back. A **delivery** of it stays *outstanding* until
  it is returned. Each delivery **snapshots** the flag when it is made, so toggling it later never
  changes whether a past delivery is owed back. Existing consumables read `false`.
- soft delete + `createdAt` / `updatedAt` ([[0006-soft-delete-and-auditing]]).

## Endpoints

`apps/api/src/consumables/` (`ConsumablesModule`):

- `GET /consumables?lowStock=true` — list (alphabetical); `lowStock=true` returns only items at/under
  their `minStock`.
- `GET /consumables/:id` · `POST` · `PATCH /:id` · `DELETE /:id` (soft delete) ·
  `POST /:id/restore` (ADMIN-only — clears `deletedAt`, [[0041-soft-delete-reuse-and-restore]]).
  Create/update do **not** accept `currentStock` (it starts at 0 and changes only via movements).
- `POST /consumables/:id/movements` — record a stock movement ([[consumable-movement]]). The actor comes
  from the authenticated principal. An `OUT` may name one **delivery target** and an `IN` may **return**
  a delivery ([[0098-consumable-delivery-targets]]).
- `GET /consumables/:id/movements?type=&from=&to=` — the movement ledger. Each row carries its resolved
  delivery `target`.
- `GET /consumables/deliveries?targetUserId=|targetAssetId=|targetLocationId=&outstandingOnly=&from=&to=&limit=&offset=`
  — the deliveries made to **one** user, asset or location. Paginated ([[0030-list-pagination-contract]]),
  newest first, with `returnedQuantity` / `outstandingQuantity`. It also requires the target domain's
  read permission (`user:read` for a person). Deliveries of a soft-deleted consumable stay listed. See
  [[consumable-movement]] § Deliveries.

## Business rules

- Stock changes only through movements, transactionally; an `OUT` below 0 is refused (409).
- A reorder threshold (`minStock`) powers the low-stock filter and the post-commit `low_stock` bell
  nudge ([[0056-in-app-notification-bell]]).
- A consumable stays a **counted quantity** even when delivered. A delivery records *where* units went
  (a person, an asset, a place). It is not an ownership join, and a location target is not
  per-location stock ([[0098-consumable-delivery-targets]]).

Related: [[consumable-category]] · [[consumable-movement]] · [[asset]] · [[0098-consumable-delivery-targets]] ·
[[0008-consumables-vs-assets]] · [[0034-consumables-design]] · [[0006-soft-delete-and-auditing]] ·
[[0005-id-strategy]]
