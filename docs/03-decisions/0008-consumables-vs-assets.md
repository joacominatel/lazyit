---
title: "ADR-0008: Consumables modeled separately from assets"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0008: Consumables modeled separately from assets

## Status

accepted

## Context

Some items (cables, mice, keyboards, paper, toner) are not worth tracking individually — we
care about *stock count*, not *which unit is where*. Others ([[asset]]s) are tracked as
individuals with owners, location and history.

## Considered options

- **Everything is an asset** — track each cable as an [[asset]]. Cons: absurd overhead; pollutes
  the asset inventory with throwaway items.
- **Separate consumables domain** — [[consumable]] (definition + stock) and
  [[consumable-movement]] (append-only in/out ledger), distinct from assets.

## Decision

Model consumables separately. Current stock is derived from the [[consumable-movement]] ledger
rather than a mutable counter, keeping stock auditable.

## Consequences

- **Positive:** asset inventory stays meaningful (tracked individuals only); stock is auditable
  via an append-only ledger.
- **Trade-offs:** two mental models ("tracked individually" vs "counted"); the boundary
  (when does an item deserve to be an asset?) needs a documented rule of thumb.
- **Follow-ups:** ledger rows follow the append-only convention ([[0006-soft-delete-and-auditing]]).
