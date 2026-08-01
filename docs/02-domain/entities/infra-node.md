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
- **Access surface, not a network model** (scope cut). `ipAddress` is **format-validated** as an IPv4
  or IPv6 value on write (shared `IpAddressSchema`, native zod — [[0090-ipam-validated-ip]] / #847): a
  human edit that is malformed is a clean `400`, and the agent DROPS a garbage NIC value rather than
  `400`-ing the whole report (never IPAM — no registry/subnet/allocation/`@unique`). The reporting agent
  promotes the report's primary IPv4 into it and refreshes it each check-in unless `ipAddressSource` is
  `MANUAL` (a human edit — the agent never clobbers it; stamped `MANUAL` server-side when an IP rides an
  update, so it stays a trusted marker). ADR-0074 §3 / #1081. The drill-in read also carries a
  **display-only `ipConflict`** — a **soft, non-blocking** signal listing other LIVE nodes with the same
  IP (a badge; never a constraint — [[0090-ipam-validated-ip]]). `shortcuts` is `[{ label, url }]` (URLs
  validated by zod), `specs` is a loose jsonb of per-kind attrs ([[0007-flexible-asset-specs-jsonb]]
  posture; per-kind schema validation deferred — the shared `TODO(specs)` debt).
- **Secret linkage is a soft handle-ref ([[0073-infra-node-secret-linkage]], #801).** A node can
  attach secret HANDLE references (`InfraNodeSecretRef`: `handle` + `vaultId`, **no FK** to the
  `SecretItem` — mirrors KB chips + `SecretAuditLog`). Resolved at read to live secret METADATA only
  (handle/label/vaultId, **never a value** — INV-10, [[0061-secret-manager-zero-knowledge]]); a ref
  whose secret is soft-deleted or whose editable handle was renamed away is **dropped**. Attach is
  member-scoped (live `VaultMembership` of the vault, human-only); detach is a plain topology edit.
- **Permissions** ([[0046-roles-permissions-v2]]): `infra:read` to view the map/list/detail (the
  link is hidden without it; the API is the real gate), `infra:manage` for create/edit/connect/
  status/remove. Asset-backed create also needs the relevant `assets:*`. Attaching a secret handle
  also needs `secret:read` **and** live vault membership.

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
| `ipAddress` | `string?` | primary IP, **format-validated** (IPv4/IPv6) on write — no IPAM/registry/`@unique` ([[0090-ipam-validated-ip]] / #847). Agent-promoted from the report: IPv4 wherever the host has one, else its first routable IPv6 (link-local skipped) so a v6-only host still shows an address (#1138); validate-or-drop (ADR-0074 §3 / #1081). |
| `ipAddressSource` | `InfraNodeIpSource` | `@default(AGENT)`; who owns `ipAddress` — `AGENT` (each report overwrites) vs `MANUAL` (a human edit the agent never clobbers, stamped server-side on an IP edit). #1081. |
| `shortcuts` | `jsonb?` | `[{ label, url }]` SSH/web-UI/console links (max 20; URLs zod-validated). |
| `specs` | `jsonb?` | loose per-kind attributes (ADR-0007 posture; per-kind validation deferred). On an agent-reported host this is the full inventory blob (`host`/`software`/`reportedAt`) — **detail-only**, never on the list row (#1135). It may also carry `agentSkew` (#1138): the bounded list of report ROOT keys this build did not understand and dropped, plus whether the agent is a newer build than the server. Self-healing (the blob is rewritten every report) and never copied into the linked `Asset.specs`. |
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

> **No reporter column, deliberately (#1134).** The `POST /infra/report` throttles bound agent row
> creation by RATE, in memory, keyed on the server-resolved principal — so nothing on the row records
> which service account reported it. Agent writes stay **unattributed**, exactly as ADR-0074 §8's
> #1136 correction states. Per-reporter attribution becomes worth its migration only once
> `install.sh` stops writing the same operator token on every host (#1146).

## Endpoints

`apps/api/src/infra/` (`InfraModule`), all gated server-side (`infra:read` / `infra:manage`):

- `GET /infra/nodes?kind=&status=&state=` — list (plain `InfraNodeListItem[]`, **no page envelope** —
  the estate is small by design; excludes soft-deleted, newest first). Each row is the node PLUS the
  linked Asset's inventory `assetName` and its active `owners`, joined in ONE query and flattened
  (#750) — a soft-deleted asset never leaks its name. **Minus `specs`** (#1135): a lean `select`
  projection omits the blob, because on an agent-reported host it is the whole inventory
  (installed-software list included) and this endpoint is polled — every 40s by the PENDING review
  tray, every 5s by the create-agent wizard. Nothing renders `specs` from a list row; read it from
  the drill-in below. A `take`/pagination pass is still a tracked follow-up.
- `GET /infra/nodes/:id` — the enriched **drill-in** (`InfraNodeDetail`): the node plus its
  asset-backed payoff — `assetName`, active `owners`, published `articleLinks`, `secretRefs`
  (HANDLES only, never values — INV-10, [[0061-secret-manager-zero-knowledge]]; resolved from the
  node's secret links, dangling refs dropped — [[0073-infra-node-secret-linkage]], #801),
  `shortcuts`, IP, `children` (active inverse RUNS_ON), and `ipConflict` (a display-only soft signal:
  other LIVE nodes with the same `ipAddress` — [[0090-ipam-validated-ip]], #847).
- `POST /infra/nodes/:id/secrets` / `DELETE /infra/nodes/:id/secrets` — attach / detach a secret
  HANDLE reference (`{ handle, vaultId }` in the body; never a value). Attach needs `infra:manage` +
  `secret:read` **and** live vault membership (human-only); detach needs only `infra:manage`. Both
  return the node's updated resolved `secretRefs` ([[0073-infra-node-secret-linkage]], #801).
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
- List-row asset name/owner enrichment (#750); deep network model (VLAN/ports/IPAM); metrics/alerting;
  per-kind `specs` validation; multi-board layouts; a `SERVICE` kind linked to [[application]]; a
  dedicated `InfraNodeHistory`. → [[0070-infra-topology-graph]] "Future".

Related: [[infra-edge]] · [[asset]] · [[asset-assignment]] · [[asset-centric]] · [[user]] ·
[[0070-infra-topology-graph]] · [[0019-asset-assignment-integrity]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] ·
[[0061-secret-manager-zero-knowledge]] · [[0048-service-accounts]]
