---
id: SEC-041
title: Soft-deleting a category / model / location leaves live children pointing at an invisible parent (no in-use guard, SetNull never fires)
severity: low
status: fixed
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

## Triage note (2026-10-15, after the 2026-10-10 audit remediation)

Still open; the delete-time half is unchanged. Re-checked on `dev` at `03d715e66`:
`asset-categories.service.ts:82-88`, `asset-models.service.ts:161-166` and the location `remove()` still
soft-delete without an in-use guard or a detach. The location case is AUD-024, which is a **pending CEO
decision** (refuse while in use, like KB folders, or detach). The Manual still says assets "become
location-less", which is not what happens; it is left alone until that decision.

What the remediation did change around it:
- The create-time half for assets was closed by SEC-030 (#1476); applications and consumables by
  SEC-052 (#1584). `AssetModel.categoryId` on a model write is still not checked against a live category.
- AUD-080 (PR #1581): restoring a location whose parent is archived is a 409 ("restore the parent
  first"), and the parent guard checks only that the parent itself is live.
- AUD-023 (PRs #1569, #1573, #1582) closed the KB folder analogue (folder remove and the article
  writes check emptiness and liveness under the folder lock). KB folders are outside this finding's three
  modules.

## Triage note (2026-10-16, after the audit decision round)

Still open at **Low**. The location part is fixed; the asset-category and asset-model parts are not.

**Done: locations** (AUD-024, CEO decision, PR #1603 `f70c3232f`; the web dialog in PR #1608 `323ec1aed`).
- `DELETE /locations/:id` no longer strands anything. While live assets, child locations or open
  purchases point at the location, the delete needs **one** resolution for all of them:
  `?strategy=detach` clears `asset.locationId` and makes the children top-level, and
  `?strategy=move&targetId=` re-points them to one live location that is neither the location itself
  nor one of its descendants.
- Without a strategy the API answers **409** `DELETE_RESOLUTION_REQUIRED` with the counts.
  `GET /locations/:id/delete-impact` previews what is affected.
- The resolution and the soft delete run in one transaction under the location-tree lock
  (`apps/api/src/locations/locations.service.ts:246-293`). Each affected asset gets a `LOCATION_CHANGED`
  history row.
- Received or closed purchases and consumable deliveries keep their reference as history.
- Restoring the location later re-links nothing.
- Application and consumable categories got the same rule (AUD-085). They are outside this finding's
  three modules.
- Tests: `apps/api/src/locations/locations.service.spec.ts:734` (`refuses (409) to delete a location still
  in use when no strategy is given, with the counts`) and `:823` (move re-points the assets and open
  purchases and re-parents the children).

**Remaining (open)**, re-checked on `dev` at `cab67672f`:
- `asset-categories.service.ts:82-88` still soft-deletes with no in-use guard and no detach.
  `AssetModel.categoryId` keeps pointing at the archived category.
- `asset-models.service.ts:161-166` does the same. `Asset.modelId` keeps pointing at the archived model.
- A model write still does not check `categoryId` against a live category (`:132`, FK only).
- The web keeps the direct delete for asset categories, because the API has no resolution for them.
- Closing these needs the same product call per parent (one resolution, or a refusal). The delete-resolution
  contract in `packages/shared` (`DeleteResolutionSchema`) is the natural pattern to extend.

## Resolution

**Status**: fixed
**Fixed in**: the location part by PR #1603 (`f70c3232f`, AUD-024) with the web dialog in PR #1608
(`323ec1aed`); the asset-category and asset-model parts by PR #1620 — commits `f78777c0f`
(`fix(api): delete an asset category in use with one resolution (SEC-041)`), `b6f36addd` (the asset model,
and the live-category check on model writes) and `e04187db1` (the AI archive tools). The web dialog for
asset categories and models follows in a separate unit.
**Fixed by**: SEC-041 remediation (CEO decision on the delete-with-one-resolution pattern; "3. ok" for
asset categories and models, 2026-10-16)
**Date**: 2026-10-16

### Evidence (on `fix/sec-041-asset-category-model-delete`)
- `apps/api/src/asset-categories/asset-categories.service.ts:145-189` (`remove`):
  - locks the category and the move target `FOR UPDATE` in id order, then the live models `FOR NO KEY
    UPDATE` in id order;
  - while live models are filed under it, a delete without a resolution is a 409
    `DELETE_RESOLUTION_REQUIRED` with `{ assetModels, assets }`;
  - `detach` clears `categoryId`, and `move` re-points it to a live category that is not this one (400
    otherwise), in the soft delete's transaction.

  `:107-143` (`deleteImpact`) counts the models and their live assets, and lists each kind only for a
  reader.
- `apps/api/src/asset-models/asset-models.service.ts:230-289` (`remove`), with a 30 s transaction timeout:
  - locks, in order: both models and the live assets `FOR UPDATE`; the purchases of the mapped lines
    `FOR SHARE` in id order (purchase before line, like every purchase write); then the open lines
    `FOR UPDATE OF l` (`:371-387`: live lines of a live `DRAFT`/`ORDERED` purchase that still expect units);
  - without a resolution while any exist, it is the same 409 with `{ assets, purchaseOrderLines }`;
  - `:331-368` re-points or detaches them, writes one `MODEL_CHANGED` history row per asset in a single
    insert, and one `LINE_UPDATED` event per line.
- `:165-195` and `:390-403` (`assertCategoryLive`): a model create, or an update that changes `categoryId`,
  is a 400 when the category is missing or archived. An update that keeps a legacy archived category is
  accepted.
- `:298-327` (`restore`): restoring a model whose category is archived is a 409 ("restore the category
  first"), checked under a `FOR SHARE` lock on the category.
- The controllers expose `GET /asset-categories/:id/delete-impact` and `GET /asset-models/:id/delete-impact`,
  and parse `?strategy=` / `?targetId=` with the shared `parseDeleteResolution`. `category_archive` and
  `asset_model_archive` take `strategy` / `moveTo`.
- Restoring a category or model re-links nothing.

### Tests
- `apps/api/src/asset-categories/asset-categories.service.spec.ts`:
  - `:231`: the 409 with the model and asset counts, and the id-ordered model lock;
  - `:253` (detach) and `:267` (move);
  - also covered: the target refusals, the shared transaction and the permission-gated impact.
- `apps/api/src/asset-models/asset-models.service.spec.ts`:
  - `:338`: the 409 with the counts;
  - `:355`: detach, with the `MODEL_CHANGED` rows and the `LINE_UPDATED` event;
  - `:401`: a move into a model of another category;
  - `:448`: the model, asset and line locks, and the open-status filter;
  - `:483`: the purchases are locked after the assets and before the lines;
  - `:508`: the transaction is opened with the 30 s timeout option. It runs 3,000 mocked assets through
    one update and one history insert, but no database, so it does not measure the time;
  - `:211` and `:220`: an archived category is refused on create and update;
  - `:576`–`:605`: the restore refusal under an archived category, and the restores that go through.
- The controller specs cover the query parsing. `apps/api/src/ai/tools/taxonomy.tools.spec.ts` covers the
  tool previews, the refusals, the open lines shown as distinct purchases, and the route parity.

### Verification
Run on the branch on 2026-10-16, after merging `dev` at `044ed55d3`: `node node_modules/.bin/jest` in
`apps/api` passed 326 suites and 7539 tests.

### Residual risk
- **Rows archived before the fix** keep their dangling references, and nothing is backfilled. Deleting a
  restored parent again goes through the resolution. The read-side leak through nested includes is
  [[SEC-040-soft-deleted-parent-leaks-via-asset-includes|SEC-040]], which stays open.
- **Parent checks are plain reads.** A model write checks the category with a plain read, not under
  `FOR SHARE`, like the other parent liveness checks. A write racing a concurrent category delete can
  still land on the archived category.
- **A receipt in progress during a model delete.** Each received unit is its own transaction. A unit
  whose insert is waiting on the model row (its foreign key's `KEY SHARE` against the delete's
  `FOR UPDATE`) succeeds once the delete commits. That one unit lands on the archived model, and the
  remaining units fail the live-model check. The second and third points are the same class, tracked
  in #1604.
