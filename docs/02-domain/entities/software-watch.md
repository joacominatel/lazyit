---
title: SoftwareWatch
tags: [domain, entity, infra, agent, software]
status: accepted
created: 2026-10-21
updated: 2026-10-22
---

# SoftwareWatch

> 🟢 implemented (API, #1684) · Area: Infra topology · Implementation order: after [[infra-node]] (it
> reads the package lists agents store there) · Web surface: follows separately on #1684

## Purpose

One entry on the **software watchlist** — a short, operator-maintained list of package names that the
team cares about on Patch Tuesday (`openssl`, `openssh-server`, `curl`, …). Each watch is answered with
**one fleet-wide distribution**, computed on read from the package lists the reporting agents already
store on their nodes ([[infra-node]] `specs.software`):

> **openssl** — 11 hosts on `3.0.13`, 2 hosts on `1.1.1w`, 1 host missing, 3 unknown.

Before this, that data could only be viewed one host at a time. Epic #1146 item 4 called it the highest
return per effort on the reporting-agent backlog: a `GROUP BY` over data already stored.

**Distribution only** (CEO decision Q12 on #1146). Package name → versions → host counts, plus the hosts
**missing** the package. There is deliberately:

- **no version comparison** — no "outdated", no "behind", no ordering of versions, no EOL flag. A version
  is an opaque string that gets counted. The version buckets are listed by host count and then by plain
  text, which is a stable display order and nothing more;
- **no CVE matching** — that needs a continuously-updated feed, which the air-gapped promise
  ([[0074-server-reporting-agent]] §6) rules out;
- **no product normalization** — mapping forty spellings of one product to one entry is a data-curation
  business the epic refused. A watch matches a package by its **exact name** after
  `normalizeSoftwareName` (whitespace collapsed, trimmed, lower-cased). `libssl3` and `libssl3:amd64`, or
  a Windows `DisplayName` that carries a version or an architecture, are different names.

## Business rules

- **A watch is a name and nothing else.** It is created and soft-deleted; there is no edit (a rename is
  a delete plus a new watch). The name is stored **normalized**, so uniqueness among live watches is
  uniqueness of the normalized name: `OpenSSL` and ` openssl ` are the same watch (409 on the second).
- **Soft delete** ([[0006-soft-delete-and-auditing]]). A deleted watch leaves the list immediately and
  its name is free for a new watch (live-only partial unique index); the row is kept. Registered with the
  soft-delete read extension ([[0032-soft-delete-middleware]]), so every read is auto-scoped.
- **At most 100 live watches** (`SOFTWARE_WATCH_LIMIT`). A guard rail, not a quota: each watch is
  aggregated over every host's stored list on every read, and the feature is for the 10–30 packages a
  team actually tracks. It is also what keeps the list endpoint unpaged and bounded.
- **The population** is every live, agent-reported **host** — `source = AGENT`, not a `/container/` or
  `/guest/` child (those carry no package list of their own, #1139 / [[0095-hypervisor-guest-inventory]]),
  not soft-deleted. Manual nodes are out (no agent, no list). **PENDING and OFFLINE hosts are in**: an
  offline host's last list is still the best evidence there is, and each host row says how old it is.
  **Retired hosts are out** (#1701, #1146 Q11): `retiredAt: null` is part of the one predicate
  (`SOFTWARE_WATCH_POPULATION_WHERE`). A decommissioned server is neither running a version nor
  "missing" a package. OFFLINE is not retired, and an offline host stays in.
- **INSTALLED / MISSING / UNKNOWN** — every host lands in exactly one, so `installed + missing + unknown
  = hostsTotal`:
  - **INSTALLED** — the host's stored list names the package (at one or more versions). This wins over
    everything: a list that names it is evidence, whatever the policy says now.
  - **MISSING** — the host **stores a list** and the list does not name the package. Only ever said about
    a host whose agent actually enumerated its packages.
  - **UNKNOWN** — we cannot say, and it is **never folded into MISSING**:
    - `NOT_COLLECTED` — the node stores **no list at all**. That is what software collection being off
      leaves behind, whatever turned it off: the agent policy at any scope (instance, service account or
      node, #1140), the host's own local veto (`LAZYIT_COLLECT_SOFTWARE=false`), or a collector that has
      never been able to enumerate. The server **clears** the stored list when a report says
      `softwareState: 'disabled'` (#1142), so the stored absence is the evidence — and it is the only
      evidence that covers every layer. Re-resolving the policy instead would be wrong: a node carries no
      reporter attribution (#1134), so the service-account layer cannot be resolved per node on a read,
      and the local veto is invisible to the server by design.
    - `EXCLUDED_BY_POLICY` — the host stores a list that does not name the package, **and** the name
      matches an `exclude.softwareNames` glob of the policy the server *can* resolve for that node (the
      instance default plus the node's own override). The agent was told not to report it, so its
      absence proves nothing. **Residual, stated:** an exclusion set only at the service-account scope or
      in the host's local config is not visible here, and such a host reads MISSING.
- **Versions.** A host listing two versions of one package (two kernels, a multi-slot runtime) counts
  **once in each version bucket** and once in `installed`, so the buckets can sum to more than
  `installed`. A package listed with no version, or an empty one, falls in the `null` bucket.
- **Nothing travels toward a host.** No collection is added, no policy changes, no agent changes. The
  feature is a read over [[infra-node]] `specs` plus a list of names.

## Fields

Prisma model `SoftwareWatch` → table `software_watches`. Wire schemas (`SoftwareWatchSchema`,
`SoftwareWatchSummarySchema`, `SoftwareWatchHostSchema`, `CreateSoftwareWatchSchema`, the presence and
reason enums, `normalizeSoftwareName`, `summarizeSoftwareWatch`) live in `@lazyit/shared`
(`packages/shared/src/schemas/agent-fleet.ts`, beside the fleet view).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | `@default(cuid())`. |
| `name` | `string` | the **normalized** package name (≤ 255, the report contract's own package-name cap). Unique among live rows — raw-SQL partial index `software_watches_name_live_key` (`WHERE "deletedAt" IS NULL`), not `@unique`. |
| `createdById` | `uuid?` | FK → [[user]], `onDelete: SetNull`. The human who added it; the wire carries `createdByName` only while that user is live. |
| `createdAt` | `datetime` | `@default(now())`. |
| `deletedAt` | `datetime?` | soft delete. |

No `updatedAt`: there is no editable field. Index: `@@index([createdById])`.

## Endpoints

`apps/api/src/infra/software-watch.controller.ts` (`SoftwareWatchController`, inside `InfraModule`):

| Route | Gate | Returns |
| --- | --- | --- |
| `GET /infra/software-watches` | `infra:read` | `SoftwareWatchSummary[]` — every live watch, oldest first, each with its `distribution`. Unpaged, bounded by the 100-watch cap; one fleet snapshot serves all of them. |
| `GET /infra/software-watches/:id` | `infra:read` | `SoftwareWatchSummary`. 404 for an unknown or deleted watch. |
| `GET /infra/software-watches/:id/hosts?presence=&version=&limit=&offset=&page=` | `infra:read` | `Page<SoftwareWatchHost>` ([[0030-list-pagination-contract]]: default 50, max 200, over-max → 400), in label order. `presence` ∈ `INSTALLED`/`MISSING`/`UNKNOWN`; `version` selects one bucket exactly and implies `INSTALLED` (an **empty** `version=` selects the `null` bucket; with another presence → 400). Unknown keys → 400. |
| `POST /infra/software-watches` `{ name }` | `infra:manage`, **human-only** | `SoftwareWatch` (201). Name normalized before storing; 409 on a live duplicate; 400 on a blank name or once 100 live watches exist. |
| `DELETE /infra/software-watches/:id` | `infra:manage`, **human-only** | `SoftwareWatch` — soft-deleted. 404 for an unknown or already-deleted watch. |

**Why `infra:read`.** The package lists being aggregated are already readable at that gate on every
node's drill-in (`GET /infra/nodes/:id` returns `specs`), so the watchlist widens nothing — it answers
across hosts what each host's page already shows. Epic #1146 notes that a versioned estate-wide software
inventory is itself sensitive (a vulnerability map); that is a property of `infra:read` as it already
stands, and the per-group opt-out it asks for is the existing `collect.software` policy, which this
feature honours as UNKNOWN.

**Why writes are human-only.** Every other operator-authored infra configuration is (auto-confirm rules,
agent policy). A watch is a human's choice of what to look at; the reporting agent's credential
(`infra:report`) reaches none of these routes. The AI tool registry leaves all five routes **unexposed**
(`apps/api/src/ai/tools/infra.tools.ts`).

**Cost.** Each read is one scalar `findMany` over the population plus two raw jsonb projections: one bit
and one timestamp per node, and the package entries matching the watched names — the name filter runs in
Postgres (a SQL spelling of `normalizeSoftwareName`, re-checked in TypeScript so it can only narrow), so
a host's ~350 KB package list never leaves the database. The host list is classified in memory and
sliced; the population is the agent-host count.

## Links

[[infra-node]] · [[0074-server-reporting-agent]] (2026-10-21 amendment) · [[0094-assisted-agent-update]] ·
[[0030-list-pagination-contract]] · [[0006-soft-delete-and-auditing]] · [[0032-soft-delete-middleware]] ·
[[user]] · issue #1684 · epic #1146
