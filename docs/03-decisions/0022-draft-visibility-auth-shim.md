---
title: "ADR-0022: Draft visibility & the X-User-Id auth shim"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-30
deciders: [Joaquín Minatel]
---

# ADR-0022: Draft visibility & the X-User-Id auth shim

## Status

accepted — 2026-05-25, **temporary**. Stands on [[0016-auth-strategy-deferred]] (no real auth
yet) and is scoped to the Knowledge Base ([[0021-knowledge-base-design]]). **To be revisited when
auth lands** — when [[0016-auth-strategy-deferred]] is resolved, this ADR is reviewed.

> [!note] Shim path preserved; superseded in the OIDC path by [[0038-jit-user-provisioning]]
> Auth has since landed ([[0016-auth-strategy-deferred]] is superseded). In **OIDC mode** the
> actor is the OIDC-authenticated caller (`sub`→[[user]]) resolved by the global guard, not the
> `X-User-Id` header; the **draft-visibility authorization rules below are unchanged** — only the
> source of "who is calling" moved to a verified token. The `X-User-Id` header survives **only**
> under `AUTH_MODE=shim` (dev/test). See [[0038-jit-user-provisioning]] / [[0039-authjs-v5-frontend-oidc]].

> [!note] A THIRD authZ layer now stacks on top — KB folder access control ([[0060-kb-folder-access-control]])
> Draft visibility (here) and the `article:read` capability ([[0046-roles-permissions-v2]]) are no longer
> the whole story. [[0060-kb-folder-access-control]] adds a **folder ACL** as a third authorization layer
> for the KB, and the three **compose most-restrictive-wins**: an article is reachable only if the caller
> clears the `article:read` capability **and** can see the article's home **Folder** **and** passes the
> draft rule below (a `DRAFT` stays author-only). The folder layer deliberately **reuses the 404-not-403
> existence-hiding pattern** decided here: an article hidden by folder access returns **404, never 403**,
> exactly as a non-author's `DRAFT` does — the server never leaks the existence of an article you may not
> see. The UI padlock + tooltip is presentation only; the gate is enforced API-first + DB-first (INV-9 in
> [[INVARIANTS]]). **No-escalation** rides along: you can never alias/share an article you cannot yourself
> access. None of the draft-visibility *rules* below change — folder access is an additional, orthogonal
> filter that runs alongside them.

## Context

KB articles need authorship rules: a `DRAFT` is private to its author, and **only the author** may
edit, delete, publish or unpublish an article. But real authentication is **deferred**
([[0016-auth-strategy-deferred]]) — the API is currently unauthenticated, so the server has no
trustworthy "who is calling". We still want to build and unit-test the authorization logic now, so
that when auth arrives it slots in **without rewriting the KB**.

## Considered options

- **Wait for real auth** — can't express draft privacy at all until the IdP lands; blocks the
  whole module. ❌
- **Add an interim guard / JWT now** — re-introduces the auth we explicitly deferred
  ([[0016-auth-strategy-deferred]]); throwaway work. ❌
- **A header shim (`X-User-Id`) resolved inside the service** — the caller passes a `User.id`; the
  service treats it as `currentUser`. ✅ *(chosen)*

## Decision

- **`X-User-Id` header** carries a `User.id` and simulates the caller:
  - present + valid (an existing, non-soft-deleted user) → that is `currentUser`;
  - absent → **anonymous** (sees only `PUBLISHED`);
  - present but invalid → **`400`**.
- **Authorization lives in the service**, not in a guard/middleware:
  - **Read** (`GET` list / `:id` / `by-slug`): `PUBLISHED` is visible to everyone; a `DRAFT` is
    visible **only to its author**. A `DRAFT` requested by a non-author returns **`404`** — never
    `403`, so we don't leak the existence of someone's draft.
  - **Write** (`POST` / `PATCH` / `DELETE` / `publish` / `unpublish`): require `X-User-Id` (else
    **`400`**). On create, `authorId = currentUser` — **never** taken from the body (can't be
    forged). For an existing article, **only the author** may modify it: a non-author hitting a
    *published* article gets **`403`** (they can read it but not change it); a *draft* gets
    **`404`** (consistent with read visibility).
- **Swagger** documents `X-User-Id` as an **optional** header on reads and a **required** header on
  writes ([[0018-api-documentation-swagger]]).

## Consequences

- **Positive:** the full authorization model is implemented and unit-tested **now**. When auth
  lands, a middleware/decorator fills `currentUser` from the JWT `sub` (mapped via
  `User.externalId`) and **the service logic is unchanged** — only the *source* of `currentUser`
  moves from a header to the token.
- **Negative / security (important):** there is **no real enforcement** — anyone can send any
  `X-User-Id`. These endpoints are **insecure until auth lands**; acceptable only under the
  dev-only posture of [[0016-auth-strategy-deferred]], and they **must not be exposed publicly**.
- **Temporary by construction:** the shim is replaced when the IdP integration arrives; the
  authorization *rules* (draft privacy, author-only writes, `404`-vs-`403`) survive that change.

Related: [[0016-auth-strategy-deferred]] · [[0021-knowledge-base-design]] · [[article]] ·
[[user]] · [[0018-api-documentation-swagger]] · [[0046-roles-permissions-v2]] ·
[[0060-kb-folder-access-control]] · [[INVARIANTS]]
