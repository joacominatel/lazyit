---
title: InfraNode
tags: [domain, entity, infra, topology]
status: accepted
created: 2026-06-23
updated: 2026-06-23
---

# InfraNode

> 🟢 implemented · Area: Infra topology · Implementation order: after [[asset-assignment]] (reuses the asset surface)

## Purpose

A **thing on the topology map** — anything in the server estate: a physical host, a VM, a container,
a cluster, a network device, storage, an appliance, or anything else. The generic visual CMDB
([[0070-infra-topology-graph]]): a free-move canvas of nodes joined by typed [[infra-edge]]
relationships. A node is **Asset-backed by default** — it links to an [[asset]] so it inherits
owner (via [[asset-assignment]]), KB links, secret references, warranty and shortcuts — and can be
detached to a **graph-only** node for ephemerals (a short-lived container). The model is **generic
on purpose**: no platform-specific kinds (a k8s pod is a `CONTAINER`, a namespace a
`CLUSTER`/`OTHER`); the platform detail, if wanted, lives in `specs` or `label`.

## Relationships

- **is optionally backed by** one [[asset]] (`assetId`, nullable FK, `onDelete: SetNull`) — default-on
  at create; deleting the asset **detaches** the node (audit > strict integrity), never deletes it.
- **is the source of** N [[infra-edge]] (`edgesFrom`, relation `EdgeSource`).
- **is the target of** N [[infra-edge]] (`edgesTo`, relation `EdgeTarget`).
- **reads ownership / KB / secrets through** the linked [[asset]] — never a direct edge to a [[user]]
  ("servers-only graph"; ownership is the asset's [[asset-assignment]] join, [[asset-centric]]).

## Business rules

- **Asset linkage is default-on (the "track as asset" toggle — [[0070-infra-topology-graph]] §5).**
  Creating a node defaults to asset-backed: the API links a supplied `assetId` or **mints a minimal
  backing Asset** (name = `label`) so the node immediately has an owner/KB/secret surface. Toggle off
  → a graph-only node (no asset, right for ephemeral containers). `trackAsAsset` is **API logic, not
  a persisted field** — it rides as its own create-body flag (sending `assetId` with
  `trackAsAsset:false` is a contradiction → `400`).
- **Detach semantics (no orphans).** Patching `assetId: null` detaches: an **auto-created** Asset is
  **soft-deleted** (it never lingers in inventory owned by nobody); a **pre-existing linked** Asset is
  only un-linked, left intact.
- **`label` always wins for display.** The canvas display name is `label`; the linked
  `asset.name` is shown only as a secondary "inventory name" (`assetName` on the detail read) — no
  silent copy, no drift.
- **Soft delete = off the map, history kept** ([[0006-soft-delete-and-auditing]]). `DELETE` sets
  `deletedAt` (node off the canvas), `POST …/restore` clears it (back on the map). The Asset behind a
  node is never hard-deleted.
- **Provenance + lifecycle columns exist now, exercised in v2** ([[0070-infra-topology-graph]] §4).
  `source` (MANUAL | AGENT), `state` (CONFIRMED | PENDING — the review tray), `reportingSource`,
  `externalId`, `lastReportedAt` sit nullable/defaulted; the installable reporting agent that fills
  them is a future major (extends [[0048-service-accounts]] auth). No agent code ships in v1; the
  composite partial-unique `(reportingSource, externalId)` index is a forward-only add deferred with it.
- **Access surface, not a network model** (scope cut). `ipAddress` is a label-only string (no
  validation/IPAM), `shortcuts` is `[{ label, url }]` (URLs validated by zod), `specs` is a loose
  jsonb of per-kind attrs ([[0007-flexible-asset-specs-jsonb]] posture; per-kind schema validation
  deferred — the shared `TODO(specs)` debt).
- **Permissions** ([[0046-roles-permissions-v2]]): `infra:read` to view the map/list/detail (the
  link is hidden without it; the API is the real gate), `infra:manage` for create/edit/connect/
  status/remove. Asset-backed create also needs the relevant `assets:*`.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt` (mutable domain entity).

## Fields

Prisma model `InfraNode` → table `infra_nodes`. Validation schemas (`InfraNodeSchema`,
`CreateInfraNodeSchema`, `UpdateInfraNodeSchema`, `InfraNodeDetailSchema`, the kind/status/source/
state enums) live in `@lazyit/shared` (`packages/shared/src/schemas/infra.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `kind` | `InfraNodeKind` | required, generic + extensible (see enum below). |
| `label` | `string` | required; the canvas display name (always wins for display). |
| `status` | `InfraNodeStatus` | `@default(UNKNOWN)`. |
| `assetId` | `cuid?` | nullable FK → [[asset]], `onDelete: SetNull`. Default-on link; null = graph-only. |
| `ipAddress` | `string?` | primary IP, label-only (no validation/IPAM). |
| `shortcuts` | `jsonb?` | `[{ label, url }]` SSH/web-UI/console links (max 20; URLs zod-validated). |
| `specs` | `jsonb?` | loose per-kind attributes (ADR-0007 posture; per-kind validation deferred). |
| `x` / `y` | `float?` | canvas position (free-move board; persisted on drag-stop). |
| `source` | `InfraNodeSource` | `@default(MANUAL)`; AGENT in v2. |
| `state` | `InfraNodeState` | `@default(CONFIRMED)`; PENDING = the v2 review tray. |
| `reportingSource` | `string?` | which agent/host reported it (v2 dedup scope). |
| `externalId` | `string?` | platform id (vmid/container-id) for v2 reconciliation. |
| `lastReportedAt` | `datetime?` | v2 agent liveness (stale → OFFLINE). |
| `createdAt` | `datetime` | `@default(now())`. |
| `updatedAt` | `datetime` | `@updatedAt`. |
| `deletedAt` | `datetime?` | soft delete = off the map. |

Enums: `InfraNodeKind` = `PHYSICAL_HOST` · `VM` · `CONTAINER` · `CLUSTER` · `NETWORK_DEVICE` ·
`STORAGE` · `APPLIANCE` · `OTHER`. `InfraNodeStatus` = `ONLINE` · `OFFLINE` · `UNKNOWN`.
`InfraNodeSource` = `MANUAL` · `AGENT`. `InfraNodeState` = `CONFIRMED` · `PENDING`.

Indexes: `@@index([assetId])`, `@@index([kind])`, `@@index([state])` (the PENDING review-tray query).

## Endpoints

`apps/api/src/infra/` (`InfraModule`), all gated server-side (`infra:read` / `infra:manage`):

- `GET /infra/nodes?kind=&status=&state=` — list (plain `InfraNode[]`, **no page envelope** — the
  estate is small by design; excludes soft-deleted, newest first). Carries `assetId` (the linkage),
  not the asset name/owners (those are detail-only). Enriching the list row with the asset name +
  owner is a tracked follow-up (#750).
- `GET /infra/nodes/:id` — the enriched **drill-in** (`InfraNodeDetail`): the node plus its
  asset-backed payoff — `assetName`, active `owners`, published `articleLinks`, `secretRefs`
  (HANDLES only, never values — INV-10, [[0061-secret-manager-zero-knowledge]]; **empty in v1** — no
  asset→secret linkage exists yet), `shortcuts`, IP, and `children` (active inverse RUNS_ON).
- `POST /infra/nodes` — create; default asset-backed (`trackAsAsset`, §5).
- `PATCH /infra/nodes/:id` — partial update (`status` toggle, `label`, `kind`, `ipAddress`,
  `shortcuts`, `assetId: null` to detach).
- `PATCH /infra/nodes/:id/position` — persist canvas `{ x, y }` (debounced on drag-stop).
- `DELETE /infra/nodes/:id` — soft delete (off the map). `POST /infra/nodes/:id/restore` — back on.
- `GET /infra/nodes/:id/impact` — **blast radius** ([[0070-infra-topology-graph]] §7): the downstream
  set reachable over active inverse RUNS_ON/DEPENDS_ON edges, each with a hop `depth`. "What's
  affected if this goes down."
- `GET /infra/nodes/:id/edges?active=` — the node's [[infra-edge]]s (active-only by default; pass
  `active=false` for full history incl. closed migrations).

## Not yet implemented (deferred)

- The **v2 reporting agent** (auto-discovery → PENDING tray, liveness, reconciliation/merge-on-confirm)
  — its columns exist nullable now; its own major epic.
- **asset→secret linkage** so `secretRefs` populates (the shape is honoured; the array is empty today).
- List-row asset name/owner enrichment (#750); deep network model (VLAN/ports/IPAM); metrics/alerting;
  per-kind `specs` validation; multi-board layouts; a `SERVICE` kind linked to [[application]]; a
  dedicated `InfraNodeHistory`. → [[0070-infra-topology-graph]] "Future".

Related: [[infra-edge]] · [[asset]] · [[asset-assignment]] · [[asset-centric]] · [[user]] ·
[[0070-infra-topology-graph]] · [[0019-asset-assignment-integrity]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] ·
[[0061-secret-manager-zero-knowledge]] · [[0048-service-accounts]]
