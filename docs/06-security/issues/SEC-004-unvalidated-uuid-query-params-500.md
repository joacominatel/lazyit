---
id: SEC-004
title: Unvalidated UUID query params reach Postgres and surface as unhandled 500s
severity: low
status: open
cwe: CWE-20
discovered: 2026-05-25
module: transversal
tags: [input-validation, error-handling, info-leak, dos]
---

# SEC-004 — Malformed UUID query params cause unhandled 500s

## Summary

List endpoints that filter by a `uuid` column take the value straight from an unvalidated `@Query`
string. A malformed UUID reaches Postgres' uuid cast and throws a Prisma error code the global filter
doesn't map, so the response is a 500 instead of a clean 400.

## Description

The global `ZodValidationPipe` only validates `@Body()` params typed as a `createZodDto`; raw
`@Query`/`@Param` strings are not validated. Two list filters feed user strings into `uuid`-typed
columns:

```ts
// articles: GET /articles?authorId=...
if (filters.authorId) and.push({ authorId: filters.authorId });   // articles.service.ts:59  (authorId @db.Uuid)
// assignments: GET /asset-assignments?userId=...
...(userId ? { userId } : {})                                     // asset-assignments.service.ts:29 (userId @db.Uuid)
```

For a non-UUID value Postgres raises `22P02 invalid input syntax for type uuid`, surfaced by Prisma as
a code (`P2023` / a validation error) **outside** the set the filter maps (`P2002`/`P2003`/`P2025`,
`prisma-exception.filter.ts:28`). It falls through to Nest's default handler → **500**. (`status` is
the counter-example done right: the controller `safeParse`s it and returns 400 —
`articles.controller.ts:88`, `assets.controller.ts:59`.)

## Impact

Low. An attacker can reliably force 500s on these endpoints (log noise, monitoring alarms, a probing
signal that a column is uuid-typed). No stack trace is leaked — Nest's default filter returns a generic
500 body — so disclosure is limited to "this filter is uuid-typed".

## Proof of concept

Reasoned, **not executed**:

```sh
curl -i 'http://localhost:3001/asset-assignments?userId=not-a-uuid'   # gets 500, should be 400
curl -i 'http://localhost:3001/articles?authorId=not-a-uuid'          # gets 500, should be 400
```

## Affected

- `apps/api/src/articles/articles.controller.ts:83` + `articles.service.ts:59` (`authorId`).
- `apps/api/src/asset-assignments/asset-assignments.controller.ts:47` + `asset-assignments.service.ts:29` (`userId`).
- `apps/api/src/common/prisma-exception.filter.ts:28-48` — `P2023` not mapped.

## Recommendation

- Validate query params before use, the way `status` already is — e.g. `z.uuid().safeParse(authorId)`
  → 400 on failure; same for `userId`. (cuid filters like `categoryId` don't trigger a cast error, so
  they're lower priority but deserve the same treatment for consistency.)
- And/or broaden `PrismaExceptionFilter` to map `P2023` / validation errors to 400 as a safety net.

## Prevention

Adopt a small query-DTO / parse step for list endpoints (a `createZodDto` for the query object, or
per-param `safeParse`) so query input gets the same single-source-of-truth validation as bodies.

## References

- CWE-20: Improper Input Validation. CWE-755: Improper Handling of Exceptional Conditions.
- ADR-0018 (global pipe / exception filter) · ADR-0005 (uuid vs cuid).
