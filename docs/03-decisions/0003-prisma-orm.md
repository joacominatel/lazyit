---
title: "ADR-0003: Prisma as ORM on PostgreSQL"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0003: Prisma as ORM on PostgreSQL

## Status

accepted

## Context

The domain is relational with real referential integrity needs (assets, owners over time,
tickets, access). We want type-safe data access shared with TypeScript, plus first-class
migrations for an auditable, evolving schema.

## Considered options

- **Prisma + PostgreSQL** — typed client, declarative schema, migration tooling, jsonb support
  (needed for flexible asset `specs`, see [[0007-flexible-asset-specs-jsonb]]).
- **`Bun.sql` (raw SQL)** — matches `CLAUDE.md`, minimal deps. Cons: no typed models or
  migration workflow; we'd build a lot ourselves.
- **Drizzle / TypeORM** — viable ORMs; Prisma chosen for its schema-first DX and migration
  ergonomics.

## Decision

Prisma 7 on PostgreSQL 18. Schema in `apps/api/prisma/schema.prisma`; client generated to
`apps/api/generated/prisma`. Config via `prisma.config.ts` (with `dotenv`). Dev DB runs in
Docker Compose.

## Consequences

- **Positive:** typed models, declarative migrations (audit-friendly), jsonb for `specs`.
- **Trade-offs:** Prisma over `Bun.sql` diverges from `CLAUDE.md` ([[0009-bun-first-vs-app-stack]]);
  generated client adds a build step.
- **Follow-ups:** wire a `PrismaService` into Nest DI ([[0002-nestjs-backend]]); confirm how
  `DATABASE_URL` is provided — the datasource has no `url` and `.env.example` lacks it (see
  [[setup]] and gaps in [[README]]).
