---
title: Location
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Location

> 🟢 implemented · Area: Assets (core) · Implementation order: 1 (atomic, no dependencies)

## Purpose

Where an [[asset]] physically lives — office, datacenter, rack, warehouse, "remote / with
employee". Answers half of the core audit question "what do we have and **where is it**?"
([[problem-space]]).

## Relationships

- **holds** N [[asset]]s.

## Business rules

- Atomic entity — no dependencies; implemented first alongside [[user]].
- Flat (non-hierarchical). May become hierarchical later (site → room → rack); start flat
  unless needed.
- Every location is **classified** by a required `type` — hardcoded enum for now, with
  user-managed custom types deferred (see the Known-debt note below and [[0017-location-type-enum]]).

## Conventions

- **ID:** `cuid()` — not a sensitive/exposed entity ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields

Implemented in `apps/api/prisma/schema.prisma` (`Location` → table `locations`). Validation
schemas (`LocationSchema`, `CreateLocationSchema`, `UpdateLocationSchema`, `LocationTypeSchema`)
live in `@lazyit/shared` (`packages/shared/src/schemas/location.ts`) and are the source of truth
for both api and web ([[shared-package]], [[0013-zod-validation-pipe]]).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())` — non-sensitive domain entity ([[0005-id-strategy]]). |
| `name` | `string` | required. |
| `type` | `LocationType` | required enum, **no default** — every location is classified (see debt note). |
| `description` | `string?` | optional free text. |
| `address` | `string?` | optional. |
| `floor` | `string?` | optional. **String, not number** — floors are labels like "PB", "Subsuelo 1", "Mezzanine". |
| `notes` | `string?` | optional free text. |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | Soft delete — `null` while live; reads filter `deletedAt: null` ([[0006-soft-delete-and-auditing]]). |

`LocationType` values (hardcoded enum): `OFFICE`, `DATACENTER`, `RACK`, `REMOTE`, `STORAGE`,
`OTHER`.

> [!warning] Known debt — user-managed location types
> `type` is a **hardcoded Prisma enum**. The product intent is to let users manage **custom**
> location types from the UI, which would mean either a `LocationCategory` table (FK from
> `Location`, like the planned [[asset-category]]) or a soft-validated string. Deferred
> deliberately — recorded in [[0017-location-type-enum]]. Until then, adding a type is an enum
> value + a migration, not a runtime action.

## Endpoints

`apps/api/src/locations/` (`LocationsModule`): `GET /locations` (excludes soft-deleted),
`GET /locations/:id`, `POST /locations`, `PATCH /locations/:id`, `DELETE /locations/:id`
(soft delete). Bodies validated against the shared schemas and documented via Swagger
([[0018-api-documentation-swagger]]).

Related: [[asset]] · [[conventions]] · [[shared-package]] · [[0013-zod-validation-pipe]] ·
[[0017-location-type-enum]]
