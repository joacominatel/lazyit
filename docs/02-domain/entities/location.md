---
title: Location
tags: [domain, entity]
status: accepted
created: 2026-05-25
updated: 2026-10-21
---

# Location

> 🟢 implemented · Area: Assets (core) · Implementation order: 1 (atomic, no dependencies)

## Purpose

Where an [[asset]] physically lives — office, datacenter, rack, warehouse, "remote / with
employee". Answers half of the core audit question "what do we have and **where is it**?"
([[problem-space]]).

## Relationships

- **holds** N [[asset]]s.
- **receives** N consumable **deliveries**: `OUT` [[consumable-movement]]s whose `targetLocationId` is
  this place, such as a fire extinguisher on a floor. This records a **destination only, not
  per-location stock**. List them with `GET /consumables/deliveries?targetLocationId=` (also needs
  `location:read`). The FK is `Restrict`; a soft delete is unaffected
  ([[0098-consumable-delivery-targets]]).
- **nests** under an optional parent Location and **holds** N child Locations — a self-referential
  hierarchy (adjacency list via `parentId`). See _Hierarchy_ below.

## Business rules

- Atomic entity — no dependencies; implemented first alongside [[user]].
- **Hierarchical (#845):** a location may hang off a parent (`parentId`), forming a **free tree**
  — site → room → rack is the intended convention but is **not** enforced (a `RACK` may sit under
  any node, or be a root). `parentId = null` is a root. The **one** structural rule is **no
  cycles**: a location can be neither its own parent nor moved under one of its own descendants —
  enforced in `LocationsService` (the DB can't express it), rejected `400`. A missing or
  soft-deleted `parentId` is likewise rejected `400`. Only the parent itself must be live: a live
  location that sits under an archived ancestor is a valid parent, and the cycle walk passes through
  archived ancestors, so an archived link cannot hide a loop that restoring it would close (audit
  2026-10-10, AUD-080). The walk stops at a node it has already visited, so a loop already in the
  data still ends. On a (hypothetical) hard delete of a parent
  the FK is `onDelete: SetNull`, so children become roots — mirrors `Asset.locationId`; normal
  deletes are soft.
- **Tree writes are serialized** (audit 2026-10-10 follow-up) — every write that changes the tree's
  shape (a move, including a promote to root, a nested create, a delete, a restore) runs its checks and
  its write in **one transaction** holding a single transaction-scoped Postgres **advisory lock** on the
  location tree. Two opposing moves therefore cannot both pass the cycle check, and a child cannot be
  created under, or restored into, a parent that is being deleted. Field-only edits and root creates
  don't take it.
- Every location is **classified** by a required `type` — hardcoded enum for now, with
  user-managed custom types deferred (see the Known-debt note below and [[0017-location-type-enum]]).
  The same `type` enum doubles as the hierarchy node **kind** (no separate kind field).
- **Delete with one resolution (AUD-024, closes the location half of SEC-041).** A delete affects the
  location's **live assets**, its **live child locations** and its **open purchases** whose delivery
  location it is — live, `DRAFT` or `ORDERED` (a status a newer build adds counts as closed), and either
  a countable line still has units pending or there is no countable line at all. While any of them exists, the delete needs **one**
  resolution for all of them, never one per row:
  - `detach` — assets lose their location, child locations become top-level, open purchases lose
    their delivery location;
  - `move` — all of them go to one target location: live, not the location itself, and not one of its
    descendants (`400` otherwise). "Create another location" is the client creating it first, then
    deleting with `move` to it.

  Without a resolution the delete is a `409` with code `DELETE_RESOLUTION_REQUIRED` and the counts,
  so an older client, a script or the AI never strands rows silently. The resolution and the soft
  delete run in **one transaction** under the tree lock (30 s timeout). The location's own row is locked
  `FOR UPDATE` first, then the assets and purchases `FOR UPDATE` in id order, the order every other
  purchase lock takes. Each moved asset gets a `LOCATION_CHANGED` [[asset-history]] row
  (`{ from, to }`, `to: null` on detach), all written in one insert, and each purchase an `UPDATED`
  activity row for `deliveryLocationId`. History keeps its reference: consumable deliveries (an
  append-only ledger), closed purchases, and archived assets and child locations still point at the
  archived location. Restoring the location re-links nothing.
- **Writes that point a row here serialize with the delete (#1604).** An asset create, a move, a
  receive (each unit), and a purchase create or update naming this location as its delivery location
  lock the location row `FOR SHARE` inside their transaction, before their own row. The delete's
  `FOR UPDATE` conflicts with it: either the write commits first and the delete finds and resolves the
  new row, or the delete commits first and the write sees the location archived (`400`). Lock order
  everywhere is the parent first, then the rows that point at it, so neither side waits for a parent
  while holding a child. See [[0023-access-management-design]].
- **Restore needs a live parent (AUD-080).** Restoring a location whose parent is still soft-deleted
  is a `409`: restore the parent first. Restores do not cascade
  ([[0041-soft-delete-reuse-and-restore]]). Locations already left under an archived parent keep
  loading as before.
- **Locations archived before the delete resolution** still have their assets, children and purchases
  pointing at them, since that delete resolved nothing. Restoring one brings those links back as they
  were; deleting it again later goes through the resolution like any other delete.

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
  cycle-forming or missing/soft-deleted parent → `400`. An archived ancestor further up does not
  block the write.
- Ancestry is a **bounded parent-walk** (cap 32 levels, cycle-free by construction; the cap only
  guards against corrupt data and is logged if hit).

## Endpoints

`apps/api/src/locations/` (`LocationsModule`): `GET /locations` (excludes soft-deleted, returns
`parentId`), `GET /locations/:id` (returns the entity **+ ancestry `path`**), `POST /locations`,
`PATCH /locations/:id` (both accept optional `parentId`), `GET /locations/:id/delete-impact`
(`location:delete` — the counts plus the first 50 assets, child locations and open purchases, each list
only when the caller may read that kind, `LocationDeleteImpactSchema`), `DELETE /locations/:id`
(soft delete; `?strategy=detach` or `?strategy=move&targetId=` — `DeleteResolutionSchema`, see the rule
above), `POST /locations/:id/restore` (ADMIN-only — clears `deletedAt`, `409` while the parent is still
deleted, [[0041-soft-delete-reuse-and-restore]]). Bodies validated against the shared schemas and documented
via Swagger ([[0018-api-documentation-swagger]]).

**Export.** `GET /locations/export?q=&type=&deleted=` streams every location the list would return for the
same filters as CSV, under the same `location:read` and the same ADMIN-only `deleted=only` (#1597,
[[0103-data-export-streaming-path]]). Columns: `id, name, type, parentId, address, floor, description,
notes, createdAt, updatedAt, deletedAt`. The list carries `parentId`, not the ancestry `path`, so the file
does too: the hierarchy is rebuilt from `id` / `parentId`. Every export is audited ([[data-export-log]]).

**Web:** `locations/[id]` is the location detail page — the place's facts plus the "assets here"
view (the inventory physically located there), via the existing `GET /assets?locationId=` filter
(no dedicated endpoint). See [[0020-frontend-data-layer]].

Related: [[asset]] · [[conventions]] · [[shared-package]] · [[0013-zod-validation-pipe]] ·
[[0017-location-type-enum]]
