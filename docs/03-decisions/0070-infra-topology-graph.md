---
title: "ADR-0070: Infra topology graph — a generic visual CMDB of the server estate (InfraNode + InfraEdge)"
tags: [adr, infra, topology, graph, cmdb, asset, agent, backend, frontend, shared]
status: proposed
created: 2026-06-23
updated: 2026-06-23
deciders: [Joaquín Minatel]
---

# ADR-0070: Infra topology graph — a generic visual CMDB of the server estate

## Status

**proposed** — 2026-06-23. Pre-build design. Reviewed before a line of code by a senior
infrastructure architect (ServiceNow/Device42/NetBox background); this revision folds in that review.
Builds on [[asset-centric]], [[0005-id-strategy]], [[0006-soft-delete-and-auditing]],
[[0007-flexible-asset-specs-jsonb]], [[0019-asset-assignment-integrity]] (the timestamped-join pattern
the edges reuse), [[0041-soft-delete-reuse-and-restore]], [[0046-roles-permissions-v2]],
[[0048-service-accounts]] (the auth pattern the v2 reporting agent extends),
[[0053-async-workers-bullmq-valkey]] (the substrate the agent feeds),
[[0061-secret-manager-zero-knowledge]] (secrets attachable to asset-backed nodes).

This is a **new major** for lazyit. The ADR fixes the **data model and the phasing
(MVP → v1 → v2 agent → future)** so the model is never re-migrated, while scoping what each phase ships.

## Context

lazyit already inventories *things* (`Asset` + free-form `AssetCategory` + `specs` jsonb) and tracks
*who owns them* (`AssetAssignment`). What it cannot express is **how those things relate**: which VM
runs on which host, which container on which host, what belongs to which cluster, what connects to the
switch, what backs up to where, what depends on what. The only asset-to-X edges today are
asset→model/location/owner/history. There is **no asset↔asset topology**.

The goal is a **generic visual CMDB**: a free-move canvas (flow-diagram style — draggable nodes,
persisted positions, edges, status colors) that maps **whatever estate the operator has** — servers,
Raspberry Pis, VMs, containers, switches, NAS, clusters, cloud, *or anything else* — and eventually keeps
itself current via an installable reporting agent.

> **The model is generic on purpose (CEO decision, 2026-06-23).** The use cases below (Kubernetes,
> Proxmox, vMotion, backups) are **illustrations to stress-test the model, not built-in concepts.** The
> product does not "know about" k8s or any specific platform. The primitives are generic nodes and
> generic typed edges; any real-world topology — homelab or enterprise, container or bare-metal —
> decomposes onto them. We deliberately do **not** ship platform-specific node kinds (POD, NAMESPACE,
> etc.); those map onto the generic kinds or are added later as trivial enum values.

### Use cases that stress-test the model (illustrations, not features)

**UC-1 — Reference homelab (the kind of estate the ICP actually has):**

```
Cisco switch ──────────────(everything CONNECTS_TO it)
│
├── Raspberry Pi 3 (appliance) ── runs Pi-hole (router DNS)
├── Host cluster (3 old laptops)
│   ├── pve1 ── VM ── [app containers]
│   └── pve2 ── 2 containers + 1 VM (the VM BACKS_UP_TO the NAS)
└── NAS ── docs / backups / keychains
```

**UC-2 — Irregular nesting:** host → VM → container is 3 levels; container-directly-on-host is 2.
A fixed N-level schema is wrong → recursion + edges, not depth columns.

**UC-3 — The graph (not tree) proof:** a workload that *runs on* one node **and** *belongs to* a
logical group at the same time has **two parents**. A `parentId` cannot express it. This is why the
model is **edge-based**, generically — independent of any orchestrator.

**UC-4 — Movement has history:** a VM migrates host A→host B. The host relationship must be a
**timestamped edge** (close one, open the next), so the move is auditable. Also: a workload that may run
on any of N hosts (HA) → no fixed parent.

**UC-5 — The honest freshness non-goal at v1:** the ephemeral layer (containers especially) churns. Hand
-maintaining it is futile; real upkeep needs the **reporting agent (v2)**. v1 maps the durable spine by
hand; the agent makes it live.

### Constraints that shape the model

- **Not every node is an inventory Asset, but by default it is.** A host, NAS, switch, Pi or a
  long-lived VM *is* an asset (owner, KB, secrets, warranty). An ephemeral container usually is not.
- **Servers-only graph (CEO).** "Who owns this" is answered through the node's linked
  `Asset → AssetAssignment`, **not** a graph edge to a person. No employee/everything-graph.
- **The eventual agent is hybrid-with-review (CEO).** It auto-discovers, but new nodes land in a PENDING
  tray before joining the official map. Provenance/lifecycle columns exist from day 1; the agent is v2.
