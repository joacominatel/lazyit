---
title: "ADR-0036: Integer fields bounded to the Postgres int4 range in shared schemas"
tags: [adr, api, validation]
status: accepted
created: 2026-05-26
updated: 2026-05-26
deciders: [Joaquín Minatel]
---

# ADR-0036: Integer fields bounded to the Postgres int4 range in shared schemas

## Status

accepted — 2026-05-26. Fixes issue #15. Builds on [[0018-api-documentation-swagger]] (DTOs are
generated from the shared zod schemas via `nestjs-zod`) and the
[[shared-package|@lazyit/shared contract]].

## Context

zod v4's `z.number().int()` emits the **safe-integer** bounds in its generated JSON Schema:
`{ type: "integer", minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 }`. Two
problems followed for any integer field backed by a Prisma `Int` (PostgreSQL `int4`, range
±2_147_483_647):

1. **Swagger UI autofill.** "Try it out" fills the request body sample with the schema `maximum`,
   so an *optional* field a user left blank was sent as `9007199254740991`. Postgres rejected the
   write with **P2020 — "value out of range for type integer"**, surfaced as a generic **HTTP 500**.
2. **Latent 500.** Even a hand-typed value between the int4 max and 2^53-1 passed validation and
   crashed the DB write instead of returning a clean 400 — the validation boundary didn't match the
   column's real capacity.

The affected input fields were `order` (`/consumable-categories`, `/application-categories`,
`/article-categories`), `minStock` (`/consumables`) and `quantity` (`/consumables/:id/movements`) —
transversal across 5 entities / ~9 endpoints, so a per-field patch was the wrong shape.

## Considered options

1. **A shared `int4()` zod primitive** in `@lazyit/shared`, used for every `Int`-backed field: caps
   to the int4 range and carries an `example`. One definition, fixes both defects, becomes the
   convention going forward. *(chosen)*
2. **Per-field `.max(2147483647)` + `@ApiProperty({ example })`** at each call site: works but
   duplicates the bound across schemas (and splits it between zod and Swagger decorators), easy to
   forget on the next integer field.
3. **Swagger-only fix** (set an `example`/`default` so autofill is sane) without capping: hides the
   Swagger symptom but leaves the latent 500 for hand-typed/out-of-range values.

## Decision

- Add **`int4()`** (and `INT4_MIN` / `INT4_MAX`) to `@lazyit/shared`. It returns
  `z.number().int().min(INT4_MIN).max(INT4_MAX)`, accepts `{ min, max, example }` to narrow the
  range (never widen past int4), and attaches `example` via `.meta()` so the generated OpenAPI
  overrides Swagger's autofill with a sensible sample.
- **Use `int4()` for every field backed by a Postgres `Int` column** — never a bare
  `z.number().int()`. This covers request DTOs (where it prevents the 500) and the full-entity /
  response schemas (so the OpenAPI surface is uniformly correct). Examples chosen: `minStock` → 5,
  `order` → 0, `quantity` → 1.
- Out-of-range integers now fail in the global `ZodValidationPipe` → **clean 400**, never P2020.

## Consequences

- **Positive:** the int4 bound lives in one place; new integer fields inherit it by using `int4()`;
  Swagger no longer autofills `MAX_SAFE_INTEGER`; out-of-range input returns a clear validation error
  instead of a 500. No DB/runtime behavior change for valid values.
- **Scope:** coerced **query-param** integers (e.g. `AssetHistoryQuery.limit`/`before`) were left on
  `z.coerce.number().int()` — they are read-only filters (no write, no P2020) and `limit` is already
  capped at 100; revisit if a query int ever feeds a write.
- **Convention:** "a Prisma `Int` column maps to `int4()` in its shared schema" is now the rule;
  recorded in [[code-conventions]].

## References

- Issue #15 (Swagger MAX_SAFE_INTEGER overflow). Fields backed by `Int`: see
  `apps/api/prisma/schema.prisma`.
- [[0018-api-documentation-swagger]] · [[shared-package]] · [[0005-id-strategy]] (autoincrement ids
  are also `int4`).
