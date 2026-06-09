---
id: SEC-050
title: Consumable & ConsumableCategory are not soft-delete filtered — archived rows leak on by-id reads / category list, and writes/movements hit soft-deleted rows
severity: medium
status: fixed
cwe: CWE-283
discovered: 2026-06-06
module: consumables
tags: [soft-delete-bypass, idor, authz, info-leak, adr-divergence]
---

# SEC-050 — Consumable / ConsumableCategory soft-delete bypass

## Summary

`Consumable` and `ConsumableCategory` both carry a `deletedAt` column but were never added to
`SOFT_DELETABLE_MODELS`, so the soft-delete extension does NOT auto-scope their reads. The by-id read
helpers (`findOne` / `assertExists`) and `consumable-categories` `findAll` carry no explicit
`deletedAt: null` either, so soft-deleted rows are returned by `GET /consumables/:id`,
`GET /consumable-categories`, `GET /consumable-categories/:id` and `GET /consumables/:id/movements`,
and a soft-deleted consumable can still be edited and receive `IN`/`ADJUSTMENT` stock movements.

## Description

ADR-0032 §"A future model with a `deletedAt` column must be added to `SOFT_DELETABLE_MODELS`, or its
reads won't be filtered" is exactly the rule that was broken here. The extension only filters the ten
models in the set (`User`, `Location`, `AssetCategory`, `AssetModel`, `Asset`, `ArticleCategory`,
`Article`, `ApplicationCategory`, `Application`, `ServiceAccount`) — `Consumable` and
`ConsumableCategory` are absent (`apps/api/src/prisma/soft-delete.extension.ts:17-30`), even though
both have `deletedAt` (`apps/api/prisma/schema.prisma:809`, `:840`) and ADR-0034 says consumables use
the soft-delete extension.

The list endpoints get away with it because they apply the slice EXPLICITLY via `deletedWhere(...)`
(`consumables.service.ts:75-78`), and the team knew the models aren't auto-filtered
(`common/deleted-filter.ts:18-19`). But the compensation was applied only to the LIST path. The
remaining reads/writes assume the extension filters them and it does not:

- `ConsumablesService.findOne` — `findFirst({ where: { id } })`, no `deletedAt` filter
  (`consumables.service.ts:131-139`). Docstring claims "throws 404 if missing or deleted" — it does
  not. `GET /consumables/:id` returns soft-deleted consumables.
- `ConsumablesService.assertExists` — same gap (`:304-312`), which gates `update`, `remove`,
  `createMovement` and `listMovements`. So:
  - `PATCH /consumables/:id` edits a soft-deleted consumable.
  - `POST /consumables/:id/movements` with `type: IN` reads the row (no filter, `:215-218`) and
    `increment`s `currentStock` on a soft-deleted consumable (`:227-230`). `type: ADJUSTMENT` sets it
    absolutely (`:258-261`). Both APPEND a ledger row pointing at an archived consumable.
  - Only the `OUT` path is guarded — its `updateMany` carries `deletedAt: null` (`:234-241`), so it
    can't decrement an archived row; but it then leaks the archived row's exact `currentStock` in the
    409 message (`:251-253`) instead of a 404. The IN/OUT/ADJUSTMENT asymmetry confirms the read-side
    guard was simply forgotten.
  - `GET /consumables/:id/movements` lists the ledger of a soft-deleted consumable.
- `ConsumableCategoriesService.findAll` — `findMany({ orderBy })`, no `deletedAt` filter
  (`consumable-categories.service.ts:14-18`). `GET /consumable-categories` LISTS soft-deleted
  categories to every reader, with no `deleted=` slice option (the controller has no such param). The
  sibling `application-categories` list is correct only because `ApplicationCategory` IS in the set.
- `ConsumableCategoriesService.findOne` — same gap (`:21-29`).

The `deleted=only` archived slice on `GET /consumables` is ADMIN-gated
(`assertCanListDeleted`), but `GET /consumables/:id` bypasses that gate entirely: any holder of
`consumable:read` (incl. VIEWER) can fetch an archived consumable by id.

