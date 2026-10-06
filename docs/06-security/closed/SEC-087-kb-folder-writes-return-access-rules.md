---
id: SEC-087
title: KB folder writes return the raw accessRules, so any category:write or category:delete holder reads a folder's access rules by writing to it
severity: medium
status: closed
cwe: CWE-213
discovered: 2026-10-05
module: article-categories
tags: [info-leak, authz, serialization, kb, folder-access]
---

# SEC-087 — KB folder writes return the raw `accessRules`

## Summary

`create`, `update`, `remove`, `restore` and `setAccessRules` in `ArticleCategoriesService` return the
Prisma row with no `select`, so the folder's `accessRules` jsonb reaches the caller of every folder
write, MEMBER included.

## Description

ADR-0060 §3 and INV-9 gate a folder's `accessRules` to `settings:manage`, the same gate that writes them
(#554). The read path enforces it: `findAll` and `findOne` select through `CATEGORY_PUBLIC_SELECT` and add
the column only for a `settings:manage` caller.

The write path does not. The API has no runtime response serializer (`ApiOkResponse` is Swagger metadata
only), and the five write methods return `prisma.articleCategory.{create,update}` / `findFirst` without a
`select`. Nest serializes the whole row, `accessRules` included. `restore` also leaks on its idempotent
branch, which returns the unselected `findFirst` row of an already-live folder.

| Route | Gate | Who reaches it by default |
| --- | --- | --- |
| `POST /article-categories` | `category:write` | ADMIN, MEMBER |
| `PATCH /article-categories/:id` | `category:write` | ADMIN, MEMBER |
| `DELETE /article-categories/:id` (non-cascade) | `category:delete` | ADMIN |
| `POST /article-categories/:id/restore` | `category:delete` | ADMIN |
| `PUT /article-categories/:id/access-rules` | `settings:manage` | ADMIN |

`create` returns a fresh row whose `accessRules` is always null, so it discloses nothing today; it is in
scope because it has the same shape. The AI `kb_folder_create` / `kb_folder_rename` tools call the same
routes but project the row through `folderSummary` (id, name, parent, `updatedAt`), so the model never saw
the rules.

## Impact

A MEMBER, or a service account granted `category:write`, reads the full access rule of any live folder it
can address by id by renaming it, or by sending a `PATCH` that rewrites a field with its current value. The
rules are the closed ADR-0060 §3 vocabulary: `users` (user UUIDs), `role`, `appGrant` (application id) and
`assetAssignment` (asset id). This discloses who may read a restricted folder, which is
authorization-management data, not the folder's articles. Folder ids are visible to every `category:read`
caller through `GET /article-categories`, so no guessing is needed. A `category:delete` holder could do
the same through restore, but that permission is ADMIN by default and ADMIN already holds
`settings:manage`.

**Medium**: exploitable with a default MEMBER role and a single request, but the disclosure is the access
list, not restricted content, and a write is needed, which leaves the folder's `updatedAt` changed.

## Proof of concept

Executed at the service level (Jest under Node, Prisma mocked to answer like Prisma: projected to `select`
when one is passed, the whole row otherwise), not over HTTP. Before the fix:

```
ArticleCategoriesService › write responses never carry accessRules (#1301) › update returns the folder without accessRules
expect(received).not.toHaveProperty(path)
Expected path: not "accessRules"
```

The same assertion failed for create, remove, both restore branches and setAccessRules. Against a live
instance, with the id of a restricted folder from the list:

```sh
curl -s -X PATCH -H "Authorization: Bearer $MEMBER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"<current name>"}' https://lazyit.example/api/article-categories/<id> | jq .accessRules
```

## Affected

- `apps/api/src/article-categories/article-categories.service.ts` `create`, `update`, `remove`, `restore`,
  `setAccessRules` (at `origin/dev` aef4b812).
- **Released versions: v1.0.0 through v2.0.0 (current `master`).** The column arrived with `dbebe0fe`
  (#404, first tagged in v1.0.0). The #554 read gate (`9adec851`) did not cover the writes.

## Recommendation

Return `CATEGORY_PUBLIC_SELECT` from every write, including the `findFirst` used by `restore`. The web
does not read the write response body for `accessRules`: the rule editor invalidates the folder list
and re-reads it through the gated GET, so `setAccessRules` can drop the rules too.

## Prevention

- Every `articleCategory` write in the service selects through `CATEGORY_PUBLIC_SELECT`, and a spec block
  pins each write response to the public shape.
- The class (a `select`-less Prisma return on a write path, with no runtime serializer) is wider than this
  module. A response serializer is an approved follow-up, tracked separately from #1301.

## References

- CWE-213 (Exposure of Sensitive Information Due to Incompatible Policies), CWE-200. OWASP API3:2023
  (Broken Object Property Level Authorization).
- [[0060-kb-folder-access-control]] §3, [[INVARIANTS]] INV-9, [[folder]], [[article-category]], #554,
  #1301.

## Resolution

**Status**: fixed
**Fixed in**: commit `dfe925e6` (`fix(api): return the public folder shape from every KB folder write (#1301)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-10-05

### Changes
- `apps/api/src/article-categories/article-categories.service.ts`: `create`, `update`, `remove`,
  `restore` (the `findFirst` and the `update`) and `setAccessRules` select through
  `CATEGORY_PUBLIC_SELECT`. The response matches `ArticleCategorySchema`, which never listed
  `accessRules`.
- `apps/api/src/ai/tools/kb.tools.spec.ts` (`190fd397`): three exact-argument assertions on the folder
  `create` / `update` calls now match the arguments they check and allow the added `select`.

### Tests added
- `apps/api/src/article-categories/article-categories.service.spec.ts`::"write responses never carry
  accessRules (#1301)": create, update, remove, restore of a soft-deleted folder, restore of an
  already-live folder, and setAccessRules. Prisma is mocked to project to `select` like the real
  client and to return the whole row otherwise. All six fail without the fix (`accessRules` is in the
  returned object) and pass with it.

### Verification
With the original service restored over the fix, the spec reports `Tests: 6 failed, 32 passed`. With
the fix: the full API Jest run under Node passes (296 suites, 6630 tests); `tsc --noEmit` passes for
shared, api, web and agent; changed-files eslint in `apps/api` reports nothing.

### Residual risk
- The class remains elsewhere: the API has no runtime response serializer, so any `select`-less Prisma
  return on a write path ships every column. A response serializer is the approved follow-up, outside
  #1301.
- Released instances (v1.0.0 through v2.0.0) disclose the rules on folder writes until they upgrade. No
  data change is needed; the rules themselves were never modified by this path.
