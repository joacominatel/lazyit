---
title: "ADR-0007: Flexible asset specs via jsonb"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0007: Flexible asset specs via jsonb

## Status

accepted

## Context

A switch, a laptop and a server have wildly different attributes. Forcing them into one wide
table (mostly-null columns) or a table-per-type explosion both hurt. We need per-type
attributes on [[asset]] without a schema migration for every new attribute.

## Considered options

- **Wide columns** — every possible attribute as a nullable column. Cons: sparse, ever-growing,
  migration-heavy.
- **Table-per-type** — a table per asset category. Cons: rigid; joins and code explode with
  each new type.
- **EAV (entity-attribute-value)** — generic attribute rows. Cons: queries and integrity are
  painful.
- **`specs Json` (jsonb)** — a flexible column on [[asset]] for type-specific attributes.

## Decision

A `specs Json` field (jsonb in Postgres) on [[asset]]. The [[asset-category]] can define the
expected shape of `specs` for its models; stable, frequently-queried attributes graduate to
real columns over time.

## Consequences

- **Positive:** add asset types/attributes without migrations; one `Asset` table; Postgres can
  index/query jsonb when needed.
- **Trade-offs:** weaker DB-level typing/validation for `specs` — validate in the app layer
  (zod schema in `@lazyit/shared`, see [[monorepo]]).
- **Follow-ups:** define per-category `specs` zod schemas when categories are implemented.
