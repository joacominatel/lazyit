---
title: ConsumableMovement
tags: [domain, entity]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# ConsumableMovement

> ⚪ planned · Area: Consumables · Implementation order: 6

## Purpose

A single stock movement for a [[consumable]] — an entry (received) or exit (consumed/issued)
with a quantity. The append-only ledger from which current stock is computed.

## Relationships

- **belongs to** one [[consumable]].
- May reference the [[user]] who performed/received the movement.

## Business rules

- **Append-only.** Movements are recorded, never edited — to keep stock auditable. A
  correction is a new compensating movement, not an edit.
- Sign/direction (in vs out) plus quantity define the delta.

## Conventions

- **ID:** `autoincrement()` — ledger/log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only (append-only → no `updatedAt`/`deletedAt`; see
  [[0006-soft-delete-and-auditing]]).

Related: [[consumable]] · [[user]] · [[0006-soft-delete-and-auditing]]
