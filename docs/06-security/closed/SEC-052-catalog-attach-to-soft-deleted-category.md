---
id: SEC-052
title: Applications & Consumables can be created/updated with a categoryId pointing at a soft-deleted category (soft-delete FK bypass)
severity: low
status: fixed
cwe: CWE-1284
discovered: 2026-06-06
module: applications
tags: [soft-delete-bypass, fk-integrity, defense-in-depth, validation]
---

# SEC-052 — Catalog write accepts a soft-deleted category as `categoryId`

## Summary

`POST/PATCH /applications` and `POST/PATCH /consumables` accept any `categoryId` whose row physically
exists, including a SOFT-DELETED category. The FK constraint only checks row existence (it does not
know about `deletedAt`), and the services never validate the parent is live — so a freshly-created
application/consumable can be born attached to an archived category.

## Description

`Application.categoryId` / `Consumable.categoryId` are optional FKs with `onDelete: SetNull`
(`schema.prisma:727-728`, `:827-828`). On write, the services pass `categoryId` straight to Prisma
(`applications.service.ts:106-119` / `consumables.service.ts:145-147` and the update paths). The only
backstop is the DB FK, mapped to a 400 when the id doesn't exist at all (P2003). A soft-deleted
category row still exists, so the FK is satisfied and the write succeeds — the new/edited row now
references a category that every read path treats as deleted.

This is the FK-vs-soft-delete gap the sentinel SKILL calls out: "FKs are DB constraints that don't
know about soft delete … articles guard category via `assertCategoryUsable`; assets do not guard
model/location." Applications and consumables are in the unguarded group — there is no
`assertCategoryUsable`-style live-parent check before the write.

Note this is independent of SEC-050: even with correct soft-delete read filtering, nothing validates
the supplied `categoryId` against a live parent. (For consumables the two compound — SEC-050 means the
category isn't even read-filtered — but the missing write-time check is the issue here.)

## Impact

Data-integrity / soft-delete bypass: an entity can reference a logically-deleted parent, producing a
dangling category link the UI can't resolve (or that silently re-surfaces an archived grouping). No
direct confidentiality/availability impact and `SetNull` keeps it from orphaning a required relation,
so this is **Low / defense-in-depth** — but it contradicts the soft-delete contract (a deleted row
should be unreferenceable going forward) and is the same class as the article-category guard that DOES
exist elsewhere, so the inconsistency is worth closing.

## Proof of concept

Reasoned, **not executed**:

```sh
# archive a category as ADMIN
curl -X DELETE http://localhost:3001/application-categories/$CAT -H 'X-User-Id: <admin-uuid>'

# create an application attached to the now-archived category — succeeds (should 400/404):
curl -X POST http://localhost:3001/applications -H 'content-type: application/json' \
  -H 'X-User-Id: <member-uuid>' -d "{\"name\":\"X\",\"categoryId\":\"$CAT\"}"   # 201, dangling link

# same for consumables:
curl -X POST http://localhost:3001/consumables -H 'content-type: application/json' \
  -H 'X-User-Id: <member-uuid>' -d "{\"name\":\"Cable\",\"categoryId\":\"$CAT\"}" # 201
```

## Affected

- `apps/api/src/applications/applications.service.ts:106-135` — `create`/`update` pass `categoryId`
  with no live-parent check.
- `apps/api/src/consumables/consumables.service.ts:145-153` — same.
- `apps/api/prisma/schema.prisma:727-728`, `:827-828` — optional FK, `SetNull`, no soft-delete
  awareness.
- Contrast `apps/api/src/articles/*` `assertCategoryUsable` (the guarded pattern).

## Recommendation

Before create/update, when `categoryId` is supplied, assert the category is LIVE (a `findFirst` with
the soft-delete filter, or an explicit `deletedAt: null`) and 400/404 otherwise — mirror the article
`assertCategoryUsable` pattern for application/consumable categories. Cheap and consistent.

## Prevention

Make "validate every supplied FK points at a LIVE parent" a standard step for writes that accept a
parent id, not an article-only special case. A shared `assertParentUsable(model, id)` helper +
review rule would cover applications, consumables, assets (model/location) uniformly.

## References

- CWE-1284: Improper Validation of Specified Quantity in Input (here: an FK to a logically-deleted
  parent) · CWE-20.
- ADR-0006 (soft delete) · ADR-0023 (application category SetNull) · ADR-0034 (consumable category
  SetNull) · sentinel SKILL §1 (soft-delete / FK note).

## Resolution

**Status**: fixed
**Fixed in**: commits `330c64b` (consumables) and `d6dc782` (`fix: assert live category on application
create/update (SEC-052)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/applications/applications.service.ts`: added a private `assertCategoryUsable` (mirrors
  the articles guard); `create`/`update` call it when `categoryId` is supplied. A soft-deleted
  `ApplicationCategory` resolves to `null` under the read filter → `400 "categoryId … does not
  reference a live category"`.
- `apps/api/src/consumables/consumables.service.ts`: same `assertCategoryUsable` against
  `ConsumableCategory`, wired into `create`/`update`. (`create` is now `async`.)

### Tests added
- `apps/api/src/applications/applications.service.spec.ts`: create/update 400 on a soft-deleted
  category; create attaches to a live one (asserts the `findFirst({ where:{id}, select:{id:true} })`).
- `apps/api/src/consumables/consumables.service.spec.ts`: the same three cases for consumables.
  All fail without the guard (the write went straight to Prisma and the FK accepted the soft-deleted
  row).

### Verification
`bun test` on both service specs → green (19 + 49 pass). API type-check green.

### Residual risk
The asset-model → category attach variant noted in SEC-041 is NOT covered here (it lives in
`asset-models.service.ts`, outside this change's lane) and remains tracked under the still-open
SEC-041. The delete-side reconciliation (what happens to children when a category is soft-deleted) is
the separate SEC-041 ADR question.
