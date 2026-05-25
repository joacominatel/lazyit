---
title: Consumable
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Consumable

> ⚪ planned · Area: Consumables · Implementation order: 6

## Purpose

A stock-counted item that is **not** tracked individually — cables, mice, keyboards, paper,
toner. The opposite of an [[asset]]: we care about *how many we have*, not *which one is
where*. This distinction is deliberate (see [[0008-consumables-vs-assets]]).

## Relationships

- **has** N [[consumable-movement]]s (stock in/out), from which current stock is derived.

## Business rules

- Current quantity is the sum of its [[consumable-movement]]s — the movements are the
  source of truth, not a mutable counter (auditable).
- May carry a reorder threshold for low-stock alerts.

## Conventions

- **ID:** `cuid()` — see [[0005-id-strategy]].
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

Related: [[consumable-movement]] · [[asset]] · [[0008-consumables-vs-assets]]
