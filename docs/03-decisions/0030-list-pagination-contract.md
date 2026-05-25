---
title: "ADR-0030: List endpoint pagination contract (offset; implementation deferred)"
tags: [adr, security, api]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0030: List endpoint pagination contract (offset; implementation deferred)

## Status

accepted — 2026-05-25. The **contract** is decided now; **implementation is deferred**. Raised by
[[SEC-007-no-pagination-list-endpoints|SEC-007]]; the response shape would live alongside
[[0018-api-documentation-swagger]] and be consumed by the frontend data layer
([[0020-frontend-data-layer]]).

## Context

No list endpoint paginates (SEC-007): every `findAll` returns all non-soft-deleted rows with no
`take`/`skip`/cursor. At the current MVP scale (a 5–20-person team) this is invisible, but it is an
unbounded-response/DB-load cliff as data grows — `articles`, the append-only `asset_assignments` /
`access_grants` history, and `assets` over time. We want to **fix the contract now** (so new
endpoints follow one convention and nobody re-litigates it) **without** the large refactor of all
eleven lists plus the frontend data layer today.

## Considered options

1. **Offset / limit** (`skip` / `take`): simplest and familiar; degrades on deep pages and is
   slightly unstable under concurrent inserts. *(chosen)*
2. **Cursor-based** (id / `createdAt` cursor): scales best for the growing/append-only tables and is
   stable under inserts; richer client contract and more code.
3. **Defer entirely** — make no decision and keep lists unbounded.

## Decision

- Adopt an **offset/limit** contract, defined **once in `@lazyit/shared`**: a `PageQuery`
  (`{ limit, offset }`, or `{ page, limit }`) and a `Page<T>` envelope
  (`{ items, total, limit, offset }`). **Default page size 50, hard maximum 200.**
- **Implementation is deferred.** Existing lists are **not** retrofitted now — MVP scale does not
  require it, and the change spans every list service + the frontend data layer. **New** list
  endpoints should adopt the contract from the start; existing ones are migrated when a list grows or
  a screen needs it. When migration starts, prioritize **`GET /access-grants`** (the most sensitive
  unbounded list — it can dump every user↔application grant).
- When implemented, it spans backend **and** frontend (TanStack Query, [[0020-frontend-data-layer]])
  → split into separate front/back subagents per the workflow, not done piecemeal.

## Consequences

- **Positive:** the pagination contract is decided and discoverable; no premature eleven-endpoint
  refactor; new endpoints inherit a capped page size by default.
- **Residual (tracked):** existing lists stay unbounded until migrated — [[SEC-007-no-pagination-list-endpoints|SEC-007]]
  remains **open** as deferred, accepted debt, bounded today only by data scale. Offset pagination's
  deep-page cost and insert-instability are accepted at this scale; revisit **cursor** (option 2) if a
  history table grows fast.
- The hard max (200) caps the worst-case response size for any endpoint that adopts the contract.

## References

- [[SEC-007-no-pagination-list-endpoints|SEC-007]].
- [[0018-api-documentation-swagger]] (response DTOs / OpenAPI) · [[0020-frontend-data-layer]] ·
  [[0009-bun-first-vs-app-stack]] (stack).
