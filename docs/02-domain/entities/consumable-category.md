---
title: ConsumableCategory
tags: [domain, entity]
status: accepted
created: 2026-05-26
updated: 2026-10-15
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
- `usageCount?` — **read-only, computed, not a column** (#1540). Only on the list read
  (`GET /consumable-categories`): the number of **live** consumables filed under the category (`0` when
  unused), so Settings → Taxonomies shows what is in use before an archive. `Consumable` is not
  auto-scoped by the read filter, so the count filters `deletedAt: null` explicitly. Absent from
  `GET /:id` and the write responses.

## Endpoints

`apps/api/src/consumable-categories/` — CRUD (`GET` / `GET /:id` / `POST` / `PATCH /:id` /
`GET /:id/delete-impact` the count plus the first 50 consumables / `DELETE /:id` soft delete with
`?strategy=detach` or `?strategy=move&targetId=` / `POST /:id/restore` ADMIN-only clears `deletedAt`,
[[0041-soft-delete-reuse-and-restore]]), ordered by `order` (nulls last) then `name`.

## Business rules

- **Delete with one resolution (AUD-085).** While live consumables are filed under the category, the
  delete needs **one** resolution for all of them: `detach` (they keep no category) or `move` (they all
  go to another live consumable category). Without one it is a `409` `DELETE_RESOLUTION_REQUIRED`;
  the move and the soft delete share one transaction, and a restore re-links nothing. Mirrors
  [[application-category]].
- Soft-deleted categories are hidden from the list/detail by the ADR-0032 read filter:
  `ConsumableCategory` is in `SOFT_DELETABLE_MODELS` (its service carries no explicit `deletedAt`
  guard, so the extension must auto-scope it — see [[0032-soft-delete-middleware]]).
- Seed set: `Cables`, `Adapters`, `Peripherals`, `Office supplies`, `Other` — seeded **once** (only
  into an empty table), so renaming a seeded category never re-creates it on the next `db seed`.

Related: [[consumable]] · [[consumable-movement]] · [[application-category]] · [[asset-category]] ·
[[0034-consumables-design]] · [[0006-soft-delete-and-auditing]]
