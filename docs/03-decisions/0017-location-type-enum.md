---
title: "ADR-0017: Location type as a hardcoded enum (user-managed types deferred)"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0017: Location type as a hardcoded enum (user-managed types deferred)

## Status

accepted — scope-limited to the current iteration; revisit when user-managed types are
prioritized (see Follow-ups).

## Context

[[location]] needs a `type` classifier (office, datacenter, rack, …). The product intent is to
eventually let users define **custom** location types from the UI. But Location is the second
atomic entity ([[02-domain/_MOC|Domain]] step 1): there is no UI yet, no settings/admin surface,
and no other "user-managed taxonomy" pattern in the codebase. Committing now to a user-managed
model would be speculative — a table plus endpoints with no consumer.

## Considered options

- **Hardcoded Prisma enum `LocationType`** — fixed set (`OFFICE`, `DATACENTER`, `RACK`,
  `REMOTE`, `STORAGE`, `OTHER`). Type-safe end to end (Prisma enum + zod `z.enum` in
  `@lazyit/shared`), zero extra surface. Con: adding a value needs a migration; users can't
  self-serve.
- **`LocationCategory` table (FK from Location)** — fully user-managed, soft-deletable; mirrors
  the planned [[asset-category]] pattern. Con: premature — no UI/consumer yet, more surface to
  build and maintain now.
- **Soft-validated free string** — maximal flexibility, no migration to add a type. Con: no
  referential integrity; easy typo-driven fragmentation ("Office" vs "office"); weak typing.

## Decision

Ship the **hardcoded Prisma enum** for this iteration. It is the smallest correct thing and
keeps the contract type-safe across Prisma, `@lazyit/shared` (`LocationTypeSchema`) and web
(`LocationTypeSchema.options` renders a dropdown). `type` is **required, no default** — every
location is classified. **User-managed custom types are deferred, not rejected.**

## Consequences

- **Positive:** end-to-end type safety; trivial to surface in the UI; no speculative
  tables/endpoints; consistent with [[0005-id-strategy]] / [[0006-soft-delete-and-auditing]].
- **Trade-offs:** adding a type is a code + migration change, not a runtime/admin action.
- **Follow-ups:** when user-managed types are prioritized, supersede this with an ADR choosing
  `LocationCategory` (FK) vs soft-validated string, and migrate the enum data accordingly. The
  likely path is a `LocationCategory` table aligned with [[asset-category]].

Related: [[location]] · [[conventions]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]]
