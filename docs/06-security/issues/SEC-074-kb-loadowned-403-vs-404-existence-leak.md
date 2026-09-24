---
id: SEC-074
title: KB write paths leak a folder-hidden article's existence — loadOwned returns 403 (not 404) to a non-author before the folder ACL check
severity: low
status: open
cwe: CWE-204
discovered: 2026-09-24
module: articles · ai (KB tools)
tags: [info-leak, existence-oracle, kb, folder-acl, adr-divergence]
---

# SEC-074 — `loadOwned` returns 403 before the folder check, so it works as an existence oracle for hidden articles

## Summary

On every KB write path, a non-author caller without `article:manage` gets **403 "Only the author can
modify this article"** for a PUBLISHED article in a folder they **cannot read**, and 404 for an id that
does not exist. The difference confirms a hidden article exists, which breaks the INV-9 rule "404, not
403".

## Description

`ArticlesService.loadOwned` (`articles.service.ts:1116-1145`) is the gate for `update`, `remove`,
`publish`, `unpublish`, `restoreVersion`, `addLink`/`removeLink`, `addAlias`/`removeAlias` and
`assertAttachmentWritable`. For a caller who is not the author and for whom `canManageAny` is false (a
MEMBER with `article:write` but no `article:manage`), it does this:

```ts
if (!canManageAny) {
  if (article.status === 'DRAFT') throw new NotFoundException(...);    // hidden: good
  throw new ForbiddenException('Only the author can modify this article'); // 403: leaks
}
await this.assertFolderVisible(article.categoryId, principal, () => { throw new NotFoundException(...) });
```

The folder ACL check (`assertFolderVisible`) runs **only** on the manage-bypass branch. The plain
non-author branch returns 403 for a PUBLISHED article whatever its folder, including a folder that the
read path (`findOne` and the rest) would 404 for the same caller. The draft rule was written to hide
existence ([[0022-draft-visibility-auth-shim]]). The folder rule ([[0060-kb-folder-access-control]] §4,
INV-9) needs the same treatment and does not get it here.

Reachable:

- over HTTP: `PATCH/DELETE /articles/:id`, `POST /articles/:id/publish|unpublish`,
  `POST /articles/:id/versions/:v/restore`, `POST|DELETE /articles/:id/links…`,
  `POST|DELETE /articles/:id/aliases…` (`articles.controller.ts:299-536`), plus article attachment
  writes (`attachments.service.ts:278` → `assertAttachmentWritable`);
- over MCP and chat once PR #1342 (`feat/issue-1315-ai-kb-tools`) lands: `kb_update_article` /
  `kb_set_publication` bind `ArticlesController.update`/`publish`, so the 403-vs-404 difference reaches a
  delegated MCP client (and the model) as a tool error.

`addLink`/`addAlias` do re-check the folder (`:744`, `:877`), but only **after** `loadOwned`, so the
403 has already been returned.

## Impact

Low. An authenticated `article:write` holder can confirm whether a given **article id (uuid)** exists
in a folder they are not allowed to see. The response carries no title, content or slug. Ids are
random uuids (ADR-0005), so the caller needs an id from somewhere else (a leaked link, a log line, an
old share), and cannot enumerate ids. No write happens, because 403 is still a denial. This is an
**INV-9 divergence** (existence hiding), not a data exposure.

## Proof of concept

Reasoned from the code, **not executed**.

```sh
# Caller: MEMBER (article:write, no article:manage), not in folder F's access rules.
# A = PUBLISHED article in restricted folder F, authored by someone else.
curl -X PATCH /api/articles/$A   -H "Authorization: Bearer <member>" -d '{"title":"x"}'  # -> 403 "Only the author can modify this article"
curl -X PATCH /api/articles/$RANDOM_UUID -H "Authorization: Bearer <member>" -d '{"title":"x"}'  # -> 404
curl        /api/articles/$A     -H "Authorization: Bearer <member>"                     # -> 404 (read path hides it)
```

## Affected

At `origin/dev` 84bd521d.

- `apps/api/src/articles/articles.service.ts:1132-1138`: the non-author branch returns 403 before any
  folder check.
- `apps/api/src/articles/articles.service.ts:1141-1143`: the folder check runs only on the manage-bypass
  branch.
- Callers: `articles.service.ts:394` (`assertAttachmentWritable`), `:454` (`update`), `:519` (`remove`),
  `:582` (`publish`), `:610` (`unpublish`), `:698` (`restoreVersion`), `:743` (`addLink`), `:769`
  (`removeLink`), `:871` (`addAlias`), `:899` (`removeAlias`).
- PR #1342 `apps/api/src/ai/tools/kb.tools.ts`: the MCP/chat vector (not yet on `dev`).

## Recommendation

In `loadOwned`, run the folder check **before** the authorship verdict for every non-author, so a
hidden article looks the same as a missing one:

```ts
if (article.authorId === currentUserId) return article;
// Not the author: hide what the caller can't READ first (draft rule + folder ACL), then decide 403.
if (!canManageAny && article.status === 'DRAFT') throw new NotFoundException(`Article ${id} not found`);
await this.assertFolderVisible(article.categoryId, principal, () => {
  throw new NotFoundException(`Article ${id} not found`);
});
if (!canManageAny) throw new ForbiddenException('Only the author can modify this article');
return article;
```

The fix adds one read-only check, with no schema change and no effect on existing data. A caller who can see the folder
still gets the same 403 as today.

## Prevention

- One rule for every KB entry point: **visibility before authorization**. A resource the caller cannot
  read gives 404 before any ownership or capability 403. A helper
  (`loadVisibleOrNotFound(id, principal)`) used by both the read and write paths makes that ordering
  structural.
- Add a spec in `articles.service.spec.ts`: a non-author MEMBER calling `update` / `publish` / `remove`
  on a PUBLISHED article in a hidden folder gets **404**, the same as a missing id.

## References

- CWE-204 (Observable Response Discrepancy), CWE-203.
- [[INVARIANTS]] INV-9 · [[0060-kb-folder-access-control]] §4 · [[0022-draft-visibility-auth-shim]] ·
  epic #1315, PR #1342.
