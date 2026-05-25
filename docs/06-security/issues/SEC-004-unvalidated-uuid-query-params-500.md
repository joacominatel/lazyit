---
id: SEC-004
title: Unvalidated UUID inputs (query and path params) reach Postgres and surface as unhandled 500s
severity: low
status: open
cwe: CWE-20
discovered: 2026-05-25
module: transversal
tags: [input-validation, error-handling, info-leak, dos]
---

# SEC-004 — Malformed UUID inputs cause unhandled 500s

## Summary

Any unvalidated user input that reaches a `uuid`-typed column — list filters **and** `User.id` path
params — hits Postgres' uuid cast on a malformed value and throws a Prisma error code the global filter
doesn't map, so the response is a 500 instead of a clean 400/404.

## Description

The global `ZodValidationPipe` only validates `@Body()` params typed as a `createZodDto`; raw
`@Query`/`@Param` strings are **not** validated. Two input shapes reach `uuid` columns unvalidated:

**Query filters** on `uuid` columns:

```ts
if (filters.authorId) and.push({ authorId: filters.authorId });   // articles.service.ts:59   (authorId @db.Uuid)
...(userId ? { userId } : {})                                     // asset-assignments.service.ts:29 (userId @db.Uuid)
...(userId ? { userId } : {})                                     // access-grants.service.ts:49      (userId @db.Uuid)
```

**Path params** on `User.id` routes — `:id` flows straight into `findFirst({ where: { id } })` on the
`uuid` PK:

```ts
findFirst({ where: { id, deletedAt: null } })   // users.service.ts:19  — GET/PATCH/DELETE /users/:id
```

This also fronts the nested routes (`/users/:id/assignments`, `/users/:id/access-grants`), which call
`users.findOne(id)` first. So even `GET /users/not-a-uuid` 500s. For a non-UUID value Postgres raises
`22P02 invalid input syntax for type uuid`, surfaced by Prisma as a code (`P2023` / a validation error)
**outside** the set the filter maps (`P2002`/`P2003`/`P2025`, `prisma-exception.filter.ts:28`) → it
falls through to Nest's default handler → **500**. (`status` is the counter-example done right: the
controller `safeParse`s it and returns 400 — `articles.controller.ts:88`, `assets.controller.ts:59`.)
cuid columns/params (`/assets/:id`, `/articles/:id`, `categoryId`) don't cast, so they 404 cleanly —
only `uuid` (User) inputs are affected.

## Impact

Low. A caller can reliably force 500s on any `User.id` route or uuid filter (`GET /users/x`) — log
noise, monitoring alarms, a probing signal that a column is uuid-typed. No stack trace is leaked (Nest's
default filter returns a generic 500 body), so disclosure is limited to "this input is uuid-typed".

## Proof of concept

Reasoned, **not executed**:

```sh
curl -i 'http://localhost:3001/users/not-a-uuid'                      # gets 500, should be 404
curl -i 'http://localhost:3001/asset-assignments?userId=not-a-uuid'   # gets 500, should be 400
curl -i 'http://localhost:3001/access-grants?userId=not-a-uuid'       # gets 500, should be 400
curl -i 'http://localhost:3001/articles?authorId=not-a-uuid'          # gets 500, should be 400
```

## Affected

- Path params (uuid PK): `apps/api/src/users/users.service.ts:18-26` (`findOne`), fronting all
  `/users/:id`, `/users/:id/assignments`, `/users/:id/access-grants` routes.
- Query filters (uuid): `articles.service.ts:59` (`authorId`), `asset-assignments.service.ts:29`
  (`userId`), `access-grants.service.ts:49` (`userId`).
- `apps/api/src/common/prisma-exception.filter.ts:28-48` — `P2023` not mapped.

## Recommendation

- Validate uuid inputs before use, the way `status` already is — `z.uuid().safeParse(value)` → 400 on
  failure for query filters; for `User.id` path params, parse the `:id` (a `ParseUUIDPipe` or a
  `z.uuid()` check) → 404/400 instead of 500. (cuid params don't cast-error, so they're lower priority.)
- And/or broaden `PrismaExceptionFilter` to map `P2023` / validation errors to 400 as a safety net.

## Prevention

Adopt a small query/param parse step for endpoints (a `createZodDto` for query objects, `ParseUUIDPipe`
for uuid path params) so non-body input gets the same single-source-of-truth validation as bodies.

## References

- CWE-20: Improper Input Validation. CWE-755: Improper Handling of Exceptional Conditions.
- ADR-0018 (global pipe / exception filter) · ADR-0005 (uuid vs cuid).
