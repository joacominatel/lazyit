---
id: SEC-030
title: Asset create/update accept a soft-deleted modelId/locationId (no liveness guard)
severity: low
status: open
cwe: CWE-672
discovered: 2026-06-06
module: assets
tags: [soft-delete-bypass, data-integrity, fk]
---

# SEC-030 — Asset create/update accept a soft-deleted modelId/locationId (no liveness guard)

## Summary

`POST /assets` and `PATCH /assets/:id` write `modelId` / `locationId` straight to the row with no
check that the referenced `AssetModel` / `Location` is still live, so an asset can be attached to a
soft-deleted (archived) parent.

## Description

The soft-delete read filter (`deletedAt: null`, ADR-0032) hides archived rows on *reads*, but a
soft delete is an `UPDATE` — the row still physically exists, so its FK target is still valid at the
DB level. `AssetsService.create`/`update` never read the model/location before persisting the FK;
they pass `modelId`/`locationId` directly to Prisma (`assets.service.ts:214-238`, `:244-278`). The
FK constraints are `onDelete: SetNull` (`schema.prisma:371-375`), which only governs *hard* delete —
they do nothing for soft delete. Result: a caller with `asset:write` can point a (new or existing)
asset at an `AssetModel`/`Location` whose `deletedAt` is set.

This is the asymmetry the sentinel skill notes ("articles guard category via `assertCategoryUsable`;
assets do not guard model/location"). The sibling lifecycle join **does** guard its parents:
`AssetAssignmentsService.assertAssetUsable` / `assertUserUsable` reject a soft-deleted asset/user
with 400 (`asset-assignments.service.ts:221-247`), and `AccessGrantsService` does the same for
application/user. The asset write path is the one place in the inventory pillar that skips the
equivalent live-parent check. It is **not** recorded as accepted debt in `deferred.md` or an ADR.

On the read side this also surfaces: the detail/list `include` of `model`/`location`
(`assets.service.ts:50-58`, `:82-90`) is not soft-delete filtered (relation includes bypass the
extension), so an asset bound to an archived model/location returns that archived parent inline.

## Impact

Integrity, not confidentiality: an asset can reference an archived model/location, so inventory
reporting and search projection carry a "live asset → dead parent" edge that the archive was meant
to retire. No privilege escalation and no data exposure beyond the already-authorized asset graph.
Rated Low: it needs `asset:write` (ADMIN/MEMBER), the damage is a stale reference, and the API is the
dev-only unauthenticated posture (DEF-001/0016). The value is consistency with the rest of the pillar
and not silently resurrecting an archived parent into a live graph.

## Proof of concept

Reasoned from code, **not executed** (the API is not run during review).

```sh
# 1. archive a location
curl -X DELETE -H "X-User-Id: <admin-uuid>" :3001/locations/<locId>

# 2. a live asset can still be created pointing at the archived location → 201 (no 400)
curl -X POST -H "X-User-Id: <admin-uuid>" -H 'Content-Type: application/json' \
  -d '{"name":"laptop-1","status":"OPERATIONAL","locationId":"<locId>"}' :3001/assets

# same for an existing asset:
curl -X PATCH -H "X-User-Id: <admin-uuid>" -H 'Content-Type: application/json' \
  -d '{"modelId":"<archivedModelId>"}' :3001/assets/<assetId>
```

The create/update succeed because nothing reads the parent's `deletedAt`; the FK only sees that the
row exists.

## Affected

- `apps/api/src/assets/assets.service.ts:214-238` — `create`: writes `modelId`/`locationId` with no live-parent check.
- `apps/api/src/assets/assets.service.ts:244-278` — `update`: same, on the patch path.
- `apps/api/src/assets/assets.service.ts:50-58`, `:82-90` — relation includes return archived model/location.
- `apps/api/prisma/schema.prisma:371-375` — `modelId`/`locationId` FKs are `SetNull` (governs hard delete only).
- Contrast (the guard that exists elsewhere): `apps/api/src/asset-assignments/asset-assignments.service.ts:221-247`.

## Recommendation

Add the symmetric guard to the asset write path, mirroring `assertAssetUsable`: before create/update,
when `modelId`/`locationId` is present, `findFirst` the parent (which the extension scopes to
`deletedAt: null`) and 400 if it is missing/archived — e.g. `assertModelUsable(modelId)` /
`assertLocationUsable(locationId)`. If the product *intends* to allow attaching archived parents
(unlikely, given the rest of the pillar guards them), record that decision in `deferred.md` with the
ADR reference instead, so the asymmetry is documented rather than incidental.

## Prevention

A single shared `assertLiveRef(model, id)` helper used by every service that writes an FK to a
soft-deletable parent (assets, assignments, grants, articles already converge on this shape), plus a
test asserting "write referencing a soft-deleted parent → 400". Codifies the live-parent rule as one
pattern instead of per-module memory.

## References

- CWE-672: Operation on a Resource after Expiration or Release.
- ADR-0006 (soft delete & auditing), ADR-0032 (soft-delete read filter), ADR-0004 (asset-centric), ADR-0007 (specs).
- Sentinel skill §1 "Soft-delete bypass" (the FK-to-soft-deleted-parent class).
