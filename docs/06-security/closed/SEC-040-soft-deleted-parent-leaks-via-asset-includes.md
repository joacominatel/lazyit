---
id: SEC-040
title: Soft-deleted location / model / category leaks back to readers through the asset relation includes
severity: low
status: fixed
cwe: CWE-200
discovered: 2026-06-06
module: asset-categories / asset-models / locations (integration with assets)
tags: [soft-delete-bypass, info-leak, idor-adjacent, integration]
---

# SEC-040 — Soft-deleted parent leaks back through the asset includes

## Summary

A soft-deleted `Location`, `AssetModel` or `AssetCategory` disappears from its own list/detail
endpoints but is still returned in full to any `asset:read` caller through the asset detail/list
relation includes, because the soft-delete read filter does not apply to nested relations.

## Description

Soft-delete filtering is centralized in a Prisma `$extends` query extension (ADR-0032). That ADR
states plainly in its Consequences: *"Nested relation reads are not filtered: query extensions only
intercept top-level operations, so a soft-deletable relation loaded via `include`/`select` is not
auto-scoped … revisit if an `include` must hide soft-deleted relations."* When the ADR was written
no read relied on nested filtering. That is no longer true: the asset reads eagerly include exactly
these three soft-deletable parents.

- `GET /assets/:id` includes `model: { include: { category: true } }` and `location: true`
  (`ASSET_RELATIONS`, `assets.service.ts:50-58`).
- `GET /assets` (the lean list) selects `model { … category { id, name } }` and
  `location { id, name, type }` (`ASSET_LIST_SELECT`, `assets.service.ts:68-110`).

Soft-deleting a parent is an `UPDATE` that stamps `deletedAt`; the child `Asset.locationId /
modelId` (and `AssetModel.categoryId`) is untouched (the FK `SetNull` only fires on a hard delete,
which never happens — see SEC-041). So the asset still points at the now-invisible row, and the
nested `include`/`select` happily resolves it and returns its `name` / `type` / etc. The dedicated
endpoints (`GET /locations/:id`, `GET /asset-models/:id`, `GET /asset-categories/:id`) correctly
404 the same row, and the list endpoints correctly omit it — only the asset include leaks it.

This is a soft-delete read-filter bypass: an ADMIN soft-deletes a location/model/category expecting
it to vanish from the app, but its data keeps surfacing to every reader (including a VIEWER) via any
asset that still references it.

## Impact

Any authenticated `asset:read` principal (VIEWER, MEMBER, ADMIN, or a granted service account) can
read the data of a soft-deleted location / model / category that the soft-delete filter is meant to
hide. The leaked fields are org-internal reference/taxonomy data (a location name + type, a model
name/manufacturer, a category name), not secrets, and the actor cannot reach them directly — only
through an asset that still references the deleted parent. That keeps intrinsic severity **Low**, but
it defeats the stated purpose of soft delete ("the row is hidden from reads") for these three
entities and is a cross-module consistency hole, not the intended behavior. Reasoned from code; the
API was not run.

## Proof of concept

Reasoned, not executed.

```sh
# given an asset A whose location is L (well-formed, live)
# 1) ADMIN soft-deletes the location
curl -X DELETE -H "X-User-Id: <admin-uuid>" :3001/locations/<L>

# 2) L is now hidden from its own endpoint…
curl -H "X-User-Id: <admin-uuid>" :3001/locations/<L>          # 404
curl -H "X-User-Id: <admin-uuid>" ":3001/locations"            # L absent

# 3) …but a plain reader still gets L's full data through the asset include
curl -H "X-User-Id: <viewer-uuid>" :3001/assets/<A>
#   -> { ..., "location": { "id": "<L>", "name": "Secret DC", "type": "DATACENTER", ... } }
# same leak for model (+ its category) on /assets and /assets/:id
```

## Affected

- `apps/api/src/assets/assets.service.ts:50-58` — `ASSET_RELATIONS` eager-loads `model.category`
  and `location` with no `deletedAt` scoping on the nested reads.
