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

## Resolution

**Status**: fixed
**Fixed in**: commits `1d9d523` (helper) · `b377c9d` (P2023→400 filter) · `978a2cf` (users path
params) · `827842d` / `96e046e` / `a902816` (query filters)
**Fixed by**: lazyit-remediator
**Date**: 2026-05-25

### Changes

Deterministic uuid validation at the request edge (the finding's primary recommendation), plus a
transversal Prisma net:

- `apps/api/src/common/parse-uuid-query.ts` (new): `parseUuidQuery(value, name)` validates an
  optional uuid query filter with `z.uuid()` (mirrors the inline `status` check) — `undefined`
  passes through, a well-formed uuid is returned, anything else is a 400.
- `apps/api/src/users/users.controller.ts`: `ParseUUIDPipe` on every `:id` route (`findOne`,
  `findAssignments`, `findAccessGrants`, `update`, `remove`) — a malformed `User.id` is rejected
  with 400 at the edge, before the service/DB. This also fronts `/users/:id/assignments` and
  `/users/:id/access-grants`.
- `articles.controller.ts` (`authorId`), `asset-assignments.controller.ts` (`userId`),
  `access-grants.controller.ts` (`userId`): each uuid query filter now goes through
  `parseUuidQuery`. (`assetId`/`applicationId` are cuid and don't cast-error — left as-is, per the
  finding.)
- `apps/api/src/common/prisma-exception.filter.ts`: maps Prisma `P2023` ("inconsistent column
  data") → 400 with a generic message (no column/value echoed). Transversal safety net for any
  uuid input not guarded at the edge, and for future uuid columns.

### Tests added

- `common/prisma-exception.filter.spec.ts` — P2023→400; P2002/P2003/P2025 mappings unchanged; an
  unmapped code still delegates to the base handler (500). Fails without the new P2023 case.
- `common/parse-uuid-query.spec.ts` — undefined passes; a valid uuid returns unchanged; a malformed
  value (and `""`) throws 400.
- `users/users.controller.spec.ts` — `GET /users/not-a-uuid` → 400 and the service is never called;
  a well-formed uuid reaches the service. Fails without ParseUUIDPipe (the request reaches the
  service and returns 200).

### Verification

`bun test src/` → 168 pass / 17 files (was 158 / 13). Typecheck `tsc -p tsconfig.build.json
--noEmit` clean. Because validation happens at the request edge, the fix does **not** depend on
confirming Prisma's exact error code; the P2023 mapping is an additional net.

### Residual risk

The edge guards are per-parameter (not a global query-DTO pipe), so a *new* uuid query filter added
later must call `parseUuidQuery` — otherwise the P2023 net catches it as a 400 fallback. The
finding's broader "adopt a query DTO for single-source validation of non-body input" is hardening,
not required to close this.
