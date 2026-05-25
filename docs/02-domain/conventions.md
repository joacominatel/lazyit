---
title: Domain Conventions
tags: [domain]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Domain Conventions

Technical conventions for the data model. These apply to every Prisma model unless a note
says otherwise.

## Naming

- **English everywhere** — model names, fields, comments.
- **Models** are singular PascalCase (`Asset`, `AssetAssignment`).
- **Database tables** are pluralized snake_case via `@@map("assets")`.
- Fields are camelCase in Prisma; Prisma maps to the DB.

## Identifiers

The ID strategy is intentional per entity (see [[0005-id-strategy]]):

| Strategy | Used for | Why |
| --- | --- | --- |
| `uuid()` | Sensitive / externally-exposed entities — primarily [[user]] | Non-enumerable, safe to expose in URLs/tokens |
| `cuid()` | Most domain entities — [[asset]], [[ticket]], [[application]], … | Compact, sortable-ish, collision-resistant |
| `autoincrement()` | Logs & history — [[asset-history]], audit logs | Cheap, ordered, never exposed externally |

## Timestamps

- `createdAt` on every table.
- `updatedAt` on **mutable** entities.

## Soft delete & auditing

- **Never hard delete** domain data — auditability is a first principle ([[vision]]).
- Mutable domain entities carry `deletedAt` (soft delete) + `updatedAt`.

> [!note] Append-only tables: `createdAt` only (decided 2026-05-25)
> The briefing's "every table" wording is **scoped by mutability**: append-only tables
> ([[asset-history]], audit logs, [[consumable-movement]]) are immutable, so they get
> `createdAt` only — no `updatedAt`, no `deletedAt`. A soft-deletable, "updatable" audit log
> would contradict itself. See [[0006-soft-delete-and-auditing]] (accepted).

## Flexible specs

- [[asset]] has a `specs Json` field (jsonb in Postgres) for type-specific attributes,
  because a switch, a laptop and a server have very different fields. Stable, queried
  attributes graduate to real columns over time. See [[0007-flexible-asset-specs-jsonb]].

## Relationships

- Many-to-many over time is modeled with an explicit join entity carrying timestamps
  (e.g. [[asset-assignment]]), not an implicit Prisma `m:n` relation — so history is
  first-class.

Related: [[asset-centric]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0007-flexible-asset-specs-jsonb]]
