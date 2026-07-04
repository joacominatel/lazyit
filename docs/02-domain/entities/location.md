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
- **nests** under an optional parent Location and **holds** N child Locations — a self-referential
  hierarchy (adjacency list via `parentId`). See _Hierarchy_ below.

## Business rules

- Atomic entity — no dependencies; implemented first alongside [[user]].
- **Hierarchical (#845):** a location may hang off a parent (`parentId`), forming a **free tree**
  — site → room → rack is the intended convention but is **not** enforced (a `RACK` may sit under
  any node, or be a root). `parentId = null` is a root. The **one** structural rule is **no
  cycles**: a location can be neither its own parent nor moved under one of its own descendants —
  enforced in `LocationsService` (the DB can't express it), rejected `400`. A missing or
  soft-deleted `parentId` is likewise rejected `400`. On a (hypothetical) hard delete of a parent
  the FK is `onDelete: SetNull`, so children become roots — mirrors `Asset.locationId`; normal
  deletes are soft.
- Every location is **classified** by a required `type` — hardcoded enum for now, with
  user-managed custom types deferred (see the Known-debt note below and [[0017-location-type-enum]]).
  The same `type` enum doubles as the hierarchy node **kind** (no separate kind field).

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
| `parentId` | `cuid?` | Self-referential parent (adjacency list, #845). `null` = root. Indexed; FK `onDelete: SetNull`. Cycle-free enforced in the service. |
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

## Hierarchy read/write shapes (#845)

- **List** (`GET /locations`) items are plain `LocationSchema` rows — now carrying `parentId`
  (nullable). No ancestry is resolved per row (avoids an N+1 walk on the page).
- **Detail** (`GET /locations/:id`) returns `LocationDetailSchema` = the full location **plus** a
  resolved `path` — an ordered breadcrumb **root→self inclusive**, each hop `{ id, name, type }`
  (the last element is the location itself). The web breadcrumb renders `path` directly. A
  soft-deleted ancestor ends the walk (the location is treated as a root from that break).
- **Create / update** accept an optional `parentId` (nullable). `null`/omitted = root; a
  cycle-forming or missing/soft-deleted parent → `400`.
- Ancestry is a **bounded parent-walk** (cap 32 levels, cycle-free by construction; the cap only
  guards against corrupt data and is logged if hit).

## Endpoints

`apps/api/src/locations/` (`LocationsModule`): `GET /locations` (excludes soft-deleted, returns
`parentId`), `GET /locations/:id` (returns the entity **+ ancestry `path`**), `POST /locations`,
`PATCH /locations/:id` (both accept optional `parentId`), `DELETE /locations/:id` (soft delete),
`POST /locations/:id/restore` (ADMIN-only — clears `deletedAt`,
[[0041-soft-delete-reuse-and-restore]]). Bodies validated against the shared schemas and documented
via Swagger ([[0018-api-documentation-swagger]]).

**Web:** `locations/[id]` is the location detail page — the place's facts plus the "assets here"
view (the inventory physically located there), via the existing `GET /assets?locationId=` filter
(no dedicated endpoint). See [[0020-frontend-data-layer]].

Related: [[asset]] · [[conventions]] · [[shared-package]] · [[0013-zod-validation-pipe]] ·
[[0017-location-type-enum]]