- `apps/api/src/assets/assets.service.ts:68-110` — `ASSET_LIST_SELECT` does the same for the list.
- `apps/api/src/prisma/soft-delete.extension.ts` — the extension only rewrites top-level ops
  (ADR-0032), so nested includes are unfiltered by design.
- Parents that leak: `apps/api/src/locations/locations.service.ts`,
  `apps/api/src/asset-models/asset-models.service.ts`,
  `apps/api/src/asset-categories/asset-categories.service.ts`.

## Recommendation

Pick one (in rough order of preference):

1. **Filter the nested reads at the call site.** Add `where: { deletedAt: null }` to the
   soft-deletable relations in `ASSET_RELATIONS` / `ASSET_LIST_SELECT`
   (e.g. `location: { where: { deletedAt: null } }`, `model: { where: { deletedAt: null },
   include: { category: { where: { deletedAt: null } } } }`). A soft-deleted parent then resolves to
   `null` for the reader, matching its dedicated endpoint. This is the smallest, most local fix.
2. **Reconcile the child on parent delete** (see SEC-041): if soft-deleting a parent nulls the
   child's FK, the include returns `null` and there is nothing to leak. This also fixes the dangling
   reference, so SEC-040 and SEC-041 share a remedy.

Whichever is chosen, add a regression test: soft-delete a location/model/category, then assert the
referencing asset's detail/list read no longer carries the deleted parent's fields.

## Prevention

- Treat ADR-0032's nested-relation caveat as a standing checklist item: any new soft-deletable
  relation pulled in via `include`/`select` must carry an explicit `where: { deletedAt: null }`
  (or rely on parent-delete reconciliation). Record the convention in `code-conventions`.
- A lint/grep guard could flag an `include`/`select` of a `SOFT_DELETABLE_MODELS` relation that has
  no `where` clause.

## References

- CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor)
- ADR-0032 (soft-delete `$extends` middleware — "nested relation reads are not filtered" / "revisit
  if an include must hide soft-deleted relations")
- ADR-0006 (soft delete & auditing), ADR-0041 (soft-delete reuse/restore)
- Related: SEC-041 (no child reconciliation on parent soft-delete — shared root cause)

## Resolution

**Status**: fixed
**Fixed in**: commit `63a7eb0` (`fix: guard live model/location on write + filter nested soft-deleted includes (SEC-030, SEC-040)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/assets/assets.service.ts`: added an explicit `where: { deletedAt: null }` to the
  soft-deletable parents in both `ASSET_RELATIONS` (detail) and `ASSET_LIST_SELECT` (list) — `model`,
  `model.category`, and `location`. They are nullable to-one relations, and Prisma 7 supports a
  filtered to-one include/select (`Asset$modelArgs` carries `where`), so a soft-deleted parent now
  resolves to `null` for the reader instead of leaking its fields — matching what the parent's own
  dedicated endpoint returns. (Chosen over recommendation #2 because parent-delete reconciliation is
  the deferred SEC-041 design call.)

### Tests added
- `apps/api/src/assets/assets.service.spec.ts`: `EXPECTED_INCLUDE` and `EXPECTED_LIST_SELECT` now carry
  the nested `deletedAt: null` filters, so the existing `findOne`/`findPage` assertions fail unless the
  service requests the soft-delete-scoped relations.

### Verification
`bun test apps/api/src/assets/assets.service.spec.ts` → 50 pass / 0 fail. API type-check green
(confirms the filtered to-one include/select type-checks under Prisma 7).

### Residual risk
This filters the asset includes specifically. The general "nested relation reads are not auto-scoped"
footgun (ADR-0032's deferred caveat) still applies to any other `include`/`select`/relation-filter of
a soft-deletable model — see SEC-071 for the dashboard instance and the standing convention note. The
underlying dangling FK (root cause) is the still-open SEC-041.
