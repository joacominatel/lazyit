---
title: InfraNodeFactChange
tags: [domain, entity, infra, topology, agent]
status: accepted
created: 2026-08-02
updated: 2026-08-02
---

# InfraNodeFactChange

> 🟢 implemented · Area: Infra topology · Implementation order: with the reporting agent
> ([[0074-server-reporting-agent]] §3 amendment, #1143)

## Purpose

**One thing that changed on an [[infra-node]]**, appended by the reporting agent's ingest path — the
row that turns the inventory from a current-state scraper into something that can answer *"when did
this change?"*.

The operator question it exists for is stated plainly in the issue: *"someone upgraded OpenSSL on
db-01 last Tuesday and broke the app."* Before this, lazyit stored the current version of every fact
and nothing else — which `dpkg -l` over SSH also gives you. Storing the **diff** is what makes the
inventory a CMDB rather than a scraper with a nicer front end.

**It records the diff, not the report.** `syncAssetSpecs` deliberately bypasses `AssetsService.update`
so no `SPECS_CHANGED` [[asset-history]] event fires per check-in — at the shipped 5-minute cadence
that would be ~96 no-op audit rows per host per day, and that reasoning stands unchanged. A row is
written **only when something actually moved**, so a host nobody touched adds nothing, forever.

## Relationships

- **belongs to** one [[infra-node]] (`nodeId`, required FK, `onDelete: Cascade`). Cascade, like
  [[infra-edge]] and the node's secret refs: a change record is meaningless without the node it
  describes, and the durable trail an operator reconciles from is the linked [[asset]]'s
  [[asset-history]], not this table. Note the cascade is a **hard**-delete rule and nothing in the
  product performs one: removing a node from the map is a soft delete, which leaves these rows in
  place and simply makes them unreachable (the read below resolves the node through the
  soft-delete-scoped lookup, so it `404`s). Restoring the node restores its history with it.

## Business rules

- **A first observation SEEDS, it never diffs.** A fact with no previous value records nothing. This
  is the rule that makes the feature upgrade-safe: an estate upgrading into it starts with an empty
  table and records its first row the first time something genuinely moves, instead of every host's
  first post-upgrade tick writing one row per installed package. It covers a brand-new node, a node
  enrolled before the feature existed, a node whose stored package list was cleared, and a fact that
  had simply never been collected on that host before.
- **A fact that DISAPPEARS records nothing either.** An agent that loses root stops reporting
  `hardware.serial`; a downgraded agent stops reporting a field. Neither is the host changing, and a
  row saying otherwise would be a change on screen that never happened. A row needs **both** sides
  readable and different.
- **The tracked vocabulary is short and closed.** Packages (added / removed / version changed) plus
  `host.os.name`, `host.os.version`, `host.os.kernel`, `host.memoryBytes`, `host.disks.totalBytes`,
  `host.disks.count`, `host.hardware.serial` — and, for a container child, `container.image` and
  `container.imageDigest`. **Both disk facts answer "no evidence" rather than `0`** when a report
  carries no readable disk record: the agent's `exclude.mountpoints` policy sends `disks: []` on
  purpose when its globs match everything (the #1140 policy amendment in
  [[0074-server-reporting-agent]] §7), and recording that would put `host.disks.count 2 → 0` — a
  chassis losing all of its storage — on screen in exchange for an operator editing a setting.
  Everything else the report carries is either visible elsewhere or moves for reasons that are not
  inventory changes, and a history nobody trusts is worse than none.
- **A POLICY-SENSITIVE fact is compared only across ONE policy generation.** An agent policy (#1140)
  decides what the collector may *report*, so a fact a policy can filter would otherwise be recorded
  as the machine moving. Four fields filter a list the report still carries — `exclude.mountpoints`
  (which reaches `host.disks.totalBytes` and `host.disks.count`), `exclude.softwareNames`,
  `softwareSources` and `softwareMax` (which reach every `PACKAGE_*` row) — so those facts are marked
  `policySensitive` in the shared tracked-fact table and are diffed only when the agent's echoed
  `policyRevision` matches the one the node already held. Both absent counts as a match, which is what
  keeps a pre-#1140 agent's package history working. The marking is a **required** field on every
  tracked fact, so a fact added later declares itself rather than inheriting the wrong answer. The
  cost is one report's worth of disk and package rows after any policy write (the revision is
  instance-wide), and the facts no policy filters — OS, kernel, memory, serial, container image and
  digest — are still recorded in that same report. It does **not** see a host's own
  `/etc/lazyit-agent/config`: the local veto moves no revision, so tightening its exclusions there is
  recorded as removals. See [[0074-server-reporting-agent]] §3 for the full reasoning and the residual.
- **A container's runtime `state` is deliberately NOT recorded.** It is liveness: it already drives
  the child node's `status`, and a container that restarts nightly would write two rows a day forever.
  The image **digest** is recorded precisely because it moves under an unchanged `:latest` tag — the
  deploy nobody remembers doing.
- **`softwareState: 'disabled'` clears the stored list and records nothing.** Policy turning software
  collection off is a policy event; rendering it as three thousand removals would put a fleet-wide
  uninstall on screen that never happened. Same for a list that arrives empty or unreadable.
- **Two caps, both on what goes IN.** At most **200 rows per node per report** (host facts first, then
  packages by name — a deterministic slice, so a host back from a long outage writes a bounded sample
  rather than a few thousand inserts), and at most **500 rows per node per rolling hour** (one
  `COUNT`, run only when there is something to write, and answerable from the `(nodeId, createdAt)`
  index — see **Fields** below). Over the ceiling the new rows are **dropped**; nothing already
  recorded is ever deleted, because the table is append-only.
- **Nothing here may fail a check-in.** Every failure on this path — a constraint, a DB hiccup, a node
  deleted between the update and the insert, and the one stored-list read this feature adds to the
  report path — degrades to a warning and the report still acks. A host whose report 500s vanishes from
  the CMDB and shows OFFLINE; a history row that was not written costs one line in a timeline. Same
  posture as the agent-policy resolution, for the same reason.
- **Read-only, always.** Only the ingest path appends. There is no create/update/delete API, and the
  Changes tab offers no affordance to add or remove a row.
- **Permissions** ([[0046-roles-permissions-v2]]): `infra:read` to read a node's history. There is no
  write permission because there is no write endpoint.

## Conventions

- **ID:** `autoincrement()` — a log/history table ([[0005-id-strategy]]). It doubles as the keyset
  pagination cursor.
- **Timestamps:** `createdAt` **only** — append-only, no `updatedAt`, no `deletedAt`
  ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `InfraNodeFactChange` → table `infra_node_fact_changes`. The wire schema
(`InfraNodeFactChangeSchema`, `InfraNodeFactChangeListSchema`, `InfraFactChangeKindSchema`) and the
pure diff (`diffHostFacts`, `diffContainerFacts`, `diffSoftwareFacts`) live in `@lazyit/shared`
(`packages/shared/src/schemas/infra-fact-change.ts`).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `@default(autoincrement())`; also the pagination cursor. |
| `nodeId` | `cuid` | required FK → [[infra-node]], `onDelete: Cascade`. |
| `kind` | `InfraFactChangeKind` | `PACKAGE_ADDED` · `PACKAGE_REMOVED` · `PACKAGE_VERSION` · `FACT_CHANGED`. |
| `fact` | `string` | the package name, or a tracked fact key (`host.os.kernel`, `container.imageDigest`). |
| `previousValue` | `string?` | absent on `PACKAGE_ADDED`, and on a package that carried no version. |
| `currentValue` | `string?` | absent on `PACKAGE_REMOVED`, and on a package that carried no version. |
| `createdAt` | `DateTime` | `@default(now())` — when the **server** recorded it, within seconds of the report. |

**Two indexes, because the table has two queries that sort on different columns.**

| Index | Serves |
| --- | --- |
| `(nodeId, id)` | the **read** — the per-node timeline: filter by node, order by `id` desc, cursor on `id`. |
| `(nodeId, createdAt)` | the **write cap** — the rolling-hour `COUNT` the ingest runs before appending. |

The second one is not redundant: the cap's predicate is a **range** on `createdAt`, which
`(nodeId, id)` cannot answer — it could only walk every row the node owns and re-check each one.
Nothing prunes this table, so the node with the most rows is by definition the abused one, and the cap
would degrade to a sequential scan on the report ingest path at exactly the moment it fires. Measured
on `postgres:18-alpine` at 2.16M rows for one node, on the SQL Prisma emits for that `count`: a
parallel seq scan, 18,374 buffers, 38.6 ms without it; an index-only scan, 7 buffers, 0 heap fetches,
0.11 ms with it.

## Growth and retention

**No retention ships, and nothing prunes this table.** It only ever grows until its node is
**hard**-deleted (the FK cascade); soft-deleting a node — the only removal the product performs —
keeps every row. The write caps bound the **rate**, not the total.

- **Pathological ceiling:** 500 rows per node per rolling hour = 4.38M rows per node per year ≈
  **670 MB**, at the ~154 bytes/row measured on `postgres:18-alpine` (heap plus all three indexes,
  short values). Reaching it takes an abusive reporter running flat out for a year.
- **Real estate:** a row is written only when something actually moved. Twenty hosts through two patch
  windows a month is on the order of tens of thousands of rows a year — **single-digit MB**.
- **Reclaiming space** is an explicit operator action, not a side effect of ingest: a time-bounded
  `DELETE` is a one-off maintenance job (a scan — no index orders by `createdAt` alone, deliberately,
  because that is not a hot path). Deleting recorded history to make room is not something an
  append-only table ([[0006-soft-delete-and-auditing]]) gets to do quietly.

## Endpoints

- `GET /infra/nodes/:id/changes?limit=&cursor=` — a page of the node's history, **newest first**
  (`infra:read`). Keyset pagination on the append-only `id`: a page asks for rows *below* the last id
  it saw, so nothing is skipped or repeated while reports keep landing. `limit` defaults to 50 and is
  clamped to 200; a non-integer or non-positive `limit`/`cursor` is a `400` rather than a silent
  coercion. `nextCursor` is `null` on the last page. `404` on a node that is off the map (soft-deleted)
  or that never existed — checked with a **lean** `select: { id: true }` existence lookup (soft-delete
  scoped by the Prisma extension), never the node's whole row: a page must not drag the `specs` jsonb
  and its installed-package list along to answer one boolean. That is the [[infra-node]] list defect
  (#1135) in endpoint form, closed here rather than found later.

Surfaced by the **Changes** tab on the topology node panel
(`apps/web/app/(app)/assets/diagram/_components/node-changes-tab.tsx`). The query is gated on the tab
being the open one, so opening the panel fetches the detail and nothing else — an explicit gate, not
an inherited one: the panel owns the open-tab state and passes it down.

## Where the diff comes from

It is **not a second comparison**. `planSpecsWrite` / `refreshKnownNode` already compare the incoming
report against the stored blob on every check-in to decide whether the jsonb write can be skipped
(#1153); the fact history reads that same answer. A report that changed nothing skips both, and costs
no extra query at all.

The **package** half is the expensive one and is entered only when it has to be. Diffing packages
needs the stored list, which #1153 deliberately keeps out of the hot path — so it is read back only
when the server's own fingerprint of what arrived already disagrees with the one the node holds, i.e.
only on the reports where the package list genuinely moved (roughly the `apt upgrade` branch, twice a
month per host). The write planner still makes its own read on the `preserve`-with-changed-host-facts
branch #1153 documents; the fact history adds nothing to it and takes no package rows off it.

## Links

- [[0074-server-reporting-agent]] — the agent contract; §3's 2026-08-02 amendment is this table.
- [[infra-node]] · [[infra-edge]] · [[asset-history]] · [[0006-soft-delete-and-auditing]]
