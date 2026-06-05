---
id: SEC-007
title: No pagination on any list endpoint — unbounded result sets
severity: low
status: open
cwe: CWE-770
discovered: 2026-05-25
module: transversal
tags: [dos, pagination, resource-exhaustion, architectural]
---

# SEC-007 — List endpoints return entire tables (no pagination)

## Summary

Every `findAll` returns all non-deleted rows with no `take`/`skip`/cursor. An unauthenticated caller
can pull whole tables; as data grows this is a memory/bandwidth cliff. Architectural — one issue, not
one per module.

## Description

None of the list services bound their result set:

- `users.service.ts:10` · `locations.service.ts:10` · `asset-categories.service.ts:10` ·
  `asset-models.service.ts:11` · `assets.service.ts:18` · `asset-assignments.service.ts:25` ·
  `articles.service.ts:69` · `article-categories.service.ts:17` · `applications.service.ts:11` ·
  `application-categories.service.ts:13` · `access-grants.service.ts:42`

Each is `findMany({ where: { deletedAt: null }, orderBy: … })` with no limit. Filters narrow some, but
`GET /users`, `GET /assets`, `GET /articles`, `GET /asset-assignments` can each return the full table.
The only mitigation today is scale (a 5–20-person tool has few rows) — which does not hold for articles,
assignment history, or assets over time.

> **Partial remediation (incremental, [[0030-list-pagination-contract|ADR-0030]]):** `GET /access-grants`,
> `/assets`, `/articles`, `/applications`, `/consumables`, `/users`, `/locations` are now paginated
> (`Page<T>` + capped page size); **`GET /asset-models` joined them under issue #199** (ADR-0030 §8 —
> now `findPage` with server-side `q`/sort/pagination). The remaining small reference / nested-scoped
> lists (`asset-categories`, `article-categories`, `application-categories`, `asset-assignments`) stay
> bounded-by-scale debt until migrated.

## Impact

Low today (small data, dev-only). Grows with data: large JSON serialization and DB load per request,
and an easy amplification vector once exposed. Append-only tables (assignments) only grow.

## Proof of concept

Reasoned, **not executed**: `curl http://localhost:3001/articles` returns every visible article in one
response; there is no way to request a page.

## Affected

- All eleven `findAll` implementations listed above (transversal). `GET /access-grants` is the most
  sensitive unbounded list — it can dump every user↔application grant in one request.

## Recommendation

Introduce one pagination convention at the list layer — `take` + cursor (or `skip`) with a sane default
and a hard maximum (e.g. default 50, max 200) — plus a shared response shape (items + nextCursor/total).
Define the contract once in `@lazyit/shared` so web and api agree. Worth an ADR: it touches every list
endpoint and the response schema.

## Prevention

Make "list endpoints must paginate with a capped page size" a review rule; add page params to the
shared query schema so it is enforced by default for new modules.

## References

- CWE-770: Allocation of Resources Without Limits or Throttling.
- ADR-0018 (response DTOs / OpenAPI — the pagination shape would live here) · ADR-0020 (frontend data layer).

## Triage note

🚨 Escalated to user on 2026-05-25 — architectural: a new ADR + a shared response shape + touching
all 11 `findAll`s. Pagination is a cross-cutting contract decision (offset vs cursor, default/max
page size, response envelope `items` + `nextCursor`/`total`) defined once in `@lazyit/shared` and
adopted by web and api together — not a bounded guardrail, and it spans backend + frontend (per the
workflow it should be split into front/back subagents, not done piecemeal here).

Options:

1. **Cursor-based** (id/`createdAt` cursor) — scales best for the growing/append-only tables
   (assignments, articles), stable under inserts; richer client contract.
2. **Offset/limit** (`skip`/`take`) — simplest, familiar, fine at MVP scale; degrades on deep pages.
3. **Defer** — keep unbounded for the 5–20-person MVP and revisit when a table grows (document the
   residual).

Recommendation: define a shared `PageQuery` / `Page<T>` shape with a capped default (e.g. default 50,
max 200) as an ADR; offset (2) is the pragmatic MVP choice, cursor (1) if the history tables will
grow fast. If done incrementally, prioritize `GET /access-grants` (the most sensitive unbounded list).

## Decision (2026-05-25)

User chose **(1) offset contract via a new ADR, but defer the implementation**. Done in this pass:
**[[0030-list-pagination-contract|ADR-0030]]** defines the offset `PageQuery` / `Page<T>` shape in
`@lazyit/shared` (default 50, max 200). The 11 `findAll`s are **not** retrofitted now (MVP scale
doesn't require it); new list endpoints adopt the contract, existing ones migrate when a list grows —
prioritizing `GET /access-grants`. **SEC-007 stays open** as tracked, accepted, deferred debt under
ADR-0030 (the cross-cutting + frontend implementation should be split into front/back subagents).
