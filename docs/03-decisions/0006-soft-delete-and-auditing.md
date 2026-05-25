---
title: "ADR-0006: Soft delete & append-only auditing"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0006: Soft delete & append-only auditing

## Status

accepted — confirmed 2026-05-25 (split by mutability).

## Context

Auditability is a first principle ([[vision]]): "what changed, when, by whom?" must always be
answerable. The briefing initially called for `deletedAt` + `updatedAt` on **every** table.
But some tables are append-only logs/ledgers ([[asset-history]], audit logs,
[[consumable-movement]]) that are immutable by design.

## Considered options

- **Uniform: `deletedAt` + `updatedAt` on every table** (as briefed). Cons: a soft-deletable,
  "updatable" audit log is self-contradictory — you can't audit-trail the audit trail; an
  append-only ledger that can be edited is no longer a ledger.
- **Split by mutability** — soft delete + `updatedAt` on *mutable domain* entities;
  append-only tables get `createdAt` only and are never updated or deleted.

## Decision

Split by mutability.

- **Mutable domain entities** (most of [[02-domain/_MOC|Domain]]): `createdAt`, `updatedAt`,
  `deletedAt` (soft delete). Never hard-deleted.
- **Append-only tables** ([[asset-history]], audit logs, [[consumable-movement]]):
  `createdAt` only. No `updatedAt`, no `deletedAt`. Corrections are new compensating rows.
- **Lifecycle joins** ([[asset-assignment]], [[access-grant]]) use explicit lifecycle fields
  (`releasedAt` / revocation), not soft delete.

## Consequences

- **Positive:** audit/ledger integrity guaranteed; conventions match each table's real
  semantics ([[conventions]]).
- **Trade-offs:** queries must respect `deletedAt IS NULL` on mutable entities (consider a
  Prisma middleware/extension to enforce it).
- **Follow-ups:** when models are implemented, give append-only tables `createdAt` only and
  add a default `deletedAt IS NULL` scope on mutable entities (Prisma extension/middleware).
