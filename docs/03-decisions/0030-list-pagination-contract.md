---
title: "ADR-0030: List endpoint pagination contract (offset; implementation deferred)"
tags: [adr, security, api]
status: accepted
created: 2026-05-25
updated: 2026-05-30
deciders: [Joaquín Minatel]
---

# ADR-0030: List endpoint pagination contract (offset; partially implemented)

## Status

accepted — 2026-05-25; **partially implemented 2026-05-30** (Round 1, backend). The contract was
decided 2026-05-25 with implementation deferred. It now lives in `@lazyit/shared`
(`schemas/pagination.ts`: `PageQuery`/`Page<T>` + `offsetOf`/`pageOf` helpers, default 50 / hard
max 200, over-max rejected with 400) and the three heaviest/most-sensitive lists are paginated:
**`GET /access-grants`**, **`GET /assets`** and **`GET /articles`** each gained a service
`findPage(...)` (`findMany`+`count` over one `where` in a `$transaction`). The remaining lists
(small reference tables + the inherently-scoped nested grant/assignment lists) stay unpaginated for
now. Raised by [[SEC-007-no-pagination-list-endpoints|SEC-007]]; the response shape lives alongside
[[0018-api-documentation-swagger]] and is consumed by the frontend data layer
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
  (`{ items, total, limit, offset }`). **Default page size 50, hard maximum 200** — a `limit` over
  the max is **rejected (400)**, never silently clamped.
- **Migration is incremental, highest-risk first.** Round 1 (2026-05-30) implemented the contract
  and paginated the three heaviest/most-sensitive lists — **`GET /access-grants`** (the most
  sensitive unbounded list — it can dump every user↔application grant), **`GET /assets`** (the
  heaviest) and **`GET /articles`** — each via a service `findPage(...)` that runs `findMany` +
  `count` over the same `where` in one `$transaction`. The remaining small reference lists and the
  inherently-scoped nested grant/assignment lists stay unpaginated for now; **new** list endpoints
  adopt the contract from the start.
- When implemented, it spans backend **and** frontend (TanStack Query, [[0020-frontend-data-layer]])
  → split into separate front/back subagents per the workflow, not done piecemeal.

## Consequences

- **Positive:** the pagination contract is decided, discoverable and now enforced on the three
  highest-risk lists; the heaviest payloads are also trimmed (lean `select`s: `GET /articles` drops
  the markdown `content`, `GET /assets` drops the `specs` blob + trims joins). New endpoints inherit
  a capped page size by default.
- **Residual (tracked):** the remaining (small / inherently-scoped) lists stay unbounded until
  migrated — [[SEC-007-no-pagination-list-endpoints|SEC-007]] remains **open** as bounded, accepted
  debt. Offset pagination's deep-page cost and insert-instability are accepted at this scale; revisit
  **cursor** (option 2) if a history table grows fast. Matching **partial `deletedAt` indexes** for
  the now-bounded hot lists are a Round 2 follow-up (no migration landed in Round 1).
- The hard max (200) caps the worst-case response size for any endpoint that adopts the contract.

## References

- [[SEC-007-no-pagination-list-endpoints|SEC-007]].
- [[0018-api-documentation-swagger]] (response DTOs / OpenAPI) · [[0020-frontend-data-layer]] ·
  [[0009-bun-first-vs-app-stack]] (stack).