- **Reuse, don't reinvent.** Edges = the timestamped-join pattern of `AssetAssignment`
  ([[0019-asset-assignment-integrity]]). Loose attrs = `specs` jsonb ([[0007-flexible-asset-specs-jsonb]]).
  Soft-delete/audit per [[0006-soft-delete-and-auditing]]. Agent auth extends [[0048-service-accounts]].

> **CEO decisions, verbatim (2026-06-23):**
> - *(genericity)* *"…la idea es que el caso de uso sea cualquiera donde vos tengas servidores, raspberries,
>   VMs, containers o lo que sea."* — examples are examples; the model is generic.
> - *(scope)* *"Employees no, solo SERVERS."*
> - *(agent)* hybrid with review.
> - *(asset linkage)* *"…no manejas en inventario un container … pero sí inventarias una NAS, una raspi,
>   una VM … capaz alguien es dueño de esa VM. Que cada uno lo elija, por defecto, todo empieza siendo un
>   asset."*

## Decision

Introduce a **generic topology graph** — `InfraNode` (the things) + `InfraEdge` (typed, timestamped
relationships) — rendered on a free-move canvas. A node is **Asset-backed by default** (inherits
owner/KB/secrets/warranty/shortcuts) and can be detached to a graph-only node for ephemerals.

Rejected: overloading `AssetCategory` (pushes graph rules into a flat taxonomy); a `Server` table 1:1
with `Asset` (containers/pods aren't assets, and it's still a tree); platform-specific node kinds (not
generic). See Alternatives.

### 1. The model

```prisma
// A node: anything that appears on the map. Asset-backed by default.
model InfraNode {
  id              String          @id @default(cuid())

  kind            InfraNodeKind                            // generic, extensible (see §2)
  label           String                                   // canvas display name
  status          InfraNodeStatus @default(UNKNOWN)         // ONLINE | OFFLINE | UNKNOWN

  // Asset linkage — DEFAULT-ON. Create wires a backing Asset unless "track as asset" is off.
  // SetNull: deleting the asset detaches, never deletes the node (audit > strict integrity).
  assetId         String?
  asset           Asset?          @relation(fields: [assetId], references: [id], onDelete: SetNull)

  // Access surface (NOT a network model — see scope cuts).
  ipAddress       String?                                  // primary IP, label-only (no validation/IPAM)
  shortcuts       Json?                                    // [{ label, url }] — SSH/web UI/console links
  specs           Json?                                    // loose per-kind attrs (ADR-0007 posture)

  // Canvas layout (free-move). v1: one board, x/y on the node. Multi-board => join later.
  x               Float?
  y               Float?

  // Provenance + lifecycle (columns exist now; the agent that exercises them is v2).
  source          InfraNodeSource @default(MANUAL)          // MANUAL | AGENT
  state           InfraNodeState  @default(CONFIRMED)        // CONFIRMED | PENDING (review tray)
  reportingSource String?                                   // which agent/host reported it (dedup scope, see §4)
  externalId      String?                                   // platform id (vmid/container-id) for reconciliation
  lastReportedAt  DateTime?                                 // agent liveness; stale => OFFLINE

  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  deletedAt       DateTime?                                 // soft delete = off the map, history kept

  edgesFrom       InfraEdge[]     @relation("EdgeSource")
  edgesTo         InfraEdge[]     @relation("EdgeTarget")

  @@index([assetId])
  @@index([kind])
  @@index([state])               // the PENDING review-tray query
  // v2: partial UNIQUE (reportingSource, externalId) WHERE both NOT NULL — added with the agent
  // migration (the columns exist now, so it is a forward-only add, NOT a re-model). See §4.
  @@map("infra_nodes")
}

// An edge: a typed, timestamped relationship. Same DNA as AssetAssignment (ADR-0019).
model InfraEdge {
  id          String        @id @default(cuid())
  sourceId    String
  source      InfraNode     @relation("EdgeSource", fields: [sourceId], references: [id], onDelete: Cascade)
  targetId    String
  target      InfraNode     @relation("EdgeTarget", fields: [targetId], references: [id], onDelete: Cascade)
  kind        InfraEdgeKind                                 // generic, extensible (see §3)
  startedAt   DateTime      @default(now())
  endedAt     DateTime?                                     // null = active; migration = close one, open next

  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  // Raw-SQL partial UNIQUE (sourceId) WHERE endedAt IS NULL AND kind = 'RUNS_ON' — "one active host
  // per node". ONLY RUNS_ON is constrained; MEMBER_OF / CONNECTS_TO / DEPENDS_ON / BACKS_UP_TO are
  // legitimately many. Prisma can't express partial indexes → added in the migration
  // (docs/05-runbooks/prisma-migrations.md).
  @@index([sourceId])
  @@index([targetId])
  @@index([kind])
  @@map("infra_edges")
}
```