## Impact

- **Soft-delete read bypass / info leak (CWE-283 / CWE-200):** archived consumables and categories are
  readable by any `consumable:read`/`category:read` caller, defeating the ADMIN-only archived slice.
- **Write to a logically-deleted row (integrity):** a soft-deleted consumable can be edited and have
  its `currentStock` changed via `IN`/`ADJUSTMENT` movements, and the append-only ledger gains rows
  attributed to an actor against an archived item. "Auditability by default / never resurrect a
  soft-deleted row" is a stated first principle (ADR-0006); this violates it.
- Intrinsic exploitability: a legitimate caller triggers it with normal calls regardless of auth.
  Data is non-PII inventory and single-org, so not Critical — but it is a real authZ/integrity bug,
  not latent. **Medium.**

## Proof of concept

Reasoned, **not executed** (the API is not run during review):

```sh
# soft-delete a consumable as ADMIN
curl -X DELETE http://localhost:3001/consumables/$ID -H 'X-User-Id: <admin-uuid>'

# still readable by anyone with consumable:read (should be 404):
curl http://localhost:3001/consumables/$ID -H 'X-User-Id: <viewer-uuid>'        # 200, archived row

# still writable — add stock to an archived consumable (should be 404):
curl -X POST http://localhost:3001/consumables/$ID/movements \
  -H 'content-type: application/json' -H 'X-User-Id: <member-uuid>' \
  -d '{"type":"IN","quantity":100}'                                             # 201, currentStock += 100

# every soft-deleted category is listed to everyone (no deleted= param exists):
curl http://localhost:3001/consumable-categories -H 'X-User-Id: <viewer-uuid>'  # includes archived
```

## Affected

- `apps/api/src/prisma/soft-delete.extension.ts:17-30` — `SOFT_DELETABLE_MODELS` omits `Consumable`
  and `ConsumableCategory` (both have `deletedAt`).
- `apps/api/src/consumables/consumables.service.ts:131-139` (`findOne`), `:304-312` (`assertExists`),
  `:215-218` + `:258-261` (IN/ADJUSTMENT write to unfiltered row).
- `apps/api/src/consumable-categories/consumable-categories.service.ts:14-18` (`findAll`), `:21-29`
  (`findOne`).
- `apps/api/prisma/schema.prisma:796-846` — `Consumable.deletedAt`, `ConsumableCategory.deletedAt`.
- Divergence from `docs/03-decisions/0032-soft-delete-middleware.md:69-70` and
  `docs/03-decisions/0034-consumables-design.md:16`.

## Recommendation

Pick the smallest fix that restores the ADR-0032 invariant:

1. **Preferred:** add `'Consumable'` and `'ConsumableCategory'` to `SOFT_DELETABLE_MODELS` so all
   `findFirst`/`findMany`/`count` are auto-scoped (the list paths already pass `includeSoftDeleted` for
   the `only` slice, so they keep working; update `soft-delete.extension.spec.ts` `size` to 12).
2. If they must stay out of the set, add an explicit `deletedAt: null` to `findOne`, `assertExists`,
   `consumable-categories` `findAll`/`findOne`, and guard the `IN`/`ADJUSTMENT` writes the way `OUT`
   already is (`where: { id, deletedAt: null }` via `updateMany`, or a filtered pre-read).

Either way, add a `deleted=` slice option to `GET /consumable-categories` for parity with the other
list endpoints, and make the `OUT` "insufficient stock" path 404 a soft-deleted consumable instead of
echoing its stock.

## Prevention

Make the ADR-0032 rule enforceable: a schema test that asserts every model with a `deletedAt` column
is present in `SOFT_DELETABLE_MODELS` (introspect the Prisma DMMF) — that single golden test would have
failed the day `Consumable`/`ConsumableCategory` were added. Stop relying on per-service docstrings
("throws 404 if deleted") that the code does not actually enforce.

## References

