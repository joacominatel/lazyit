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