Edges `Cascade` on node delete (an edge is meaningless without both endpoints and is not an audited
domain entity — the node and its `Asset` carry durable history). Nodes soft-delete; the `Asset` behind a
node is never hard-deleted.

### 2. Node kinds — generic and extensible

`InfraNodeKind` enum, v1 set: `PHYSICAL_HOST`, `VM`, `CONTAINER`, `CLUSTER` (any logical grouping of
hosts/nodes), `NETWORK_DEVICE`, `STORAGE`, `APPLIANCE`, `OTHER`. The enum is extensible — new values are
a one-line migration, never a re-model. **No platform-specific kinds** (no POD/NAMESPACE/K8S_NODE/
CLOUD_ACCOUNT): a k8s pod is a `CONTAINER`, a namespace/cloud-account is a `CLUSTER`/`OTHER` grouping.
The platform detail, if wanted, lives in `specs` or `label`.

### 3. Edge kinds — generic, extensible, with explicit direction

`InfraEdgeKind` v1 set:

| kind | meaning | direction (source → target) | cardinality |
| --- | --- | --- | --- |
| `RUNS_ON` | source is hosted/executed by target | child → host (VM → host) | one active per source |
| `MEMBER_OF` | source belongs to a logical group | member → group (host → cluster) | many |
| `DEPENDS_ON` | source needs target to function | dependent → dependency | many |
| `BACKS_UP_TO` | source's data is backed up to target | backed-up → backup target | many |
| `CONNECTS_TO` | network adjacency (cosmetic v1, no port/VLAN) | **symmetric** — store the lower `id` as source, canonicalize so the pair is unique regardless of input order | many |

Adding `BACKS_UP_TO`/`DEPENDS_ON` fixes the gap where UC-1's reference diagram drew a `BACKS_UP_TO` edge
the model couldn't express. The (sourceKind → targetKind) pairs are documentation, not DB constraints —
the API validates plausible pairs (e.g. a `CONTAINER` does not `RUNS_ON` a `NETWORK_DEVICE`) and warns
rather than blocks, to stay generic.

### 4. The reporting agent — hybrid with review + a trust model (v2, designed now)

A future installable client (one per host) auto-discovers workloads and posts them. The model is ready:
`source=AGENT`, `state=PENDING` (lands in a **review tray**, not the live map, until an operator
confirms), `reportingSource` + `externalId` for idempotent reconciliation, `lastReportedAt` for liveness
(stale → `OFFLINE`). It feeds the existing async substrate ([[0053-async-workers-bullmq-valkey]]).

**Trust model (sketch — fixed now because it shapes the schema, built in v2):**
- **Enrollment**: each agent is a scoped credential modeled on [[0048-service-accounts]] — an
  admin issues an enrollment token; the agent holds a per-host key, never a user/admin credential.
- **Authorization**: an agent may **only create/update PENDING nodes it reported** and refresh their
  `status`/`lastReportedAt`. It **cannot** mutate CONFIRMED nodes, edges, Assets, secrets, or KB, and
  cannot confirm its own discoveries — a human with `infra:manage` confirms.
- **Dedup / merge-on-confirm**: identity is `(reportingSource, externalId)` (a `vmid 100` on host-A ≠
  `vmid 100` on host-B). On confirm, if the discovered node matches an existing hand-created node
  (heuristic: same `ipAddress`/`label`/`externalId`), the UI offers **link (merge)** vs **create new** —
  the classic duplicate-CI guard. The composite partial-unique index lands with this v2 work.

**No agent code ships before v2.** The columns sit nullable/defaulted until then.

### 5. Asset linkage — default-on, per-node flag, no orphans

Creating a node defaults to **Asset-backed**: the create flow links (or creates) an `Asset`, so the node
immediately has owner (via `AssetAssignment`), KB links, secrets and warranty. Toggle **"track as asset"
off** → graph-only node (right for ephemeral containers). **Detach semantics (fixes the orphan
contradiction):** toggling off an auto-created Asset **soft-deletes that Asset** (it does not linger in
inventory owned-by-nobody); if the Asset pre-existed and was merely linked, detach only nulls `assetId`
and leaves the Asset intact. A node **reads inventory facts through `assetId`**; **`label` is the canvas
display name and always wins for display**, `asset.name` is shown as a secondary "inventory name" in the
detail panel — no silent copy, no drift.

### 6. Frontend — the canvas + the payoff in the MVP

