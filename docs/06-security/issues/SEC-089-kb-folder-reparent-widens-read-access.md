---
id: SEC-089
title: A category:write holder can re-parent or create a KB folder around a restricted ancestor and widen who reads it
severity: high
status: open
cwe: CWE-285
discovered: 2026-10-10
module: article-categories (KB folder access)
tags: [authz, kb, folder-access, inv-9, privilege-escalation, audit-gap]
---

# SEC-089 — A KB folder re-parent is an authorization write with no authorization gate

## Summary

`PATCH /article-categories/:id` accepts `parentId` under `category:write` alone. Because a folder's
visibility is inherited from every restricted ancestor, moving a folder out from under a restricted
parent makes its whole subtree readable to every `article:read` holder. No ACL check runs and no audit
row is written. MEMBER holds `category:write` by default.

## Description

[[0060-kb-folder-access-control]] §1 makes visibility inherit-and-narrow: a folder is visible only if
the caller matches the own rule of every restricted folder on its ancestor path. The walk is
`FolderAccessService.pathAllMatched` (`apps/api/src/article-categories/folder-access.service.ts:245-273`).
A child with no rule of its own is therefore protected only by its position in the tree.

Who may change a folder's audience is reserved to `settings:manage`: the access-rules route says "a
non-admin can author content in a folder but never re-scope WHO may read it"
(`article-categories.controller.ts:149-154`). The tree position is the other half of the same
boundary, and it is not guarded:

- `update` checks only that the folder exists, that the new parent is live, and that no cycle forms
  (`article-categories.service.ts:228-240`). It never consults `FolderAccessService` and writes no
  audit or history row. `parentId: null` (move to the root) passes with no check at all.
- The controller passes no principal (`article-categories.controller.ts:98-104`), and the
  `findOne(id)` pre-check runs without one, so the caller does not even need to be able to read the
  folder being moved.
- `create` with a `parentId` checks only that the parent is live (`article-categories.service.ts:212-220`),
  so a caller can also place a new folder under a restricted parent they cannot read.
- `GET /article-categories` lists every folder, with its `id`, `name` and `parentId`, to any
  `category:read` caller, VIEWER included (`article-categories.service.ts:101-133`; only
  `articleCount` is nulled for hidden folders). Targets are easy to find.
- MEMBER is seeded with every `:write` permission, `category:write` included
  (`packages/shared/src/schemas/permission.ts:365`, the `inventory.edit` capability at
  `permission-meta.ts:474-485`).

ADR-0060 §9 (#1296) already decided that moving an *article* between folders is an authorization
write: a blind destination is refused, a widening needs confirmation, and the move is recorded. The
folder-level move, which re-scopes many articles at once, has no equivalent.

## Impact

Confidentiality of restricted KB content (INV-9). Any MEMBER can expose every article in a restricted
subtree to every `article:read` holder through `/articles/:id`, `/search`, the reverse lookups and
attachment URLs. The reverse move hides a public folder under a restricted one, which removes it for
every reader who does not match the restriction. Neither move leaves a trace beyond the overwritten
row. Rated **High**: exploitable by a default MEMBER with no chain, against the one data-scoping
boundary the KB has.

## Proof of concept

Reasoned from code, **not executed** (the API is not run during review).

```sh
# "HR" is restricted to ADMIN; its child "HR/Salaries" has no rule of its own.
# 1. A MEMBER finds the folder id (the list returns every folder, hidden ones included).
curl -H "Authorization: Bearer $MEMBER" https://lazyit.example/api/article-categories
# 2. Move the child to the root. 200: only liveness and the cycle guard run.
curl -X PATCH -H "Authorization: Bearer $MEMBER" -H 'Content-Type: application/json' \
  -d '{"parentId": null}' https://lazyit.example/api/article-categories/<salaries-id>
# Every article in "Salaries" is now readable by every article:read holder.
```

## Affected

Verified on `dev` at `a4ca679ea`.

- `apps/api/src/article-categories/article-categories.service.ts:228-240` — `update` applies `parentId`
  after liveness and cycle checks only.
- `apps/api/src/article-categories/article-categories.service.ts:212-220` — `create` under any live parent.
- `apps/api/src/article-categories/article-categories.controller.ts:90-104` — create and update gated by
  `category:write`, no principal passed.
- `apps/api/src/article-categories/article-categories.controller.ts:149-154` — the stated rule that only
  `settings:manage` re-scopes a folder's readers.
- `apps/api/src/article-categories/folder-access.service.ts:245-273` — inherit-and-narrow, which makes
  the tree position part of the ACL.
- `packages/shared/src/schemas/article-category.ts:81` — `parentId: z.cuid().nullable()` on update.

## Recommendation

Treat a `parentId` change, and a create under a restricted parent, as an authorization write. This
changes ADR-0060, so it needs an amendment (a new §, beside §9). Two shapes, smallest first:

1. Require `settings:manage` for any `parentId` change and for a create whose effective audience
   differs from the root's. Simple and consistent with the access-rules route.
2. Or mirror §9: the caller must be able to read both the folder and the destination (a hidden one is
   the same 400 as a missing one), a move that widens the subtree's effective audience needs an
   explicit confirmation flag, and every move writes an audit row with the actor.

Either way, pass the principal into `update` and `create`, and resolve visibility through the existing
`FolderAccessService` evaluator rather than a second one. No data change: existing folders keep their
position.

## Prevention

- Extend INV-9 in [[INVARIANTS]]: any write that changes an article's or a folder's effective audience
  is an authorization write, gated and audited.
- A test that a MEMBER `PATCH {parentId}` out of a restricted ancestor, and a `POST` under one, is
  refused (or needs the confirmation), and that the move is recorded.

## References

- CWE-285 Improper Authorization; OWASP A01:2021 Broken Access Control.
- [[0060-kb-folder-access-control]] §1, §3, §9 · [[0059-kb-folders-links-and-import]] · [[INVARIANTS]] INV-9.
- Sweep: [[sweep-2026-10-10-backend-audit]] (AUD-001). Related: AUD-010 (the same unlocked move can
  race into a folder cycle).

## Triage note (2026-10-15, after the 2026-10-10 audit remediation)

Still open: AUD-001 is a **pending CEO decision** (the recommendation is to require `settings:manage` for
a re-parent or a create under a restricted ancestor, with an ADR-0060 amendment). PR #1569 changed the
code around it without changing who may move a folder: a move now checks and writes under the folder-tree
advisory lock (`article-categories.service.ts:239-241`, `:468-469`), which closed the AUD-010 cycle race.
That locked `update` transaction is where the authorization check would go.