- CWE-283: Unverified Ownership · CWE-200: Exposure of Sensitive Information.
- ADR-0032 (soft-delete extension; the "must be added to SOFT_DELETABLE_MODELS" rule) ·
  ADR-0034 (consumables design) · ADR-0006 (soft delete / never resurrect) · ADR-0041 (restore).

## Resolution

**Status**: fixed (both halves)
**Date**: 2026-06-09

The finding had two halves. The two diverge on mechanism: `ConsumableCategory` joined
`SOFT_DELETABLE_MODELS` (it carries no explicit `deletedAt` guard), but `Consumable` deliberately
stays OUT of the set — its service filters `deletedAt` explicitly to serve the ADMIN archived-view
slice (`deletedWhere`) — so its remaining read/write paths were guarded explicitly instead. This
supersedes the finding's "Preferred" recommendation #1 (which suggested adding `Consumable` to the
set too); recommendation #2 (explicit per-path guards) is the one that keeps the archived-view slice
working.

### Category half — closed by #325

`ConsumableCategory` was added to `SOFT_DELETABLE_MODELS`
(`apps/api/src/prisma/soft-delete.extension.ts`), so `findAll`/`findOne` are now auto-scoped to live
rows and `GET /consumable-categories` no longer lists archived categories. The ADR-0032 text, the
extension comment, and `soft-delete.extension.spec.ts` (`size` → 11, with `Consumable` asserted
`false` and `ConsumableCategory` asserted `true`) were updated in that PR.

### Consumable half — closed by this PR

`apps/api/src/consumables/consumables.service.ts`:

- `findOne` — `findFirst({ where: { id, deletedAt: null } })`; `GET /consumables/:id` now 404s a
  soft-deleted consumable instead of returning it.
- `assertExists` — same `deletedAt: null` scope; this gates `update`, `remove`, `createMovement` and
  `listMovements`, so `PATCH /consumables/:id` and `GET /consumables/:id/movements` 404 a
  soft-deleted row.
- `createMovement` `IN` — the pre-read is live-scoped, so a soft-deleted consumable reads as `null`
  → 404 and is never incremented (no ledger row appended to an archived item).
- `createMovement` `ADJUSTMENT` — switched the plain `update` to a **live-guarded `updateMany`**
  (`where: { id, deletedAt: null }`); a plain `update` only P2025s when the row is truly absent, NOT
  when it is merely soft-deleted (the row still exists), which would silently recount an archived
  consumable. No matched row ⇒ 404 + rollback.
- `createMovement` `OUT` — the decrement path was already live-guarded; the 409 disambiguation
  read is now also live-scoped, so a soft-deleted consumable 404s instead of echoing its exact
  `currentStock` in the 409 message (the info-leak asymmetry called out in the finding).

### Tests added

`apps/api/src/consumables/consumables.service.spec.ts` — the existing `findOne` / `update` /
`listMovements` / `IN` / `OUT` assertions were tightened to expect the `deletedAt: null` scope (they
fail without the fix), plus new cases: `IN` against a soft-deleted consumable 404s via the
live-scoped pre-read, and `ADJUSTMENT` against a missing/soft-deleted row (guarded `updateMany`
`count: 0`) 404s and persists nothing. 32/32 green with the fix; 9 failed before it.

### Out of scope / residual

- The optional `deleted=` archived slice on `GET /consumable-categories` (a *parity* nice-to-have,
  not the leak) was NOT added: no other category-list endpoint (asset-/application-/article-
  categories) exposes one — they all auto-filter to live rows — so adding a query param here is an
  API-contract change, not part of closing the leak. The core leak (archived categories listed to
  everyone) is fully closed by #325.
- The finding's "Prevention" golden test (assert every `deletedAt` model is in
  `SOFT_DELETABLE_MODELS`) was intentionally NOT added: it would contradict the deliberate
  `Consumable`-stays-out carve-out ratified in #325 / ADR-0032.

### Verification

`cd apps/api && bunx prisma generate && bunx tsc --noEmit` clean; `bunx jest src/consumables
src/consumable-categories src/prisma/soft-delete.extension.spec.ts src/common/deleted-filter.spec.ts`
→ 57/57 pass.
