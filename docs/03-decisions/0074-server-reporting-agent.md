---
title: "ADR-0074: Server reporting agent — self-installing Linux collector that auto-reports inventory"
tags: [adr, infra, topology, agent, inventory, backend, frontend, shared, devops, security]
status: accepted
created: 2026-06-27
updated: 2026-06-27
deciders: [Joaquín Minatel]
---

# ADR-0074: Server reporting agent — self-installing Linux collector

## Status

**accepted** — 2026-06-27. Epic #831. This ADR fixes the **design, the wire contract, the
distribution model and the phasing** before a line of code, so the model is never re-migrated and the
agent↔server contract is pinned. It is the **v2 reporting agent** deferred by
[[0070-infra-topology-graph]] (whose provenance columns were reserved for exactly this), and builds on
[[0048-service-accounts]] (the machine auth it uses), [[0053-async-workers-bullmq-valkey]] (the worker
substrate it feeds), [[0007-flexible-asset-specs-jsonb]] (where inventory blobs live),
[[0005-id-strategy]], [[0006-soft-delete-and-auditing]], [[0026-reverse-proxy-tls]] and
[[0046-roles-permissions-v2]] (the frozen permission catalog it extends).

> [!info] Phasing (tracked in #831)
> **Phase 1 — backend:** report contract (zod in `@lazyit/shared`), `POST /infra/report`,
> upsert/reconcile by `(reportingSource, externalId)`, the deferred composite unique index migration,
> the `infra:report` permission, the staleness sweeper.
> **Phase 2 — agent + distribution:** the Bun-compiled Linux collector, `install.sh`, the token-gated
> download endpoint, the systemd timer, the Docker build stage.
> **Phase 3 — frontend + Manual:** the PENDING review tray, the "Add a server" flow, agent-reported
> badges + `lastReportedAt` freshness, and the `/help` Manual pages (en + es).

## Context

[[0070-infra-topology-graph]] shipped the topology model and **explicitly reserved**, nullable and
inert, the columns a reporting agent would need: `InfraNode.source` (`MANUAL | AGENT`),
`InfraNode.state` (`CONFIRMED | PENDING`), `reportingSource`, `externalId`, `lastReportedAt`. It also
deliberately **deferred** the `(reportingSource, externalId)` composite unique index "to the agent
migration". This ADR is that migration and the code that fills the slots.

The product goal is operator-facing and blunt: *I want to drop one command on a server and have it
show up in lazyit, keep itself current, and tell me when it goes dark — without me maintaining a
spreadsheet.* lazyit already inventories *things* and maps *how they relate*; what it cannot do is
**populate itself**. Every Asset and InfraNode today is hand-entered or bulk-imported once
([[0069-migrator-import]]). Inventory drifts from reality the moment it is entered.

Constraints that shaped the decision:

- **lazyit is self-hosted, single-org, air-gapped-friendly.** There is no central SaaS, no "our
  landing", no CDN we operate. Anything the agent talks to must be the **operator's own instance**.
- **lazyit is a CMDB, not a monitoring tool.** It is not Datadog/Netdata. The line is drawn at
  **inventory**: what a host *is* and what software it runs — not time-series metrics, not alerting.
- **Auditability by default** ([[0006-soft-delete-and-auditing]]). An automated writer must not be
  able to silently mutate the official inventory. Provenance and a human gate are non-negotiable.
- **The zero-knowledge boundary is absolute** ([[0061-secret-manager-zero-knowledge]] INV-10). The
  agent must never touch secret values; it carries no crypto and reads no vault.

## Decision

### §1 — Scope (the four product calls)

| Axis | Decision | Rejected |
| --- | --- | --- |
| **What it reports** | **Inventory only** — host identity, hardware facts, installed software. | Health snapshots; time-series metrics + alerting (a different product). |
| **What it discovers** | **Self only** — the host the agent runs on. "Expand" = install it on more hosts. | Network scanning / agentless discovery (security surface, false positives, LAN noise). |
| **OS targets** | **Linux only** — `x64` + `arm64`. | Windows (WMI service), macOS (launchd) — deferred, contract is OS-neutral so they can be added. |
| **Trust** | **Review tray** — new hosts arrive `state=PENDING`, `source=AGENT`; a human confirms. | Auto-confirm (any agent noise dirties the official inventory with no containment). |

### §2 — The report contract (`@lazyit/shared`)

One zod schema, `AgentReportSchema`, is the single source of truth for the wire — imported by **both**
the agent binary and the API handler (the monorepo payoff: zero drift). Shape (illustrative; the
implementing PR fixes exact fields):

```ts
AgentReportSchema = z.strictObject({
  agentVersion: z.string(),                 // the binary's own version (for skew diagnostics)
  reportingSource: z.string().min(1).max(120),  // stable per install (e.g. "agent:<machine-id-prefix>")
  externalId: z.string().min(1).max(200),       // /etc/machine-id — the dedup key
  reportedAt: z.string().datetime(),
  host: z.object({
    hostname: z.string(),
    os: z.object({ name, version, kernel }),
    cpu: z.object({ model, cores: z.number().int() }).partial(),
    memoryBytes: z.number().int().nonnegative().optional(),
    disks: z.array(z.object({ device, sizeBytes, mountpoint })).optional(),
    nics: z.array(z.object({ name, mac, ipv4: z.array(z.string()) })).optional(),
    hardware: z.object({ manufacturer, model, serial }).partial().optional(), // dmidecode (root)
  }),
  software: z.array(z.object({ name: z.string(), version: z.string().optional() })).max(5000).optional(),
})
```

Every hardware/identity field beyond the dedup keys is **optional**: the agent degrades gracefully
when it lacks privilege (e.g. `dmidecode` needs root) or a tool is missing. A partial report is valid,
never a 400.

### §3 — Ingestion & reconciliation

- **Endpoint:** `POST /infra/report`, authenticated by the agent's Service Account bearer token
  (§5). Validates `AgentReportSchema`; rejects only on malformed payloads, never on missing optional
  facts.
- **Dedup key:** `(reportingSource, externalId)`. `externalId` = the host's `/etc/machine-id`, the
  stable per-OS-install identifier. This ADR adds the **composite partial unique index** (over
  non-deleted rows) that [[0070-infra-topology-graph]] deferred. **One host = one node, forever**,
  across every report.
- **Upsert:**
  - *Unknown key* → create `InfraNode` with `source=AGENT`, `state=PENDING`, `status=ONLINE`,
    `kind` inferred (default `PHYSICAL_HOST`; `VM`/`CONTAINER` if detectable), `label` = hostname,
    `specs` = the inventory blob, `lastReportedAt = now`. **No backing Asset is created yet** — a
    PENDING node is a proposal, not an inventory row.
  - *Known key* → update `specs`, `status=ONLINE`, `lastReportedAt = now`. **Never** flips a
    human's `state`, `label`, position, or manual edits back; the agent owns inventory facts, the
    human owns curation. A confirmed node keeps receiving fresh facts.
- **Confirmation (the tray):** confirming a PENDING node sets `state=CONFIRMED` and — per the
  existing topology "track as asset" path — may create the backing `Asset` (specs carried over), so
  the auto-discovered host becomes a first-class, owned, assignable Asset only on human approval.
- **Async:** heavy work (software-list diffing, search re-index) goes through a BullMQ queue on the
  same Valkey substrate ([[0053-async-workers-bullmq-valkey]]), copying the `import-commit` worker
  pattern. The endpoint returns fast (accepted), the work drains in the background.

### §4 — Liveness & staleness

`lastReportedAt` is the heartbeat. A periodic **sweeper** (BullMQ repeatable job) flips any node whose
`lastReportedAt` is older than a threshold (default: a small multiple of the report interval) to
`status=OFFLINE`. The next report flips it back `ONLINE`. This is the *only* "monitoring-ish" feature
and it is deliberately coarse — a liveness bit, not a metric. // a downed agent ⇒ OFFLINE on the map,
which already drives the blast-radius UI from [[0070-infra-topology-graph]] §7.

**Amendment (2026-06-30, #852) — one bell nudge per OFFLINE transition.** The sweeper now emits a
broadcast **`infra.agent_offline`** notification ([[0056-in-app-notification-bell]] amendment §A) for each
node **transitioning** CONFIRMED→OFFLINE, so a dark agent surfaces as an admin nudge, not just a map badge.
The bulk `updateMany` can't report which rows it flipped, so the sweep **snapshots the `status != OFFLINE`
doomed set before the flip** and emits one nudge per snapshot node, POST-flip + best-effort (a failed emit
never aborts the sweep). Deduped on the node's last-report instant → **one nudge per outage**, never
once-per-sweep. Still the coarse liveness bit — no metrics, no thresholds beyond the existing staleness
cutoff.

### §5 — Auth & permission

- The agent authenticates as a **Service Account** ([[0048-service-accounts]]) —
  `Bearer lzit_sa_<id>_<secret>`, IdP-independent, audit-attributed. No new auth mechanism.
- A **new single permission `infra:report`** is added to the frozen catalog
  ([[0046-roles-permissions-v2]]). The agent SA is granted **only** this. It cannot read, delete, or
  touch anything else — not secrets, not assets, not other infra. Worst case on a leaked token is
  **PENDING spam a human discards.**
- The report endpoint is `infra:report`-gated and (like the importer) is a **machine-shaped** route;
  the human topology routes keep their `infra:read`/`infra:manage` gates unchanged.

### §6 — Distribution (self-hosted, single origin)

The `curl` one-liner targets the **operator's own instance** — never a central landing. Self-hosted,
version-locked, air-gapped-safe. Caddy already fronts web + API on one origin
([[0026-reverse-proxy-tls]]).

| Artifact | Served by | Auth | Rationale |
| --- | --- | --- | --- |
| `install.sh` | **web**, public path | none | A `curl \| sh` installer carries no secret; the token is passed by the operator as a flag/env. Requires widening the auth proxy's public allowlist with a **path** rule (`apps/web/proxy.ts`). |
| the binary | **API**, token-gated | the SA token | No anonymous binary surface (repo's "no anonymous surfaces" posture, cf. `/api/docs` not exposed). The agent already holds the token. Served via a `StreamableFile` controller (new — no download precedent in the API today). |

The binary is **baked into the Docker image** via a `bun build --compile --target=bun-linux-{x64,arm64}`
build stage — **not** a GitHub Release. The instance serves *its own* matching binary: same-origin,
version-locked to the running server, works fully offline. (CI builds images with `push: false`
today; this adds a build stage, not a publish job.)

### §7 — The agent

- **A Bun single-file executable**, not a Go/Rust binary and not a shell script. It imports the
  **same `@lazyit/shared` zod contract** the API validates (zero drift), keeps the repo to one
  language, ships as one static artifact with no runtime deps on the host (no `jq`/`curl`/node
  required), and avoids hand-building JSON in shell (the edge-case trap).
- **A systemd `timer` (oneshot), not a daemon.** It runs, gathers, POSTs, exits. No long-lived
  process, no memory growth, crash-safe — a failed tick is simply retried next interval. Default
  interval: 15 min (configurable). // upgrade to a daemon only if sub-minute reporting is ever needed,
  which inventory never requires.
- **Collection (Linux):** `hostname`/`/etc/os-release`/`uname` (identity, OS, kernel),
  `/proc/cpuinfo` + `/proc/meminfo` (CPU/RAM), `lsblk`/`/sys` (disks), `ip`/`/sys/class/net` (NICs),
  `dmidecode` (manufacturer/model/serial — **root only, optional**), `dpkg-query`/`rpm -qa`/`apk info`
  (installed software, package-manager auto-detected). Anything unavailable is simply omitted.
- **Config:** `/etc/lazyit-agent/config` (instance URL + SA token, `chmod 600`). The install script
  writes it; the binary reads it.

### §8 — Security model

- **Single-permission blast radius.** The agent SA holds only `infra:report` (§5).
- **Human gate.** Everything new is PENDING (§3); the official inventory is never mutated by a machine
  without human confirmation. Auditability ([[0006-soft-delete-and-auditing]]) intact — agent writes
  are SA-attributed in history.
- **No secret exposure.** The agent carries no crypto and reads no vault; INV-10
  ([[0061-secret-manager-zero-knowledge]]) is untouched — the agent module never imports the secret
  manager's value side.
- **`curl | sh` posture.** The installer is served by the operator's own TLS-fronted instance
  (same-origin, no third party). The token is the operator's, scoped to one permission, revocable from
  the UI. A "download, inspect, then run" path is available for the cautious; the one-liner is the
  default.

## Consequences

**Positive.** The inventory becomes self-populating and self-healing; the topology map reflects
reality without manual upkeep. The whole server side rides reserved columns + existing auth + existing
workers — net-new is the binary, two endpoints (report + download), one installer, and the tray UI.
One language, one artifact, one origin. Air-gapped deployments work unchanged.

**Negative / trade-offs.** A new deployable (the agent) to version alongside the apps. A Bun-compiled
binary is larger than a Go equivalent (acceptable for a 5–20-person estate). `dmidecode` facts need
root, so unprivileged installs report less (degrades gracefully). Baking the binary into the image
grows it modestly. The PENDING tray adds a human step — deliberate (the trust call).

**Deferred.** Windows/macOS agents (contract is OS-neutral); per-kind `specs` schema validation (the
existing `TODO(specs)` debt from [[0070-infra-topology-graph]]); cosign-signed binaries (add if a
client's compliance demands it); any move toward metrics/telemetry (explicitly out of scope — that
would be a separate ADR and arguably a separate product).

## Alternatives considered

- **A completely separate app/repo.** Rejected: the server side is the topology domain, whose model
  was *designed* for this. Splitting it would duplicate the domain and break the source of truth. The
  agent *binary* is a separate deployable, but it lives in the monorepo to share the contract.
- **Go / Rust binary.** Smaller, more "standard fleet agent". Rejected: adds a language + cross-compile
  CI for a benefit the estate size doesn't need, and loses the literal-shared-contract win.
- **Pure shell + curl installer that also collects.** Laziest on paper. Rejected: cross-distro shell
  inventory (apt/dnf/apk, `dmidecode` root, missing `jq`) and hand-built JSON are the exact flimsy
  edge-case trap to avoid; a compiled binary is correct on edge cases.
- **`curl` to a central lazyit landing.** Rejected: no central SaaS exists, breaks air-gapped
  installs, and reintroduces agent↔server version skew.
- **Metrics/monitoring.** Rejected as scope: lazyit is a CMDB; `lastReportedAt` liveness is the one
  coarse exception, not a slippery slope to time-series.
- **Auto-confirm discovered hosts.** Rejected: violates auditability; PENDING is the containment.

## Links

- Deferred by / fills the reserved columns of: [[0070-infra-topology-graph]]
- Auth: [[0048-service-accounts]] · Permissions: [[0046-roles-permissions-v2]]
- Workers: [[0053-async-workers-bullmq-valkey]] · Specs: [[0007-flexible-asset-specs-jsonb]]
- Deployment/origin: [[0026-reverse-proxy-tls]] · Auditing: [[0006-soft-delete-and-auditing]]
- Ingestion precedent: [[0069-migrator-import]] · Zero-knowledge boundary: [[0061-secret-manager-zero-knowledge]]
- Epic: #831
