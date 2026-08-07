---
title: InfraEdge
tags: [domain, entity, infra, topology]
status: accepted
created: 2026-06-23
updated: 2026-06-23
---

# InfraEdge

> 🟢 implemented · Area: Infra topology · Implementation order: with [[infra-node]]

## Purpose

A **typed, timestamped relationship between two [[infra-node]]s** — the edges of the topology graph
([[0070-infra-topology-graph]] §3). Same DNA as [[asset-assignment]]
([[0019-asset-assignment-integrity]]): an append-style lifecycle join with `startedAt` / `endedAt`,
so a relationship that changes over time (a VM migrating between hosts) is **closed and re-opened**,
never edited in place — the move is auditable. The edge kinds express *how* two things relate: what
runs on what, what belongs to a group, what depends on what, what backs up where, what connects to
what. The graph (not a tree) is what lets a node have two parents at once (e.g. *runs on* a host
**and** *member of* a cluster) — a `parentId` column couldn't.

## Relationships

- **points from** one [[infra-node]] (`sourceId`, required FK, relation `EdgeSource`,
  `onDelete: Cascade`).
- **points to** one [[infra-node]] (`targetId`, required FK, relation `EdgeTarget`,
  `onDelete: Cascade`).

## Business rules

- **Edge kinds + direction** ([[0070-infra-topology-graph]] §3):

  | kind | meaning | direction (source → target) | cardinality |
  | --- | --- | --- | --- |
  | `RUNS_ON` | source is hosted/executed by target | child → host (VM → host) | **one active per source** |
  | `MEMBER_OF` | source belongs to a logical group | member → group (host → cluster) | many |
  | `DEPENDS_ON` | source needs target to function | dependent → dependency | many |
  | `BACKS_UP_TO` | source's data is backed up to target | backed-up → backup target | many |
  | `CONNECTS_TO` | network adjacency (cosmetic v1) | **symmetric** — API canonicalizes the lower `id` as source | many |

- **Append-style lifecycle, not soft delete.** `endedAt = null` is *active*; setting it **closes** the
  edge (the migration marker). A `RUNS_ON` move is "close the old, open the new" — the panel surfaces
  closed edges as read-only history. There is no `deletedAt` and no soft delete on edges.
- **One active host per node (RUNS_ON).** A raw-SQL **partial unique** index
  `(sourceId) WHERE endedAt IS NULL AND kind = 'RUNS_ON'` enforces it; **only** RUNS_ON is constrained
  (MEMBER_OF / DEPENDS_ON / BACKS_UP_TO / CONNECTS_TO are legitimately many). Opening a RUNS_ON to a
  new host **migrates** (the API closes the active one, opens the new); a genuine conflict surfaces as
  a friendly `409`. Prisma can't express partial indexes → raw SQL in the migration ([[prisma-migrations]]).
- **CONNECTS_TO is symmetric + canonicalized.** A↔B is one edge; the API stores the lower `id` as
  `sourceId` so the pair is unique regardless of input order, backed by a second partial unique index
  `(sourceId, targetId) WHERE kind = 'CONNECTS_TO' AND endedAt IS NULL`.
- **No self-loop** — `sourceId ≠ targetId` (rejected by the `CreateInfraEdgeSchema` refine and the API).
- **Plausibility is a warning, not a constraint.** The API warns on implausible (sourceKind →
  targetKind) pairs (via `PLAUSIBLE_EDGE_TARGETS` / `isPlausibleEdge` in `@lazyit/shared`) — e.g. a
  `CONTAINER` that `RUNS_ON` a `NETWORK_DEVICE` — but does **not** block, to keep the model generic.
- **Cascade on node delete.** An edge is meaningless without both endpoints and is **not** an audited
  domain entity (the node and its [[asset]] carry the durable history), so it `Cascade`s when a node
  is hard-deleted. (Nodes are normally soft-deleted, which leaves edges intact.)

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps:** `createdAt`, `updatedAt`, plus the lifecycle `startedAt` / `endedAt`. **No
  `deletedAt`** — `endedAt` expresses lifecycle, not soft delete (mirrors [[asset-assignment]]).

## Fields

Prisma model `InfraEdge` → table `infra_edges`. Validation schemas (`InfraEdgeSchema`,
`CreateInfraEdgeSchema`, `InfraEdgeKindSchema`) live in `@lazyit/shared`
(`packages/shared/src/schemas/infra.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `sourceId` | `cuid` | FK → [[infra-node]] (`EdgeSource`), required, `onDelete: Cascade`. |
| `targetId` | `cuid` | FK → [[infra-node]] (`EdgeTarget`), required, `onDelete: Cascade`. |
| `kind` | `InfraEdgeKind` | RUNS_ON · MEMBER_OF · DEPENDS_ON · BACKS_UP_TO · CONNECTS_TO. |
| `startedAt` | `datetime` | `@default(now())`. |
| `endedAt` | `datetime?` | `null` = active; set = closed (the ADR-0019 migration marker). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |

Indexes: `@@index([sourceId])`, `@@index([targetId])`, `@@index([kind])`, plus the two raw-SQL
partial unique indexes above (one-active-host for RUNS_ON; canonical-pair for CONNECTS_TO).

## Endpoints

`apps/api/src/infra/` (`InfraModule`), gated `infra:read` / `infra:manage`:

- `GET /infra/nodes/:id/edges?active=` — read a node's edges (active-only by default; `active=false`
  includes closed history). The canvas fans this out per node (active-only) to assemble the graph; the
  drill-in panel reads the full history. Ordering is a **total** order — `startedAt desc` then the
  unique `id` desc (#1152), matching [[infra-node]]'s list. `startedAt` is `@default(now())` with no
  unique tiebreaker and a hypervisor report writes a host's guest `RUNS_ON` edges back to back, so
  same-millisecond ties are routine. The tiebreaker matters more here than on the node list: the
  Connections drill-in renders this response in **server order** (it filters on `endedAt`, it never
  sorts) and every infra mutation invalidates the whole infra query key, so it re-fetches often —
  with a partial order an invalidation mid-review reorders tied rows and the operator's "close"
  click lands on a different edge than the one they read.
- `POST /infra/edges` — open an edge. The API canonicalizes symmetric CONNECTS_TO, **migrates**
  RUNS_ON (closes the source's active host, opens the new), warns on implausible kind pairs, and
  returns a friendly `409` on a one-active-host / duplicate-pair conflict.
- `POST /infra/edges/:id/close` — set `endedAt` (close the relationship; the migration marker).

## Not yet implemented (deferred)

- No global edges list (edges are read per-node by design).
- Richer network semantics on `CONNECTS_TO` (ports/VLAN) — cosmetic in v1, see the deep-network
  scope cut in [[0070-infra-topology-graph]].

Related: [[infra-node]] · [[asset-assignment]] · [[0070-infra-topology-graph]] ·
[[0019-asset-assignment-integrity]] · [[0006-soft-delete-and-auditing]] · [[prisma-migrations]]
