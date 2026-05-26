---
title: Consumable
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-26
---

# Consumable

> 🟢 implemented · Area: Consumables · Implementation order: 7 · see [[0034-consumables-design]]

## Purpose

A **stock-counted** supply item — cables, adapters, toner, screws. Unlike an [[asset]] (tracked
individually), a consumable is a quantity on hand: we care about *how many*, not *which one*
([[0008-consumables-vs-assets]]).

## Fields

- `id` — `cuid()`.
- `name`, `sku?` (unique when present), `description?`, `notes?`.
- `categoryId?` — FK → [[consumable-category]], `onDelete: SetNull`.
- `currentStock` — Int, **cached** on-hand quantity (default 0). **Never edited directly** — only
  through a [[consumable-movement]], maintained transactionally ([[0034-consumables-design]]). The
  ledger is the source of truth; this column is a derived cache kept in sync in the same transaction.
- `minStock?` — reorder threshold for the low-stock filter (`currentStock <= minStock`).
- `unit` — free string (`"units"`, `"meters"`, `"boxes"`…), default `"units"`.
- soft delete + `createdAt` / `updatedAt` ([[0006-soft-delete-and-auditing]]).

## Endpoints

`apps/api/src/consumables/` (`ConsumablesModule`):

- `GET /consumables?lowStock=true` — list (alphabetical); `lowStock=true` returns only items at/under
  their `minStock`.
- `GET /consumables/:id` · `POST` · `PATCH /:id` · `DELETE /:id` (soft delete). Create/update do
  **not** accept `currentStock` (it starts at 0 and changes only via movements).
- `POST /consumables/:id/movements` — record a stock movement ([[consumable-movement]]); optional
  `X-User-Id` → `performedById`.
- `GET /consumables/:id/movements?type=&from=&to=` — the movement ledger.

## Business rules

- Stock changes only through movements, transactionally; an `OUT` below 0 is refused (409).
- A reorder threshold (`minStock`) powers the low-stock filter (alerting itself is deferred).

Related: [[consumable-category]] · [[consumable-movement]] · [[asset]] ·
[[0008-consumables-vs-assets]] · [[0034-consumables-design]] · [[0006-soft-delete-and-auditing]] ·
[[0005-id-strategy]]
