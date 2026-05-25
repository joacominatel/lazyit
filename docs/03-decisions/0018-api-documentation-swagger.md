---
title: "ADR-0018: API documentation with Swagger/OpenAPI (nestjs-zod)"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0018: API documentation with Swagger/OpenAPI (nestjs-zod)

## Status

accepted — **supersedes [[0013-zod-validation-pipe]]** (the custom `ZodValidationPipe` is
replaced by nestjs-zod's). This is the Swagger follow-up that ADR-0013 explicitly anticipated
("revisit `nestjs-zod` / `zod-to-openapi` if/when we adopt Swagger").

## Context

The API is growing ([[user]], [[location]], now the [[asset]] cluster). We need living API
documentation — for ourselves, for the frontend, and for future integrators. zod (in
`@lazyit/shared`) is already the **single source of truth** for validation and types
([[shared-package]], [[0013-zod-validation-pipe]]). We want OpenAPI generated **from those same
zod schemas**, never a parallel set of hand-maintained DTOs (that would violate
[[shared-package]] and drift).

## Considered options

- **`@nestjs/swagger` alone with class DTOs** (class-validator/`@ApiProperty`). Idiomatic Nest,
  but duplicates the contract already defined in zod — two sources of truth, guaranteed drift.
  Rejected.
- **`@nestjs/swagger` + a homemade zod→OpenAPI bridge** using zod 4's `z.toJSONSchema`, keeping
  the custom pipe from [[0013-zod-validation-pipe]]. Fewer deps, but we maintain the bridge,
  the `z.date()`/JSON-Schema edge cases, and per-endpoint wiring ourselves; no response
  serialization.
- **`nestjs-zod`** — purpose-built: `createZodDto` turns a shared zod schema into a Nest DTO that
  serves validation, the TS type, **and** the OpenAPI schema; ships a `ZodValidationPipe`,
  `cleanupOpenApiDoc`, `@ZodResponse` + `ZodSerializerInterceptor`. Actively maintained, zod 4
  support. Costs two dependencies. *(chosen)*

## Decision

Adopt **`@nestjs/swagger` 11 + `nestjs-zod` 5**, keeping zod as the single source of truth across
validation, types, OpenAPI and response shape.

- **DTOs** are `createZodDto(<SharedSchema>)` over the schemas in `@lazyit/shared` — no schema is
  redefined in the API.
- **Validation** is nestjs-zod's `ZodValidationPipe`, registered globally (`APP_PIPE`). This
  **replaces** the custom pipe of [[0013-zod-validation-pipe]] (now deleted).
- **Responses** use `@ZodResponse({ type: Dto })` + a global `ZodSerializerInterceptor`
  (`APP_INTERCEPTOR`) so the documented response shape is enforced at runtime.
- **The OpenAPI document** is built in `main.ts` (`DocumentBuilder` + `SwaggerModule`), passed
  through nestjs-zod's `cleanupOpenApiDoc()` (required for correct zod output), and served at
  **`GET /api/docs`** (Swagger UI) and **`GET /api/docs-json`** (raw JSON).
- **Controllers** carry `@ApiTags` / `@ApiOperation` / `@ApiResponse`; applied **retroactively to
  [[user]] and [[location]]** for consistency.
- **Dates over the wire:** HTTP JSON has no `Date` type and `z.date()` cannot be represented in
  JSON Schema, so date fields in DTOs are ISO-8601 **strings** (`z.iso.datetime()`). Prisma
  accepts ISO strings for `DateTime` inputs.
- **Error mapping (realizes ADR-0013's follow-up):** a global `PrismaExceptionFilter`
  (`APP_FILTER`) maps Prisma known errors — `P2002` unique → `409`, `P2003` FK constraint →
  `400`, `P2025` record-not-found → `404` — so e.g. creating an [[asset]] with an invalid
  `locationId` returns a clean `400` instead of a leaked `500`.

**New dependencies justified:** `nestjs-zod` is the maintained, idiomatic way to keep zod as the
single source of truth for validation **and** OpenAPI in NestJS; peer-compatible with NestJS 11,
`@nestjs/swagger` 11 and zod 4. The alternative (homemade bridge) re-implements it with more
code and gaps.

## Consequences

- **Positive:** one source of truth (zod) for validation, types, OpenAPI and response shape;
  live docs at `/api/docs`; no duplicate DTOs; cleaner error responses across every endpoint.
- **Supersession:** [[0013-zod-validation-pipe]] is superseded — the custom
  `apps/api/src/common/zod-validation.pipe.ts` is removed and the validation error payload
  changes from `z.treeifyError` to nestjs-zod's `{ statusCode, message, errors[] }`.
- **Trade-offs:** two new deps; `z.date()` is unusable in DTOs (use ISO strings); a global pipe,
  interceptor and exception filter now shape every request/response.
- **Security:** the docs are **public** — acceptable because the API is unauthenticated and
  dev-only ([[0016-auth-strategy-deferred]]). Whether to protect `/api/docs` is deferred to the
  auth work.
- **Open question / follow-up:** generate a **TypeScript client for the frontend from the OpenAPI
  spec** (e.g. `openapi-typescript`)? Noted, **not decided here** — to be settled when the
  frontend starts consuming the API in earnest.

Related: [[0013-zod-validation-pipe]] (superseded) · [[shared-package]] · [[0002-nestjs-backend]] ·
[[0016-auth-strategy-deferred]] · [[asset]] · [[user]] · [[location]]
