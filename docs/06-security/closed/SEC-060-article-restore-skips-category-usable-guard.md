---
id: SEC-060
title: Article restore skips assertCategoryUsable — an article can be resurrected into a soft-deleted category
severity: low
status: fixed
cwe: CWE-863
discovered: 2026-06-06
module: articles
tags: [soft-delete, integrity, authz, restore]
---

# SEC-060 — Article restore resurrects an article into a soft-deleted category

## Summary

`restore()` clears `deletedAt` without re-running `assertCategoryUsable`, so a soft-deleted article
whose category was deleted in the meantime comes back live while pointing at a soft-deleted category
— a state `create`/`update` actively forbid.

## Description

Every other article write that touches `categoryId` guards against a soft-deleted parent:
`create()` and `update()` call `assertCategoryUsable`, which does a soft-delete-filtered `findFirst`
and 400s if the category isn't live (`articles.service.ts:853-864`). `restore()` does not
(`articles.service.ts:435-457`) — it loads the row with `includeSoftDeleted`, checks authorship, and
flips `deletedAt: null`. No category check.

The window is reachable because category deletion only counts **live** articles:
`ArticleCategoriesService.remove()` runs `article.count({ where: { categoryId: id } })`
(`article-categories.service.ts:52-59`), and the soft-delete extension scopes that `count` to
`deletedAt: null` (`soft-delete.extension.ts:35-67`). A soft-deleted article is invisible to the
count, so the category deletes cleanly. Restoring the article then re-links it to a soft-deleted
category — the exact `assertCategoryUsable` invariant the create/update paths uphold (and the one the
sentinel skill calls out: "an entity can reference a soft-deleted parent unless the service guards
it; articles guard category via `assertCategoryUsable`").

Sequence (all DB-valid because soft delete is an `UPDATE`, so the FK row still exists):

1. Article `A` is created/owned in category `C`, then soft-deleted (`DELETE /articles/A`).
2. `DELETE /article-categories/C` succeeds — `A` is soft-deleted, so the live-article count is 0.
3. `POST /articles/A/restore` — `A` comes back live, still `categoryId = C` (now soft-deleted).

## Impact

Data/visibility integrity, not confidentiality or availability. A restored article references a
category that no read path will return (`assertCategoryUsable`, the category list and `findOne` all
filter `deletedAt: null`), so the KB ends up with a live article in a "ghost" category — broken
category navigation/grouping and a downstream frontend that can't resolve the category. Both ends
(`DELETE` and `restore`) are `article:delete` / `category:delete` (ADMIN-only by seed) **and**
author-gated, so this is an operator-triggerable consistency bug, not a privilege issue — hence Low.

## Proof of concept

Reasoned from the code, **not executed** (the API is not run during review). With `AUTH_MODE=shim`
and an admin who authored the article:

```sh
# 1. article A lives in category C, then soft-delete it
curl -X DELETE http://localhost:3001/articles/<A> -H 'X-User-Id: <admin-uuid>'
# 2. delete C — succeeds, A is soft-deleted so the live-article count is 0
curl -X DELETE http://localhost:3001/article-categories/<C> -H 'X-User-Id: <admin-uuid>'
# 3. restore A — no category check; A is live again pointing at the soft-deleted C
curl -X POST http://localhost:3001/articles/<A>/restore -H 'X-User-Id: <admin-uuid>'
# GET /articles/<A> now returns a live article whose categoryId is a soft-deleted category
```

## Affected

- `apps/api/src/articles/articles.service.ts:435-457` — `restore()` clears `deletedAt` with no
  `assertCategoryUsable` call (contrast `create()` `:336` and `update()` `:377`).
- `apps/api/src/article-categories/article-categories.service.ts:50-64` — `remove()` only counts
  live articles, so soft-deleted articles don't block category deletion.
- `apps/api/src/articles/articles.service.ts:853-864` — `assertCategoryUsable` (the guard that
  restore omits).

## Recommendation

In `restore()`, after confirming the row is restorable and before (or inside) the update, re-validate
the category the same way the write paths do:

```ts
if (article.deletedAt === null) return article; // idempotent
await this.assertCategoryUsable(article.categoryId); // 400 if the category is no longer live
```

Surfacing a 400 ("categoryId … does not reference a live category") is consistent with create/update
and tells the operator to restore/reassign the category first. (A category `restore` then makes the
article restorable again.)

## Prevention

Treat "soft-deletable parent must be live" as a single invariant exercised on **every** path that
makes a child live — create, update **and restore** — not just create/update. A regression test that
soft-deletes an article, deletes its category, then asserts `restore` 400s would lock this in. The
same shape applies to other restore paths that re-link to a soft-deletable parent (assets → model/
location, already weaker — see prior sweeps).

## References

- CWE-863: Incorrect Authorization (broken state invariant). CWE-459: Incomplete Cleanup.
- ADR-0006 (soft delete & auditing) · ADR-0032 (soft-delete middleware) · ADR-0041 (soft-delete reuse
  and restore) · ADR-0021 (KB design). `.claude/skills/lazyit-sentinel/SKILL.md` §1 (soft-delete
  bypass: reference to a soft-deleted parent).

## Resolution

**Status**: fixed
**Fixed in**: commit `5d2b746` (`fix: re-run assertCategoryUsable on article restore (SEC-060)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/articles/articles.service.ts`: `restore()` now calls `assertCategoryUsable(article.
  categoryId)` after the idempotent (`deletedAt === null`) short-circuit and before clearing
  `deletedAt` — the same guard `create`/`update` run. A restore onto a now-soft-deleted category 400s
  instead of resurrecting a live article into a ghost category. (`categoryId` is required on Article,
  so no null check is needed.)

### Tests added
- `apps/api/src/articles/articles.service.spec.ts` › "restore": 400 when the category is now
  soft-deleted (article.update NOT called); restores when the category is live (asserts the guard
  read); idempotent no-op (no guard, no update) when already live. Fails without the fix.

### Verification
`bun test apps/api/src/articles/articles.service.spec.ts` → 77 pass / 0 fail.

### Residual risk
None. The operator path to surface this (delete article → delete its now-childless category → restore
article) now ends in a 400 telling them to restore/reassign the category first.
