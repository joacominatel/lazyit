---
id: SEC-041
title: Soft-deleting a category / model / location leaves live children pointing at an invisible parent (no in-use guard, SetNull never fires)
severity: low
status: open
cwe: CWE-1284
discovered: 2026-06-06
module: asset-categories / asset-models / locations
tags: [soft-delete-bypass, data-integrity, dangling-reference, fk-integrity, divergence]
---

# SEC-041 — Soft-delete leaves dangling references to an invisible parent

## Summary

Soft-deleting an `AssetCategory`, `AssetModel` or `Location` neither refuses the delete nor detaches
its children: live `AssetModel.categoryId` / `Asset.modelId` / `Asset.locationId` keep referencing a
row that is now invisible to every read, because the schema's `SetNull` detachment only fires on a
(never-issued) hard delete.

## Description

The schema documents two different referential-integrity intents for these parents:

- `AssetModel.categoryId` / `Asset.modelId` / `Asset.locationId` are `onDelete: SetNull` — *"deleting
  a Model/Location detaches assets, never deletes them"* (`schema.prisma:341-375`). The intent is
  that removing the parent **nulls the child's FK**.
- The article pillar takes the stricter path: `ArticleCategory.remove()` refuses with **409** when
  live articles still reference the category (`article-categories.service.ts:50-64`), precisely
  because *"`onDelete: Restrict` is only a hard-delete safety net (our delete is an UPDATE, so it
  never fires), which is why this guard is application logic."*

Neither intent is realized for the three modules in scope. Their `remove()` is a bare soft-delete
with **no in-use guard and no FK reconciliation**:

- `asset-categories.service.ts:38-44` — `remove()` just stamps `deletedAt`.
- `asset-models.service.ts:136-142` — same.
- `locations.service.ts:116-125` — same.

Because soft delete is an `UPDATE deletedAt = now()` (not a SQL `DELETE`), the DB-level `SetNull`
never triggers, so the documented "detaches assets" behavior **does not happen**. The result is a
dangling reference: the child still holds the parent's id, but:

- `GET /<parent>/:id` 404s and the parent is gone from its list — yet
- the child still carries the id, the asset reads still resolve and **return the deleted parent's
  data** (see SEC-040), and
- filters still match it: `GET /assets?locationId=<deleted>`, `GET /assets?categoryId=<deleted>`
  (category-via-model) and `GET /asset-models?categoryId=<deleted>` all still return the children of
  a parent the API otherwise pretends no longer exists.

A symmetric create-time gap exists: `create()` / `update()` apply no liveness check on the FK, and a
soft-deleted parent row still satisfies the DB FK, so a caller with `assetModel:write` can attach a
new/edited model to an **already soft-deleted** category (and likewise an asset to a soft-deleted
model/location). The FK only rejects a parent that never existed (P2003 → 400); it cannot tell a
soft-deleted parent from a live one.

This is a divergence from the module's own documented contract (SetNull-detach) and an inconsistency
with the established article-category in-use guard precedent — not a deliberately accepted debt
(deferred.md records no such acceptance for these three).

## Impact

Data-integrity / state-consistency, exploitable by a legitimate caller:

- A MEMBER (or service account) with `*:write` can create children referencing a soft-deleted parent.
- An ADMIN deleting a parent silently leaves children in a half-deleted, inconsistent state instead
  of the documented detach, so the inventory's referential view diverges from what the taxonomy
  endpoints report.
- It is the root cause behind SEC-040 (the dangling FK is what lets the soft-deleted parent leak
  through the asset include).

No privilege escalation and no secret exposure — the affected data is org-internal reference data and
parent deletion needs the `:delete` permission (ADMIN by seed) — so intrinsic severity is **Low**.
But it is a real soft-delete-bypass-class consistency hole that the article pillar already guards
against. Reasoned from code; the API was not run.

## Proof of concept

Reasoned, not executed.

```sh
# --- delete-time: children left dangling ---
# L is a live location referenced by asset A
curl -X DELETE -H "X-User-Id: <admin-uuid>" :3001/locations/<L>     # 200, soft-deleted
curl        -H "X-User-Id: <admin-uuid>" :3001/locations/<L>        # 404 (gone)
curl        -H "X-User-Id: <viewer-uuid>" ":3001/assets?locationId=<L>"
#   -> still returns A, whose locationId is still <L> (detach never happened)

# --- create-time: attach to a soft-deleted parent ---
# C is a soft-deleted asset-category
curl -X POST -H "X-User-Id: <member-uuid>" -H 'content-type: application/json' \
     -d '{"name":"X","manufacturer":"Y","categoryId":"<C>"}' :3001/asset-models
#   -> 201; the model now references an invisible category (FK passes, no liveness check)
```

## Affected

- `apps/api/src/asset-categories/asset-categories.service.ts:38-44` — `remove()` (no in-use guard).
- `apps/api/src/asset-models/asset-models.service.ts:136-142` — `remove()` (no in-use guard);
  `:112-133` `create()`/`update()` (no `categoryId` liveness check).
- `apps/api/src/locations/locations.service.ts:116-125` — `remove()` (no in-use guard).
- `apps/api/prisma/schema.prisma:341-375` — the `SetNull` FKs whose detach only fires on hard delete.
- Contrast: `apps/api/src/article-categories/article-categories.service.ts:50-64` — the in-use guard
  precedent.

## Recommendation

Decide the intended semantics per parent and implement it in the service (a CEO/ADR call where the
two options differ — escalate if unsure):

1. **Detach on delete (matches the documented `SetNull` intent).** Inside `remove()`, in one
   `$transaction`, null the children's FK before/with the soft-delete:
   - location: `asset.updateMany({ where: { locationId: id }, data: { locationId: null } })`
   - model: `asset.updateMany({ where: { modelId: id }, data: { modelId: null } })`
   - category: `assetModel.updateMany({ where: { categoryId: id }, data: { categoryId: null } })`
   This realizes the schema's stated behavior and also closes SEC-040 (no dangling ref to leak). Note
   the asset detach should likely emit a `LOCATION_CHANGED` / `MODEL_CHANGED` `AssetHistory` event for
   auditability (ADR-0033).
2. **In-use guard (matches the article-category precedent).** Refuse with **409** when live children
   still reference the parent, forcing the caller to reassign first. Simpler, but contradicts the
   `SetNull` comment, so update the schema comment if this path is chosen.

Additionally, add a create/update liveness check on the FK (the `assertCategoryUsable` /
`assertUserUsable` pattern already used elsewhere) so a child cannot be attached to a soft-deleted
parent: a `findFirst({ where: { id } })` that returns `null` (the read filter hides soft-deleted) →
`400 "not a live <parent>"`.

## Prevention

- Make "what happens to children when a soft-deletable parent is deleted, and can a child be attached
  to a soft-deleted parent?" a required question for every FK to a soft-deletable model — capture it
  in `code-conventions` / an ADR amendment so new modules don't silently inherit the bare-soft-delete
  default.
- Regression tests per module: (a) deleting a parent with live children behaves per the chosen
  semantics (detached, or 409); (b) creating/updating a child against a soft-deleted parent → 400.

## References

- CWE-1284 (Improper Validation of Specified Quantity in Input) / CWE-459 (Incomplete Cleanup)
- ADR-0006 (soft delete & auditing), ADR-0032 (soft-delete middleware — SetNull/Restrict only fire on
  hard delete), ADR-0041 (soft-delete reuse/restore)
- Precedent: `article-categories.service.ts` `remove()` in-use guard (ADR-0021/0019)
- Related: SEC-040 (the soft-deleted parent leaking through the asset include — same root cause)
