---
title: ConsumableCategory
tags: [domain, entity]
status: accepted
created: 2026-05-26
updated: 2026-05-26
---

# ConsumableCategory

> 🟢 implemented · Area: Consumables · Implementation order: 7 · see [[0034-consumables-design]]

## Purpose

A user-managed grouping for [[consumable]]s (Cables, Adapters, Peripherals, …). Like
[[asset-category]] / [[application-category]]: created, edited and soft-deleted from the app; the
seed set is an initial, non-special list.

## Fields

- `id` — `cuid()`; `name` (unique among **live** rows only — a PARTIAL unique index
  `WHERE "deletedAt" IS NULL`, freed for reuse / restore on soft delete,
  [[0041-soft-delete-reuse-and-restore]]); `description?`; `icon?` (heroicon name, free string);
  `order?` (sort key, nulls last); soft delete + timestamps ([[0006-soft-delete-and-auditing]]).

## Endpoints

`apps/api/src/consumable-categories/` — CRUD (`GET` / `GET /:id` / `POST` / `PATCH /:id` /
`DELETE /:id` soft delete / `POST /:id/restore` ADMIN-only clears `deletedAt`,
[[0041-soft-delete-reuse-and-restore]]), ordered by `order` (nulls last) then `name`.

## Business rules

- Deleting a category **detaches** its consumables (FK `onDelete: SetNull`) — **no 409 guard**
  (unlike [[article-category]]; the relation is optional). Mirrors [[application-category]].
- Soft-deleted categories are hidden from the list/detail by the ADR-0032 read filter:
  `ConsumableCategory` is in `SOFT_DELETABLE_MODELS` (its service carries no explicit `deletedAt`
  guard, so the extension must auto-scope it — see [[0032-soft-delete-middleware]]).
- Seed set: `Cables`, `Adapters`, `Peripherals`, `Office supplies`, `Other` — seeded **once** (only
  into an empty table), so renaming a seeded category never re-creates it on the next `db seed`.

Related: [[consumable]] · [[consumable-movement]] · [[application-category]] · [[asset-category]] ·
[[0034-consumables-design]] · [[0006-soft-delete-and-auditing]]
