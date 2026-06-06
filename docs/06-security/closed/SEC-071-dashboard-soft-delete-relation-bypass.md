---
id: SEC-071
title: Dashboard counts include grants/history tied to soft-deleted entities (nested-relation soft-delete bypass)
severity: low
status: fixed
cwe: CWE-840
discovered: 2026-06-06
module: dashboard
tags: [soft-delete, info-integrity, info-leak, adr-divergence]
---

# SEC-071 — Dashboard aggregates count rows linked to soft-deleted entities, contradicting the code's own comment

## Summary

The soft-delete Prisma extension only filters **top-level** reads (ADR-0032), never nested relation
filters or `include`/`select`. `DashboardService.getSummary` relies on a *relation* filter for
`onCriticalApps` and a top-level read on the append-only `AssetHistory` for `recentActivity`, so it
counts/returns rows tied to **soft-deleted** applications and assets — and its inline comment wrongly
claims the soft-deleted app is excluded.

## Description

ADR-0032 is explicit: "Nested relation reads are not filtered: query extensions only intercept
top-level operations, so a soft-deletable relation loaded via `include`/`select` is not auto-scoped …
revisit if an `include` must hide soft-deleted relations." `withSoftDeleteFilter` only injects
`deletedAt: null` when the *operation's own model* is in `SOFT_DELETABLE_MODELS`
(`soft-delete.extension.ts:59-67`); a relation predicate inside `where` is left untouched.

`getSummary` has two reads that depend on that and get it wrong:

1. **`onCriticalApps`** (`dashboard.service.ts:86-88`):

```ts
this.prisma.accessGrant.count({
  where: { revokedAt: null, application: { is: { isCritical: true } } },
});
// comment (l.84-85): "the related Application is auto-soft-delete-filtered, so grants whose app is
// soft-deleted are excluded."  <-- FALSE: AccessGrant is the top-level model (not soft-deletable),
// and the nested `application` relation filter is NOT scoped to deletedAt: null.
```

`applications.remove()` is a **soft delete only** — `data: { deletedAt: new Date() }`
(`applications.service.ts:142-147`); it does **not** revoke the application's grants. So after an app
is decommissioned (soft-deleted) with live grants, those grants keep `revokedAt: null` and are still
counted by `onCriticalApps` — and equally by `activeGrants` (`:77`) and `expiringSoon` (`:78-83`),
which have no application-liveness predicate at all.

2. **`recentActivity`** (`dashboard.service.ts:111-122`): `assetHistory.findMany` is a top-level read
   on `AssetHistory`, which is append-only (NOT in `SOFT_DELETABLE_MODELS`). It returns the latest 10
   events with their `payload`/`performedById` regardless of whether the parent `Asset` is
   soft-deleted — so a decommissioned asset's history (incl. its jsonb `payload`) still surfaces on the
   summary.

(The separate `getActivity` feed reads the `recent_activity` SQL view, which *does* drop rows whose
parent is soft-deleted — that path is fine. The gap is `getSummary` only.)

## Impact

Low. The endpoint is gated (`dashboard:read`), so this is not an anonymous exposure: it is (a) an
**integrity** bug — the access pillar over-reports active/critical/expiring grants on apps that were
decommissioned, so a "0 critical-app grants" expectation after offboarding an app is silently wrong —
and (b) a **minor info-leak** of soft-deleted assets' recent-history `payload` to any dashboard reader.
No row from a *deleted* primary entity is exposed (those top-level reads are filtered); the leak is
confined to lifecycle-join counts and append-only history rows that reference a soft-deleted parent.
The real risk this finding flags is the **divergence from ADR-0032** (the code assumes nested filtering
that does not happen) — and that the same nested-relation gap is relied on more widely (see Prevention).

## Proof of concept

Reasoned from the code, **not executed**. Sequence:

```sh
# 1. create a critical application, grant a user access to it (revokedAt stays null)
# 2. soft-delete the application:   DELETE /applications/:id   -> sets deletedAt, grant NOT revoked
# 3. read the dashboard:            GET /dashboard/summary
#    -> access.onCriticalApps still counts the grant on the soft-deleted app
#       (comment claims it is excluded); access.activeGrants / expiringSoon likewise.
# 4. soft-delete an asset that has AssetHistory rows, then GET /dashboard/summary
#    -> recentActivity still lists that asset's events + payload.
```

## Affected

