---
title: "ADR-0013: Zod validation via a custom ZodValidationPipe"
tags: [adr]
status: superseded
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0013: Zod validation via a custom ZodValidationPipe

## Status

superseded by [[0018-api-documentation-swagger]] — when we adopted Swagger we switched to
`nestjs-zod`, whose `ZodValidationPipe` + `createZodDto` replace the custom pipe (exactly the
revisit this ADR's trade-offs anticipated). The decision below is kept for the historical record.

## Context

Request validation must use a single source of truth shared by `api` and `web`. The zod
schemas live in `@lazyit/shared` ([[shared-package]]); the API needs a standard way to bind a
shared schema to a NestJS route. We decide it now, with the first entity ([[user]]), so every
endpoint follows the same pattern.

## Considered options

- **Custom `ZodValidationPipe`** — a tiny injectable pipe that `safeParse`s the value against a
  schema passed at construction and throws `BadRequestException` (`z.treeifyError`) on failure.
  No extra dependency; `@lazyit/shared` stays framework-agnostic.
- **`nestjs-zod` library** — bundles a pipe, `createZodDto`, and Swagger integration. Adds a
  dependency and wraps the shared schema in a Nest-specific DTO; we'd track its zod 4 / Nest 11
  compatibility.

## Decision

Custom `ZodValidationPipe` in `apps/api/src/common/zod-validation.pipe.ts`, used per route:
`@Body(new ZodValidationPipe(CreateUserSchema))`. The schema is imported from `@lazyit/shared`
and the controller param is annotated with the inferred type. This keeps the shared package free
of framework code (per [[shared-package]]) and dependencies minimal (the project's
"boring, durable, opinionated" stance).

## Consequences

- **Positive:** one validation definition for web + api; zero extra deps; clear `400` payloads
  via `z.treeifyError`; the shared package stays pure (no Nest coupling).
- **Trade-offs:** no automatic OpenAPI/Swagger generation — revisit (`nestjs-zod` /
  `zod-to-openapi`) if/when we adopt Swagger; we maintain ~15 lines of pipe.
- **Follow-ups:** consider a global exception filter mapping Prisma known errors (e.g. `P2002`
  unique-violation → `409`) once more entities exist; not needed for the first one.

Related: [[shared-package]] · [[user]] · [[0012-testing-strategy]] · [[code-conventions]]
