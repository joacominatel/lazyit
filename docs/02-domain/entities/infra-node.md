---
title: InfraNode
tags: [domain, entity, infra, topology]
status: accepted
created: 2026-06-23
updated: 2026-08-09
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
- **accumulates** N [[infra-node-fact-change]] (`factChanges`, `onDelete: Cascade`) — the append-only
  record of what actually MOVED on this node, written by the agent ingest path only when a diff
  exists ([[0074-server-reporting-agent]] §3 amendment, #1143).
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
- **A patch may attach or detach, but never RE-POINT** ([[0070-infra-topology-graph]] §5 note,
  #1117). `assetId: null` detaches (above); an `assetId` on a node that carries **none** attaches,
  and is checked with the same soft-delete-scoped `assertExists` `createNode` uses — a **discarded**
  asset is a clean `404` instead of landing in the column (the FK only requires the row to *exist*,
  and a discarded asset's row does). Sending an `assetId` to a node that **already has** one is a
  `400` — it used to drop the old link without running the detach above, so an **auto-created** Asset
  it replaced was left live in inventory owned by nobody. The remedy is the two-step —
  `assetId: null`, then the new id — which runs the §5 semantics on the outgoing asset with a human's
  intent behind them instead of letting a machine decide.
- **`label` always wins for display.** The canvas display name is `label`; the linked
  `asset.name` is shown only as a secondary "inventory name" (`assetName` on the detail read) — no
  silent copy, no drift.
- **Soft delete = off the map, history kept** ([[0006-soft-delete-and-auditing]]). `DELETE` sets
  `deletedAt` (node off the canvas), `POST …/restore` clears it (back on the map). The Asset behind a
  node is never hard-deleted.
- **Provenance + lifecycle columns are LIVE** ([[0070-infra-topology-graph]] §4, [[0074-server-reporting-agent]]).
  `source` (MANUAL | AGENT), `state` (CONFIRMED | PENDING — the review tray), `reportingSource`,
  `externalId`, `lastReportedAt`, `agentVersion` are filled by the installable reporting agent (auth
  via [[0048-service-accounts]]), reconciled on the composite partial-unique
  `(reportingSource, externalId)` index over non-deleted rows. ~~No agent code ships in v1~~ — the
  agent shipped; this bullet described the pre-ADR-0074 state.
- **TWO reporting platforms since #1144** (ADR-0074 §6/§7 amendment, 2026-08-02): Linux (systemd
  timer, `install.sh`) and Windows (Scheduled Task as `NT AUTHORITY\SYSTEM`, `install.ps1`). Nothing
  in this entity is per-platform — the wire contract has been OS-neutral since #1138, and the two
  collectors produce the same shapes — but three columns are worth reading with it in mind:
  `externalId` (below), `specs.host.os.family` (`windows` on those rows, and the one field every
  consumer branches on), and `specs.software[].source`, which is `registry` for a Windows host
  because the list comes from the Uninstall hives rather than a package manager.
- **The report PROPOSES a `kind` on discovery, and never re-classifies (ADR-0074 §3 amendment, #1139).**
  A newly-discovered host's `kind` is mapped from the reported `host.virtualization` / `host.chassis`
  by the shared `inferNodeKind` (`none` → `PHYSICAL_HOST`, any hypervisor → `VM`,
  `docker`/`lxc`/`wsl` → `CONTAINER`); a report with **no evidence** — `chassis: unknown`, or a pre-v2
  agent — keeps the `PHYSICAL_HOST` default rather than guessing. It is read on the **create branch
  only**: a node that already exists is never re-kinded by a report, confirmed or not. The human's
  `kind` override at the confirm gate is the correction path.
- **A reported container becomes a CHILD node (#1139).** When a report carries `host.containers[]`,
  each entry is a `CONTAINER` node (`source=AGENT`, `state=PENDING`) joined to the reporting host by
  an **active `RUNS_ON`** [[infra-edge]] — the agent's first real topology, and what makes the
  blast-radius traversal meaningful without hand-drawing. Its `externalId` is
  `<host externalId>/container/<name>`: keyed on the container **name** (a runtime container id is
  regenerated by every recreate, so an id key would mint a duplicate proposal per deploy) and
  **scoped to the host** (names are unique only within one runtime). A container the reporter stops
  listing goes `status=OFFLINE`; it is **never** auto-deleted — Discard stays the human's call — and
  the same name returning refreshes that same node back ONLINE. An **absent** `containers` key means
  the collector never probed and nothing is touched; `[]` means it probed and found none.
- **A reported hypervisor GUEST becomes a CHILD node too ([[0095-hypervisor-guest-inventory]], #1217).**
  When a report carries `host.guests[]` (the host facet rides `host.hypervisor` beside it — platform,
  version, cluster/node name), each entry is a child node in a **second key namespace beside
  `/container/`**: `externalId = <host externalId>/guest/<ref>` (shared `guestExternalId`), where
  `ref` is the platform's own **stable per-host handle** — the Proxmox VMID, the Hyper-V VM GUID, the
  libvirt domain UUID. Ref-keyed rather than name-keyed, the exact **inverse** of the container
  tradeoff: guests get renamed without being re-created, so the name would mint duplicates and the
  handle never does. The child's `kind` derives from the guest's own nature via shared
  `guestNodeKind` — `qemu`/`hyperv`/`libvirt` → `VM`, `lxc` → `CONTAINER` — never a hardcode; both
  land on already-plausible `RUNS_ON` edges. Same reconcile discipline as the container child (the
  `applyContainerTopology` shape parameterized): `source=AGENT, state=PENDING` into the existing
  tray, `defaultTrackAsAsset` OFF, each new child charges an enrollment slot (**skip, don't break** —
  a 200-VM host ramps in over two windows rather than inventing a false outage), a **vanished guest
  goes `OFFLINE`** and is never auto-deleted, `RUNS_ON` self-heals via `openMissingRunsOnEdges`,
  absent `guests` ≠ empty `guests`. **Chassis is never written for a child** ([[0093-chassis-routing-and-asset-adoption]]
  §2) — a guest's chassis arrives only when its own in-guest agent reports.
- **The guest identity join: corroborated SMBIOS UUID, the in-guest node wins (ADR-0095 §6).** A
  `/guest/` child stores the hypervisor-assigned `smbiosUuid` (normalized lower-case) and `macs` in
  its specs blob for exactly one purpose. When a report's own `host.identifiers[]` carries an
  `smbios-uuid` matching a live `/guest/` child **and** at least one MAC corroborates
  (`canonicalMac` both sides), the in-guest node and the host-proposed child are the same machine —
  and **the guest's own agent-reported node is canonical** (it holds the machine-id, the software,
  the real evidence): the child is **absorbed into it** via the existing `mergeNodeInto`, and the
  `RUNS_ON` edge lands on the canonical node. UUID alone **never** merges (clones demonstrably
  duplicate BIOS UUIDs) — an uncorroborated match surfaces as the display-only duplicate-suspicion
  hint, an operator call. Without an in-guest agent the child **is** the guest's node. A cross-node
  **migration** inside a PVE cluster appears as old child OFFLINE on node A + new child on node B,
  surfaced as duplicate-suspects for a one-click operator merge — **no auto-merge in v1**, same
  reasoning as ADR-0093's no-retroactive-re-linking.
- **A host in machine-id COLLISION has no container children at all (#1158).** The child key above is
  derived from the **reported** `externalId`, which two clones share, so both would compute identical
  container keys and each report would retire the other's still-running children. The #1141 collision
  branch therefore skips container reconciliation entirely: a colliding host's containers go
  **untracked** until its `/etc/machine-id` — on Windows, its `MachineGuid` — is fixed, then tracking
  resumes on its own. The same property holds for `/guest/` children ([[0095-hypervisor-guest-inventory]]
  "Known limitations"): a hypervisor host in collision reports no guests until its identity conflict
  is resolved. A Windows image prepared with `sysprep /generalize` regenerates that key per
  clone and never enters this branch at all, which is the asymmetry the ADR-0074 §3 amendment for
  #1144 documents: the Linux baked-machine-id trap has no automatic Windows equivalent. Deliberate and
  deferred (re-deriving the key would re-key every existing child); the guarantee that a colliding
  host's report never retires its peer's children is pinned by test.
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
| `ipAddress` | `string?` | primary IP, **format-validated** (IPv4/IPv6) on write — no IPAM/registry/`@unique` ([[0090-ipam-validated-ip]] / #847). Agent-promoted from the report: IPv4 wherever the host has one, else its most **stable** routable IPv6 — link-local, temporary (RFC 4941) and deprecated addresses skipped, global unicast preferred over ULA — so a v6-only host shows an address that keeps resolving (#1138); validate-or-drop (ADR-0074 §3 / #1081). |
| `ipAddressSource` | `InfraNodeIpSource` | `@default(AGENT)`; who owns `ipAddress` — `AGENT` (each report overwrites) vs `MANUAL` (a human edit the agent never clobbers, stamped server-side on an IP edit). #1081. |
| `shortcuts` | `jsonb?` | `[{ label, url }]` SSH/web-UI/console links (max 20; URLs zod-validated). |
| `specs` | `jsonb?` | loose per-kind attributes (ADR-0007 posture; per-kind validation deferred). On an agent-reported host this is the full inventory blob (`host`/`software`/`reportedAt`) — **detail-only**, never on the list row (#1135). **Written only when its facts CHANGE (#1153)**, not on every check-in: the column is a multi-hundred-KB TOAST value and rewriting it unchanged was pure churn. Two consequences worth knowing before reading a stored blob: `reportedAt` dates the **facts** (when this snapshot was collected), not the last check-in — liveness is `lastReportedAt` below — and a node stored before #1153 that holds a package list writes once more on its first post-upgrade report, after which it can be skipped like any other (one that holds none compares equal immediately and never pays it). A companion key `softwareHash` (#1142) carries the **server's** fingerprint of the stored package list, present only while a list is. What lets a report OMIT an unchanged list without the absence being read as "no software" is `softwareState: 'unchanged'` — the server reads the absence from that field and nothing else. `softwareHash` is corroboration rather than authority: it is read on the omitted-list branch only, to tell an honest delta from a claim the server cannot vouch for (which is answered with `softwareResend`, never by wiping — and so is an `unchanged` claim that arrives with NO fingerprint, since a claim the server cannot check is the least corroborated of all, not the most trusted), and it is what lets the write skip work for a client that sends no fingerprint of its own. An agent only starts omitting once an ack has carried `softwareDelta: true` (#1142): the contract root is a loose `z.object()`, so a server that predates the field would STRIP `softwareState`, see no `software` key and clear the stored list for good — the omission is therefore gated on positive evidence, never on the agent's own belief. It may also carry the two REPORT diagnostics (#1138): `diagnostics` (`{ warnings, privileged, durationMs }` — what the collector could not do, present whenever the agent sent it) and `agentSkew` (`{ droppedPaths?, coercedPaths?, agentAhead, serverVersion }` — the bounded wire paths this build dropped or had to coerce, at any depth, plus whether the agent is a newer build than the server; present only when there was skew). Both self-heal (they are part of what the write path compares, so the first clean report rewrites the blob without them), neither is ever copied into the linked `Asset.specs` — nor is `softwareHash` — and none is rendered today: the inventory panel excludes them from its custom-fields fallback rather than dumping them. A further key joins them on a node whose machine-id collided (#1141): `identityConflict` (`{ reportedExternalId, peerNodeId, peerLabel, discriminator, detectedAt }`), which follows the same rules — node-only, never copied to the Asset, and not rendered anywhere yet. Unlike the others it is **re-stamped on every report** for as long as the collision lasts (`detectedAt` keeps the FIRST detection), because a marker written once would be wiped the first time anything else in the blob moved; it still self-heals, since a clone given a real machine-id stops taking that branch and the next write drops it. An ARCHIVED node may also carry `_infraMergedInto` (`{ nodeId, label, externalId, reportingSource, at, byUserId?, replacedTargetKey? }`) — the merge provenance, and the only audit trail a re-key has. `externalId`/`reportingSource` there are the key the archived row gave up (its own columns are cleared so it stays restorable); `replacedTargetKey` is present only when the merge overwrote a reporting key the target already had. On an agent-reported CONTAINER child (#1139) the blob is `{ container, reportedAt }` instead — deliberately carrying **no** `host` key, so the host projection declines it and a dedicated **container** projection (`getAgentContainerFacts`) renders it instead: name, image, image digest, runtime state, container id and the published-ports table, on the node drill-in and on a confirmed child's Asset detail page. That second panel is not decoration — without it both surfaces fell through to the raw **Custom fields** grid, which `JSON.stringify`s an object, so a confirmed container's whole blob rendered as one line of JSON. A **`/guest/` child** ([[0095-hypervisor-guest-inventory]]) follows the same pattern with `{ guest, reportedAt }` — deliberately no `host` key either, and it is where the child keeps the `smbiosUuid` + `macs` the §6 identity join corroborates against. |
| `x` / `y` | `float?` | canvas position (free-move board; persisted on drag-stop). |
| `source` | `InfraNodeSource` | `@default(MANUAL)`; AGENT in v2. |
| `state` | `InfraNodeState` | `@default(CONFIRMED)`; PENDING = the v2 review tray. |
| `reportingSource` | `string?` | which agent/host reported it (the dedup scope; a container child carries its host's). |
| `externalId` | `string?` | the reconciliation key. A reported HOST: its `/etc/machine-id` on Linux, `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` on Windows (#1144; macOS platform UUID is reserved, no collector ships) — **except** on a host whose machine-id collided with one already in use (a cloned VM template), where it is the derived `<machine-id>#<serial-or-MAC>` (ADR-0074 §3 / #1141) and the value the host actually claims is kept in `specs.identityConflict.reportedExternalId`. A reported CONTAINER child: `<host externalId>/container/<name>` (#1139) — name-keyed so a recreate is not a duplicate, host-scoped so two hosts' `redis` stay two nodes. A reported GUEST child: `<host externalId>/guest/<ref>` ([[0095-hypervisor-guest-inventory]], shared `guestExternalId`) — **ref**-keyed (PVE vmid, Hyper-V VM GUID, libvirt domain UUID) so a rename is not a duplicate, host-scoped so vmid `101` on two cluster nodes stays two keys. Neither separator can occur in a host key, so the three spaces never collide on the shared partial unique index. |
| `lastReportedAt` | `datetime?` | agent liveness (stale → OFFLINE). Advances for a host on every check-in and for a container or guest child on every report that still lists it. |
| `agentVersion` | `string?` | the reporting agent's build at its last check-in (#907); null for manual/pre-stamp nodes. |
| `chassis` | `string?` | what the host physically **is** — `laptop` / `desktop` / `server` / `vm` / `container` / `unknown`, written from `host.chassis` on **every** agent report, create and refresh alike ([[0093-chassis-routing-and-asset-adoption]] §2 / #1198). **Agent-owned**: chassis is a *fact* (the `ipAddress` class), not curation (the `kind` class), so a re-image or a board swap changes the truth and the column follows — there is deliberately **no `chassisSource`** and no `MANUAL` counterpart, because chassis is never on the create/update DTOs and so there is no human write to protect. `String?` rather than a Prisma enum on purpose: the wire vocabulary `.catch()`es an unrecognised value so a report is never rejected for one, and a DB enum would turn that same value into a write error on the hot report path; validation lives in shared zod at the write boundary and the read is tolerant (`AgentChassisSchema.nullish().catch(null)`). An **absent** chassis never clears a stored one (a downgraded agent must not un-heal the estate); an explicit `unknown` does write, because "the probe did not run" is a different fact from any form factor. Null for a manual node, for a CONTAINER child (whose blob carries no `host` key at all — #1139), for a GUEST child (chassis is never written for a child — [[0095-hypervisor-guest-inventory]] §5, consistent with ADR-0093 §2; a guest's chassis arrives when its own in-guest agent reports) and for every row predating #1198, which self-heals on that host's next report — no backfill. Read by the canvas, which hides `laptop`/`desktop` by default (§5), and usable as an auto-confirm rule condition (§6). |
| `agentPolicy` | `jsonb?` | this node's own agent-policy override — the NARROWEST of the three #1140 scopes (instance default < service account < node). A partial `AgentPolicyOverride` (zod in `@lazyit/shared`): a closed set of booleans, integers and **glob** strings, never a command/script/path/regex. Null = "adds no override", which is every pre-#1140 row. Read-TOLERANT — an unparseable blob resolves as no override rather than failing a report. Written only by `PUT /infra/nodes/:id/agent-policy` (human-only); **no editor ships in this build** — the UI edits the instance default. |
| `policyRevision` | `int?` | the policy generation the agent last **echoed** (#1140) — the acknowledgement half. Equal to the instance revision (`GET /infra/agent-policy`) = *applied*; lower = *pending* until the next check-in. Null for a manual node and for any agent predating the policy channel, which must render as "not reporting a policy", never as "pending". |
| `policyAppliedAt` | `datetime?` | when the echoed revision last **changed** — i.e. when this host actually picked a new policy up. Deliberately not advanced on every report, or it would just be a second `lastReportedAt`. |
| `policyStaleAfterSeconds` | `int?` | the staleness threshold last **served** to this node, denormalized so the §4 sweeper judges each node against the cadence it was told instead of one global env var (#1140). A container child inherits its host's. Written only when the report **echoed a `policyRevision`** — an agent that predates the policy channel is not running a served threshold, so its row stays null and keeps the env var — and rewritten on every such report, so it self-heals after any policy change. Null = never served one → the sweeper falls back to `INFRA_AGENT_STALE_AFTER_MS`. |
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

- `GET /infra/nodes?kind=&status=&state=&source=&role=&ids=&assetIds=&q=&limit=&offset=&page=&sort=&dir=` —
  the **paged** list. Since #1152 it is the house `Page<T>` envelope
  ([[0030-list-pagination-contract]] §9): `{ items, total, limit, offset }`, `limit` default 50 and
  hard-capped at 200 (an over-max `limit` is a **400**, never a clamp), `total` counted over the
  **same `where`** as `items` — so it is the count of what the filters asked for, which is what the
  PENDING tray renders as its badge. **This replaced a bare `InfraNodeListItem[]`** — a breaking wire
  change that landed front+back in lockstep, the second one this contract has taken (the first was
  the reverse KB lookups, #220). Excludes soft-deleted.
  - **Row shape.** Each row is the node PLUS the linked Asset's inventory `assetName` and its active
    `owners`, joined in ONE query and flattened (#750) — a soft-deleted asset never leaks its name.
    **Minus `specs`** (#1135): a lean `select` projection omits the blob, because on an agent-reported
    host it is the whole inventory (installed-software list included) and this endpoint is polled —
    every 40s by the PENDING review tray, every 5s by the create-agent wizard. Nothing renders `specs`
    from a list row; read it from the drill-in below.
  - **Filters.** `kind` / `status` / `state` / `source` (`MANUAL` | `AGENT`) are single-value enums,
    unknown → 400. `role=HOST|CHILD` is based on the reporting identity, never on `kind`: CHILD means
    `externalId` contains `/container/` or `/guest/`; HOST means neither (including null). It is applied
    in the database before paging and in the paired count, so 500 newer children cannot starve a host
    lookup. `ids` and `assetIds` are comma-encoded cuid batches (nodes by id, and the nodes
    backing those Assets) — the batch-resolver shape `GET /users?ids=` set (ADR-0030 §6, #961), each
    capped at **200** with over-cap a 400 rather than a silent trim; an unknown id matches nothing.
    `q` is a **server-side**, case-insensitive substring over `label` / `ipAddress` / the linked
    **live** Asset's `name` / each active owner's `firstName`, `lastName` and `email`; an archived
    linked Asset is neither projected nor searchable by name.
  - **Sort allowlist:** `label`, `kind`, `status`, `state`, `ipAddress`, `lastReportedAt`,
    `createdAt`, `updatedAt`; anything else → 400. `assetName` and `owners` are **not** sortable —
    joined relations, deliberately off the allowlist.
  - **Ordering is always a TOTAL order** — the default is `createdAt desc`, and the unique `id desc`
    is appended to **every** sort, allowlisted or default. `createdAt` is not unique and
    [[0095-hypervisor-guest-inventory]] makes ties routine (one hypervisor report enrols up to
    `AGENT_GUESTS_MAX` = 500 guest children in a single write, sharing a millisecond); `label` is not
    unique either. Without the tiebreaker tied rows reorder between two polls with no data change —
    and under a `LIMIT`/`OFFSET` window a partial order duplicates a row onto one page while dropping
    it from another, silently.
  - **No `deleted` slice.** The ADR-0030 §7 "Show archived" param is deliberately **not accepted**
    here: there is no archived-nodes view, so the slice would be contract surface nothing reads. It
    lands with the view that needs it ([[0030-list-pagination-contract]] §11). The endpoint-local
    allowlist is exact: `kind,status,state,source,role,ids,assetIds,q,limit,offset,page,sort,dir`; any
    other key, including `deleted` or a typo, returns 400 before the service is called.
- `GET /infra/graph/nodes` — **the topology canvas's own read** (#1152, same `infra:read` gate).
  Returns `{ items, total, limit, truncated }` — **not** a `Page<T>`, and deliberately so: there is no
  `offset`, because a map missing a node is a *wrong* map rather than a shorter one (the node takes
  its edges with it, and the blast radius read off it comes back smaller than the truth). Each item is
  projected to exactly `{ id, label, kind, status, ipAddress, chassis, x, y }` — the `owners` /
  `assetName` relation joins and the `shortcuts` blob are dropped, because the board never drew them,
  so this complete read is strictly **cheaper** than the paged list read it replaced. Bounded at
  `INFRA_GRAPH_NODES_MAX` = **2000**, with `truncated` **REQUIRED** on the wire (`total >
  items.length`, so an estate landing exactly on the cap reads as complete) — a client must never be
  able to read *absent* as *fine*, and the canvas renders a persistent banner naming both numbers.
  The general rule is [[0030-list-pagination-contract]] §12.
- `GET /infra/graph/edges` — the canvas's bounded active-edge companion (same `infra:read` gate).
  Returns `{ items: InfraEdge[], total, limit, truncated }`, capped at
  `INFRA_GRAPH_EDGES_MAX = 10_000`, with required `truncated`. Only `endedAt = null` edges whose
  source and target nodes are both live are eligible. Rows and count use one identical predicate in
  one transaction; order is `startedAt desc, id desc`, with no offset. Together with the graph-node
  read this makes the canvas data contract a constant **two bounded requests** regardless of node
  count. The per-node edge route below remains the detail/history surface.
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
  `shortcuts`, `assetId: null` to detach, an `assetId` to attach one to a node that has none —
  **re-pointing an already-linked node is a `400`**, #1117).
- `PATCH /infra/nodes/:id/position` — persist canvas `{ x, y }` (debounced on drag-stop).
- `DELETE /infra/nodes/:id` — soft delete (off the map). `POST /infra/nodes/:id/restore` — back on.
- `GET /infra/nodes/:id/impact` — **blast radius** ([[0070-infra-topology-graph]] §7): the downstream
  set reachable over active inverse RUNS_ON/DEPENDS_ON edges, each with a hop `depth`. "What's
  affected if this goes down."
- `GET /infra/nodes/:id/edges?active=` — the node's [[infra-edge]]s (active-only by default; pass
  `active=false` for full history incl. closed migrations).
- `GET /infra/nodes/:id/changes?limit=&cursor=` — the node's [[infra-node-fact-change]] history,
  newest first: what MOVED (a package added/removed/upgraded; the OS, kernel, memory, disk, serial or
  a container's image digest), never one row per report. Keyset-paginated on the append-only `id`;
  `limit` defaults to 50, clamped to 200. Read-only — only the ingest path appends
  ([[0074-server-reporting-agent]] §3 amendment, #1143).
- `GET /infra/nodes/:id/identity-matches` — other LIVE nodes sharing a **burned-in** fact (serial or
  MAC) with this one, from the stored `host.identifiers[]` (ADR-0074 §3 / #1141). The *"this looks like
  `srv-app-04` re-imaged — adopt?"* hint the review tray's merge dialog shows. Read-only, best-effort,
  and **empty** for any node reported by an agent older than contract v2 (no evidence stored) — no
  hint beats a wrong one. Hostname matches are never offered.
- `POST /infra/nodes/:id/merge-into` — `{ targetNodeId }`. Re-key: transplant this node's agent
  reporting key onto the target so future reports land there, then soft-delete this node with the
  merge stamped into its `specs` (`_infraMergedInto`). **Identity moves; curation does not** — the
  target keeps its `label`, `state`, `kind`, position, asset link and edges; its human-`MANUAL` IP is
  never clobbered; its non-agent `specs` keys survive. `infra:manage` + human-only (a reporting agent
  must never re-key its own way out of the PENDING tray). 400 on a self-merge or a source with no
  reporting key. The archived duplicate **is** the audit trail — there is no `InfraNodeHistory`, and a
  soft-deleted node can never be overwritten by a later report. Its own `reportingSource`/`externalId`
  are **cleared** as it is archived (they now live on the target, and the partial-unique index admits
  one holder), so it stays **restorable** per [[0006-soft-delete-and-auditing]] — restoring returns the
  row and its curation, never the reporting key. If the target already had a reporting key of its own —
  which the re-image case always does — the transplant **replaces** it; the displaced key is recorded
  as `_infraMergedInto.replacedTargetKey` and logged, and a host still checking in under it returns as
  a fresh PENDING proposal.

### Reviewing at scale (ADR-0074 §1 amendment, #1145)

- `POST /infra/nodes/bulk-confirm` — `{ items: [{ id, trackAsAsset?, kind?, label? }] }`, max 200,
  ids unique. Each item is applied through the **same** `confirmNode` the single route calls, so the
  semantics are identical; overrides are per item because a host and its containers want different
  `trackAsAsset` answers and `label` is not a batch concept. Same gate as the single confirm
  (`infra:manage` + `asset:write` + human-only). Returns **per-item** outcomes
  (`applied` / `skipped` — already CONFIRMED / `notFound` / `failed` with the message the single
  action would have returned) plus counts; one failing item never discards the rest. Sequential
  server-side (each item can mint an Asset and re-index).
- `POST /infra/nodes/bulk-discard` — `{ ids }`, max 200. The existing soft delete over a set, in one
  statement; an id already gone reads `notFound` and never widens the write. `infra:manage`, mirroring
  `DELETE /infra/nodes/:id`.
- The tray **groups children under their reporting host** (`hostExternalIdOfContainerChild` inverts
  the `<host>/container/<name>` key), so confirming a host with its containers is one selection. Its
  filters (name glob or substring, subnet CIDR, reported kind, host-vs-container) and sorts are
  **client-side over the lean list row** — nothing was added back to the projection #1135 slimmed;
  the subnet filter reuses the same `ipInCidr` the auto-confirm rules use. Those four still run over
  the **loaded array** — but since #1152 that array is **one batch, not the queue**: the tray requests
  the maximum page (200) of `state=PENDING` in the list's `createdAt desc` order, so the newest
  proposals are always in the window. The constraint that bounding this list must surface a `total`
  and a truncation cue — never a quiet partial view — is therefore met explicitly: the header badge
  counts **`total`** (never `items.length`), and whenever the two differ the tray says so in plain
  language, *"Showing 200 of 431 pending nodes, most recently discovered first"*. That is a routine
  state rather than a theoretical one, because one [[0095-hypervisor-guest-inventory]] report can
  enrol 500 guests at once. Confirming or discarding a batch reveals the next.

See [[infra-auto-confirm-rule]] for the saved-rule half of the same amendment.

### The agent fleet read (ADR-0094 §4 / #1206, consumed by #1207)

- `GET /infra/agents/fleet` — the whole fleet view in one read (`infra:read`): the instance's own
  `serverVersion`, the `summary` distribution, one row per agent-bearing host, and the live
  `infra:report` service accounts (never-used first, capped). **Read-only and derived** — it computes
  from data already stored and pushes nothing toward a host. Container children are excluded (they
  inherit their host's `agentVersion`, so counting them would inflate every bucket), and `osFamily` is
  projected out of `specs` per read rather than added as a column. Deliberately **not** on the 5–40s
  poll the node list is on: it is a page an operator opens, and it is the heavier read (#1135).

The web consumes it at **Assets › Topology › Agents** (`?view=agents`, #1207): the distribution, the
liveness and degraded flags, and — only on a host that is genuinely behind — the exact update command,
built for that host's reported `AgentOsFamily` by `apps/web/lib/agent/install-commands.ts`, the same
builder the "Add a server" wizard uses. That command is `--upgrade` / `-Upgrade` and **nothing else**
(#1208): no token (only `tokenHash`/`tokenPrefix` exist, so the server cannot re-emit one), and
deliberately **no `--url` and no `--ca-file`** — those are keys the installer owns and rewrites, so
emitting them would re-pin every host the command was pasted on. `--upgrade` reads all three back off
the host's own config, which makes the string identical on every host. See ADR-0094 §6 amendment.

The credential block (`identities` + `identitiesNeverUsed`) rides a **second `settings:manage` gate**
and is **omitted, not emptied**, for a caller without it (#1206) — an empty array would read as "no
agent tokens exist", a different and false claim. The web hides the whole card on absence
(`agentFleetCredentialBlock` in `apps/web/lib/agent/fleet.ts`) rather than rendering a zero state.

### Server-driven agent policy (ADR-0074 §7 amendment / #1140)

- `GET /infra/agent-policy` — the **instance default** layer plus the instance-wide `revision`
  (`infra:read`). `settings` is the stored layer an operator edits; `effective` is that layer resolved
  over the built-in defaults — it is what a host with **no narrower override** runs, and deliberately
  not a promise about hosts that have one.
- `PUT /infra/agent-policy` — replace the instance default and bump the revision
  (`settings:manage`, human-only). The body is a PARTIAL policy: omitted fields fall back to the
  built-in defaults, so `{}` restores all of them.
- `PUT|DELETE /infra/agent-policy/service-accounts/:id` — the **middle** scope, and the only one that
  can configure a host before it has a node (`settings:manage`, human-only).
- `PUT|DELETE /infra/nodes/:id/agent-policy` — the **narrowest** scope (`infra:manage`, human-only).

There is **no `GET /agent/policy`** and there never will be: the policy rides the existing report ack
(`AgentReportAckSchema.policy`), which is already authenticated, already per-agent and already
happening. Every write here is **human-only** — a reporting agent holding `infra:report` can *receive*
a policy and can never author one. `PUT /infra/agent-policy` is the only one with a UI (Settings →
Reporting agents — its own section since #1174); the two narrower scopes work but ship no editor in
this build, which that section now states on screen rather than implying only one scope exists.

## Not yet implemented (deferred)

- ~~The **v2 reporting agent** (auto-discovery → PENDING tray, liveness, reconciliation/merge-on-confirm)
  — its columns exist nullable now; its own major epic.~~ **Shipped** ([[0074-server-reporting-agent]],
  epic #831): auto-discovery into the PENDING tray, the staleness sweeper, and — as of #1141 — identity
  corroboration plus an explicit `merge-into` re-key. Note the merge is a **separate human action**, not
  the "merge-on-confirm" this bullet imagined: confirming still only promotes one proposal.
- Listening-socket `DEPENDS_ON` **hints** (suggested edges a human accepts, never auto-created) —
  deferred on purpose, ADR-0074 §3 amendment (#1139).
- ~~A dedicated `InfraNodeHistory`.~~ **Shipped** as [[infra-node-fact-change]] ([[0074-server-reporting-agent]]
  §3 amendment, #1143) — narrower than the name implied, and deliberately so: it records the tracked
  FACTS that moved (packages, OS/kernel/memory/disk/serial, a container's image digest), not every
  edit to every column. Curation changes (label, kind, position, asset linkage) are still not logged.
- **Chassis routing** — *proposed, not built* ([[0093-chassis-routing-and-asset-adoption]], #1196).
  `host.chassis` is collected on **both** platforms and acted on by essentially nothing: `inferNodeKind`
  reads it only as the fallback branch, so a report carrying `host.virtualization` (the normal case on
  both collectors) never reaches it. The proposal adds an agent-owned nullable **`chassis`** column,
  hides `laptop`/`desktop` nodes from the topology **canvas** by default behind a "Show endpoints"
  toggle (a view-level treatment — **no new `InfraNodeState`/`InfraNodeKind` member**, and impact /
  search / the Servers table stay unfiltered), surfaces chassis in the review tray, adds it as an
  `InfraAutoConfirmRule` condition, and makes a confirm **adopt** a corroborated live [[asset]] instead
  of minting a duplicate.
- ~~**Assisted agent update + the fleet view**~~ **Shipped**
  ([[0094-assisted-agent-update]], #1204/#1206/#1207). `agentVersion` had been a first-class column since #907
  that nothing aggregated. `GET /infra/agents/fleet` (`infra:read`) now answers *how many agents, on what
  versions, who has not checked in, who is degraded*: every agent-bearing host — container children
  excluded, since they carry their host's `agentVersion` — bucketed **exclusively** into `majorBehind` /
  `behind` / `unknown` / `current` by `agentVersionBucket` in `@lazyit/shared`, a pure re-expression of
  `isNewerVersion` + `isMajorBehind` that adds **no second notion of "behind"** and keeps their fail-soft
  posture verbatim. The change §3 actually makes is that **"version unknown" is a visible bucket** instead
  of silence. The row also carries `lastReportedAt`/`status` liveness, the collector `diagnostics` block,
  and **`osFamily` projected out of `specs` per read** — the [[0090-ipam-validated-ip]] display-only
  computed-read-field mold, since `specs` is deliberately off list rows (#1135); no column, no migration,
  and a `null` family means the caller shows **both** install commands rather than guessing. Live service
  accounts holding `infra:report` ride along, never-used first, because a token minted for a host that
  never checked in leaves no node behind — but **on a second gate**: that block is the service-account
  credential inventory, which every other surface reads under `settings:manage`, and `infra:read` reaches
  MEMBER *and* VIEWER by default. A caller without `settings:manage` gets the table with the block
  **omitted** (not emptied, and not a 403 on the whole read) — the same in-code second gate the folder
  `accessRules` read uses (INV-9 / #554). The never-used figure is a separate unbounded `count`, so it
  stays true past the identity cap instead of clamping to it. **No migration, no agent change, no
  `agentUpdate` on the ack, no
  server-pushed execution** — full self-update and human-triggered/agent-executed update were both
  declined, with reopening criteria recorded. The web surface is the third view of the Topology screen
  (`?view=agents`, #1207): the distribution, the liveness/degraded flags, the never-used credentials, and
  the per-host command — rendered **only** where something is genuinely behind, which is ADR-0084 §5's
  posture and not a styling choice. Still **inert until #1203**: every Docker-served binary reports
  `agentVersion: "dev"` today, so an estate honestly reads as entirely "version unknown" and fills in as
  hosts are re-installed — the view says exactly that rather than implying those agents are fine.
- List-row asset name/owner enrichment (#750); deep network model (VLAN/ports/IPAM); metrics/alerting;
  per-kind `specs` validation; multi-board layouts; a `SERVICE` kind linked to [[application]].
  → [[0070-infra-topology-graph]] "Future".

Related: [[infra-edge]] · [[infra-node-fact-change]] · [[asset]] · [[asset-assignment]] · [[asset-centric]] · [[user]] ·
[[0093-chassis-routing-and-asset-adoption]] · [[0094-assisted-agent-update]] ·
[[0095-hypervisor-guest-inventory]] ·
[[0070-infra-topology-graph]] · [[0074-server-reporting-agent]] · [[0019-asset-assignment-integrity]] ·
[[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] ·
[[0061-secret-manager-zero-knowledge]] · [[0048-service-accounts]]