A gridded, free-move board: draggable nodes (x/y persisted), flow-style edges colored by kind, node
color by status, hover = quick facts, click = a **drill-in panel that, from the MVP, surfaces the
asset-backed payoff**: owner, KB links, secret references, shortcuts (SSH/web), IP, created-at, and the
children list derived from `RUNS_ON` edges. This panel is the entire reason to build this over a Draw.io
diagram, so it ships in the MVP, not v1. **React Flow** is adopted as the one new frontend dependency,
scoped to this screen (confirm version via Context7 before install). Nav: **Assets › Servers** (filtered
list) and **Assets › Diagram** (the canvas). A static HTML tree is rejected (can't do free-move/pan/edges).

### 7. Impact / blast-radius — the query that justifies a graph

A graph beats a picture only if you can ask **"if this node goes down, what is affected?"** v1 ships
`GET /infra/nodes/:id/impact` — a recursive traversal over inverse `RUNS_ON`/`DEPENDS_ON` edges returning
the downstream set, surfaced in the UI as a highlight on the canvas. This is named as a v1 feature, not
an afterthought.

### 8. Permissions

New `infra:read` / `infra:manage` in the [[0046-roles-permissions-v2]] catalog (asset-backed node
create also needs the relevant `assets:*`). Confirming a PENDING node needs `infra:manage`.

## Phasing

- **MVP** — `InfraNode` + `InfraEdge` + migration; manual canvas for `PHYSICAL_HOST`/`VM`/`CONTAINER` +
  `RUNS_ON`; default-asset linkage **with the owner/KB/secret/shortcut drill-in panel** (the payoff);
  drag/persist x-y. Proves the model end-to-end *and* beats Draw.io on day one.
- **v1** — full generic kinds (CLUSTER, NETWORK_DEVICE, STORAGE, APPLIANCE, OTHER); `MEMBER_OF`,
  `DEPENDS_ON`, `BACKS_UP_TO`, `CONNECTS_TO`; **impact/blast-radius query**; manual status toggle; Servers
  list; kind/status **filters + Meili-backed search**; edge history (migration); soft-delete/restore.
- **v2 (the agent epic — its own major)** — installable client + enrollment (ADR-0048 pattern), hybrid
  auto-discovery → PENDING tray, live status via `lastReportedAt`, reconciliation + merge-on-confirm by
  `(reportingSource, externalId)`, the composite unique index.
- **Future** — network depth (VLAN/ports/subnets, real IPAM), metrics/telemetry overlay, alerting,
  per-kind `specs` schema validation (existing `TODO(specs)` debt), multi-board layouts, `SERVICE` node
  kind linked to the existing `Application` entity, dedicated `InfraNodeHistory`.

## Scope cuts (explicit non-goals)

- **No employee/everything-graph** — servers only; ownership via the linked Asset.
- **No platform-specific concepts** — generic kinds/edges only; k8s/cloud/backup are use-case
  illustrations, never built-in types.
- **No deep network model** — `ipAddress` (label-only) + `shortcuts`; `CONNECTS_TO` is cosmetic; no
  VLAN/port/subnet/IPAM/discovery in v1.
- **No automatic freshness before v2** — the ephemeral layer is hand-entered if at all until the agent.
- **No per-kind `specs` schema, no metrics/alerting** — this is a CMDB/map, not a monitoring product, yet.

## Consequences

**Positive:** one generic graph models any estate at any depth and never re-migrates when the agent or
new kinds arrive; reuses Asset/assignment/KB/secret machinery via the default-asset link; edges carry
migration history (ADR-0019 pattern); the impact query gives the graph a reason to exist; the MVP already
beats a diagram because the payoff panel ships first.

**Negative / risks:** two new tables + one new frontend dependency (React Flow); freshness is hand-driven
until v2 (accepted — the agent is a planned major, not an afterthought); a canvas needs filters/search to
stay readable (v1 includes both); the agent's trust surface is real (sketched here, hardened in v2 with
Sentinel review).

## Alternatives rejected

- **Overload `AssetCategory` with containment rules** — pushes graph semantics into a flat taxonomy;
  more complex, not less (CEO agreed).
- **`Server` table 1:1 with `Asset` + `parentId`** — fails UC-3 (two parents → not a tree) and the
  ephemeral case (containers aren't assets).
- **Everything-is-an-Asset (containers included)** — pollutes inventory with churning rows; the
  default-asset *toggle* gives the benefit without the pollution.
- **Platform-specific node kinds (POD/NAMESPACE/K8S_NODE/CLOUD_ACCOUNT)** — couples the model to
  orchestrators the product shouldn't "know about"; generic kinds + `specs` cover them.
- **Static nested-tree UI** — cannot deliver free-move/pan/edges.