- `apps/api/src/dashboard/dashboard.service.ts:84-88` — `onCriticalApps` + the incorrect comment.
- `apps/api/src/dashboard/dashboard.service.ts:77` / `:78-83` — `activeGrants` / `expiringSoon` (no app-liveness predicate).
- `apps/api/src/dashboard/dashboard.service.ts:111-122` — `recentActivity` over append-only `AssetHistory`.
- `apps/api/src/prisma/soft-delete.extension.ts:50-68` — top-level-only filtering (the root cause).
- `apps/api/src/applications/applications.service.ts:142-147` — soft delete does not revoke grants.

## Recommendation

1. Fix the comment, then make the predicate explicit. Since the relation is not auto-scoped, add the
   liveness filter by hand on the grant counts that should exclude decommissioned apps:

```ts
// onCriticalApps
where: { revokedAt: null, application: { is: { isCritical: true, deletedAt: null } } }
// activeGrants / expiringSoon — decide product intent: if a grant on a soft-deleted app is "not
// active", add `application: { is: { deletedAt: null } }` to those where-clauses too.
```

2. For `recentActivity`, scope to live assets — e.g. filter `asset: { is: { deletedAt: null } }` on the
   `assetHistory.findMany` `where`, or (cleaner) source the summary's recent slice from the same
   `recent_activity` view `getActivity` uses, which already drops soft-deleted parents.

(Whether a soft-deleted app should auto-revoke its grants is a product/domain call — escalate to the
feature owner rather than changing delete semantics here.)

## Prevention

The nested-relation soft-delete gap is a **transversal footgun** beyond the dashboard: any
`include`/`select`/relation-filter on a soft-deletable model returns soft-deleted rows. It is already
exercised in feature code — e.g. `assets.service.ts` includes `model` / `location` / `assignments.user`
(AssetModel, Location, User — all soft-deletable), so an asset detail/list can surface a soft-deleted
location's or an offboarded user's data through the relation graph. Recommended class-level controls:

- A short doc/lint note ("the soft-delete extension does NOT scope nested relations — add
  `deletedAt: null` by hand on any `include`/`select`/relation-filter of a soft-deletable model"),
  tied to ADR-0032's "revisit" clause.
- Treat ADR-0032's deferred item as now-triggered: the dashboard (and the assets include) ARE cases
  where a relation should hide soft-deleted rows. Consider revisiting whether the extension should also
  rewrite nested reads, or standardize an explicit helper.

## References

- CWE-840: Business Logic Errors. CWE-200: Exposure of Sensitive Information (the history-payload slice).
- ADR-0032 (soft-delete extension — top-level only; "revisit if an include must hide soft-deleted
  relations") · ADR-0006 (soft delete) · ADR-0030/0050 (dashboard/activity).

## Resolution

**Status**: fixed
**Fixed in**: commit `a370d2e` (`fix: scope dashboard grant/history counts to live parents (SEC-071)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/dashboard/dashboard.service.ts`:
  - Corrected the false header/inline comments that claimed the related Application is
    auto-soft-delete-filtered; added an explicit note that relation predicates / includes are NOT
    scoped by the extension (ADR-0032), so the `deletedAt: null` filters below are load-bearing.
  - `onCriticalApps`: `application: { is: { isCritical: true, deletedAt: null } }`.
  - `activeGrants` and `expiringSoon`: added `application: { is: { deletedAt: null } }` so grants on a
    decommissioned (soft-deleted) app no longer count as active — the read-side over-count the finding
    flagged.
  - `recentActivity`: `assetHistory.findMany` now filters `where: { asset: { is: { deletedAt: null } } }`
    so a soft-deleted asset's history + jsonb payload don't surface on the summary.

### Tests added
- `apps/api/src/dashboard/dashboard.service.spec.ts`: onCriticalApps asserts `isCritical + deletedAt`;
  new cases assert activeGrants/expiringSoon carry the live-app filter and recentActivity scopes to
  live assets. Fail without the fix.

### Verification
`bun test apps/api/src/dashboard/dashboard.service.spec.ts` → 23 pass / 0 fail.

### Residual risk
This is the READ-side fix only. Whether `applications.remove()` should auto-revoke an app's grants on
soft-delete is a DELETE-side product/ADR call **left open under SEC-041** (do not change delete
semantics here). The same nested-relation footgun exists wherever else a soft-deletable model is pulled
via `include`/`select`/relation-filter — captured as the standing convention note for a future
ADR-0032 amendment.
