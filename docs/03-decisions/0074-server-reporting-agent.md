---
title: "ADR-0074: Server reporting agent — self-installing Linux collector that auto-reports inventory"
tags: [adr, infra, topology, agent, inventory, backend, frontend, shared, devops, security]
status: accepted
created: 2026-06-27
updated: 2026-07-31
deciders: [Joaquín Minatel]
---

# ADR-0074: Server reporting agent — self-installing Linux collector

## Status

**accepted** — 2026-06-27. Epic #831. This ADR fixes the **design, the wire contract, the
distribution model and the phasing** before a line of code, so the model is never re-migrated and the
agent↔server contract is pinned. It is the **v2 reporting agent** deferred by
[[0070-infra-topology-graph]] (whose provenance columns were reserved for exactly this), and builds on
[[0048-service-accounts]] (the machine auth it uses), [[0007-flexible-asset-specs-jsonb]] (where
inventory blobs live), [[0005-id-strategy]], [[0006-soft-delete-and-auditing]],
[[0026-reverse-proxy-tls]] and [[0046-roles-permissions-v2]] (the frozen permission catalog it
extends). // this list originally also named ~~[[0053-async-workers-bullmq-valkey]] (the worker
substrate it feeds)~~ — **corrected 2026-07-31, #1136:** ingestion is inline and the agent feeds no
queue; see the §3 amendment below.

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

**Amendment (2026-07-18, #1081) — fact promotion (IP → node, serial → Asset, specs sync).** The report
path stops leaving every fact buried in `specs` and promotes the useful ones to canonical fields, while
keeping the human gate intact:

- **Primary IPv4 → `InfraNode.ipAddress`.** The pure `primaryIpv4(host)` mapper in `@lazyit/shared`
  (first IPv4 of the first non-`lo` NIC; else the first IPv4 anywhere; `undefined` on a partial report)
  seeds `ipAddress` on the CREATE branch (source-stamped `AGENT`) so a discovered PENDING node shows its
  IP on the map with zero hand-entry — an IP is a *display fact*, so setting it pre-confirm does **not**
  bypass the confirm gate. On every subsequent report the IP is **overwritten** with the live value
  (never nulled when a report lacks NICs).
- **`ipAddressSource` (new `InfraNodeIpSource { AGENT, MANUAL }`, default `AGENT`).** The "always
  overwrite the IP with the live fact **unless a human edited it**" policy. A human IP edit through the
  node panel stamps `MANUAL` **server-side** (derived from `ipAddress` being present in the PATCH — never
  a client-settable field, so the provenance marker stays trustworthy); a `MANUAL` node's IP is never
  clobbered by a report thereafter.
- **Hardware serial → `Asset.serial` at confirm.** The pure `sanitizeSerial(host)` mapper (trims, drops
  the well-known dmidecode junk placeholders — `To be filled by O.E.M.`, `Default string`, all-same-char,
  … — case-insensitive) promotes a real discovered serial to the minted Asset's canonical `serial`. A
  unique-serial collision (`assets_serial_active_key`) **retries without the serial** rather than failing
  the confirm (the raw value still lives in `specs.host.hardware.serial`). `modelId` stays **null** — no
  `AssetModel` auto-create (a human product call).
- **Linked-Asset `specs` sync on every report.** When a confirmed node is asset-backed, each report also
  refreshes the linked Asset's `specs` inventory snapshot (host facts blob), so the Asset inventory panel
  stays fresh. Written **directly** (not via `AssetsService.update`) so it emits **no** `SPECS_CHANGED`
  history event per report (no audit-trail flooding) and **never** touches the Asset's human-owned
  `serial`/`name`/`modelId`; a soft-deleted asset is skipped. The three agent-owned keys
  (`host`/`software`/`reportedAt`) are replaced; every human-added specs key is preserved.
- ~~**Async:** heavy work (software-list diffing, search re-index) goes through a BullMQ queue on the
  same Valkey substrate ([[0053-async-workers-bullmq-valkey]]), copying the `import-commit` worker
  pattern. The endpoint returns fast (accepted), the work drains in the background.~~ — **never built;
  corrected below (2026-07-31, #1136).**

**Amendment (2026-07-31, #1136) — correction: ingestion is inline, there is no report queue.** The
struck bullet above describes a design that was never built, and the one that was built is the right
one. `InfraService.ingestReport` (`apps/api/src/infra/infra.service.ts`) runs the whole upsert inline
and synchronously — one `findFirst`, one `create`/`update`, an **awaited** linked-Asset specs sync —
and the ack is returned only once the row is durable. The single piece of background work is the
pre-existing fire-and-forget Meilisearch projection (`void this.syncNodeToSearch(…)`,
[[0035-search-architecture]]), which is not a queue. The code states the call in place: *"no new BullMQ
queue for MVP — reports are light; reuse the existing fire-and-forget search sync, add a queue only if
report volume ever makes the inline upsert slow."* At the estate this ADR targets (5–20 people, one
15-minute timer per host) a report is a millisecond-scale write: a queue hop would buy nothing and
cost an eventual-consistency window in which a just-reported host is not yet on the map, plus a Valkey
dependency on the one endpoint that should keep working when the rest of the stack is degraded. That
code comment's volume trigger stands as the revisit condition — no queue until the inline upsert is
measurably slow. // BullMQ ([[0053-async-workers-bullmq-valkey]]) remains the substrate for the heavy
jobs it was chosen for (import commit); reporting is simply not one of them.

### §4 — Liveness & staleness

`lastReportedAt` is the heartbeat. A periodic **sweeper** (a plain in-process `setInterval`, `unref`'d
— no BullMQ/`@nestjs/schedule` dependency; re-entrancy-guarded and skipped under `NODE_ENV=test`,
structured like the `ImportSessionGcSweeper`) flips any node whose
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
  `Bearer lzit_sa_<id>_<secret>`, IdP-independent, ~~audit-attributed~~. No new auth mechanism.
  // **corrected 2026-07-31, #1136:** the SA *lifecycle* is audited; the calls it makes are not
  attributed — see the §8 amendment.
- A **new single permission `infra:report`** is added to the frozen catalog
  ([[0046-roles-permissions-v2]]). The agent SA is granted **only** this. Beyond the report endpoint
  it opens exactly one read — the agent binary at `GET /agent/download`, gated on the same permission
  by design (§6) — and nothing else: no secrets, no assets, no other infra, no delete.
  ~~Worst case on a leaked token is **PENDING spam a human discards.**~~ — **understated; the §8
  amendment (2026-07-31, #1136) states the real worst case.**
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

**Amendment (2026-07-31, #1133) — every wait is bounded.** The original collector awaited Bun Shell,
which exposes no timeout, so a command blocked on a degraded NFS mount (`lsblk`) or a wedged BMC
(`dmidecode`) hung the run indefinitely. That is worse than a missing fact: the unit stays in
`activating`, and since `OnUnitActiveSec` only re-arms once a unit goes **inactive**, the timer never
fires again — the host then reads as OFFLINE on the map when in truth only the agent was stuck, so the
liveness bit of §4 reports a **false outage**. Now bounded in three layers:

- **Per command:** `run()` uses `Bun.spawn` (not `$`, which has no timeout) with a 10 s budget and
  `killSignal: SIGKILL`; a timeout degrades to `null`, i.e. an omitted fact — the §2 partial-report
  contract, unchanged. A guaranteed-return race covers the case the kill cannot land, because a
  process in uninterruptible I/O ignores even SIGKILL until the I/O completes.
- **Per report:** the POST carries `AbortSignal.timeout(30 s)`, so a black-holed connection fails
  loudly and retries next tick instead of hanging.
- **Per run:** the systemd unit sets `RuntimeMaxSec=120`, reaping the whole cgroup if a child
  outlives the agent. The per-command budget is deliberately far below it, so a degraded host still
  assembles and sends a **partial** report — reporting less beats reporting nothing.

### §8 — Security model

- **Single-permission blast radius.** The agent SA holds only `infra:report` (§5).
- **Human gate.** Everything new is PENDING (§3); the official inventory is never mutated by a machine
  without human confirmation. ~~Auditability ([[0006-soft-delete-and-auditing]]) intact — agent writes
  are SA-attributed in history.~~ — **false; corrected below (2026-07-31, #1136).**
- **No secret exposure.** The agent carries no crypto and reads no vault; INV-10
  ([[0061-secret-manager-zero-knowledge]]) is untouched — the agent module never imports the secret
  manager's value side.
- **`curl | sh` posture.** The installer is served by the operator's own TLS-fronted instance
  (same-origin, no third party). The token is the operator's, scoped to one permission, revocable from
  the UI. A "download, inspect, then run" path is available for the cautious; the one-liner is the
  default.

**Amendment (2026-07-31, #1134) — throttling `POST /infra/report`.** The bullets above reason about
**authorization** and are right: one permission, a human gate, no secret reach, and a leaked token buys
nothing but PENDING proposals a human discards. They said nothing about **availability**, and that was
the gap: the endpoint is a write amplifier. Every unknown `externalId` mints a row carrying a `specs`
jsonb blob, so a leaked token — or, far likelier, a misconfigured `OnUnitActiveSec=1s` — was unbounded
row creation and unbounded jsonb churn on a self-hosted box with no ceiling. "Spam a human discards" is
true of the *inventory*; it is not true of the *database*. Two throttles close it, both keyed on the
**server-resolved principal** and both **in-memory** — no new column, no FK, no index, no migration:

- **Reports per window** (`InfraReportRateLimitGuard`, the fourth sibling of the
  setup/login/password-reset limiters in [[0086-local-authentication-mode]]). Keyed on the SA id,
  **never the IP**: reporting agents sit behind a shared egress NAT, so an IP bucket would let one
  noisy agent starve every other host at the same site. The SA id is also the only *trustworthy* key —
  `reportingSource` is a client-chosen body field an attacker rotates per request, while the SA is
  resolved server-side from the bearer token. A non-service caller (a human role holding
  `infra:report`) falls back to the verified `req.ip` rather than going unthrottled. Default
  **120/min** (`INFRA_REPORT_MAX_PER_WINDOW`, `INFRA_REPORT_WINDOW_MS`).
- **NEW nodes enrolled per window** (`InfraNodeEnrollmentLimiter`). The rate limit bounds how often a
  reporter may *call*; this bounds how many of those calls may *grow the table*. Default **100 per
  hour** (`INFRA_REPORT_MAX_NEW_NODES_PER_WINDOW`, `INFRA_REPORT_NEW_NODE_WINDOW_MS`), 429 past it.
  Only the CREATE branch is charged — a known host's check-in adds no row and is never charged, so a
  reporter that *has* tripped the limit keeps refreshing the hosts the operator already has and a
  tripped limit can never manufacture a false outage on the map (§4).

**The two defaults are coherent by construction:** both assume the same reference estate of **100
hosts sharing one operator token**, which is the shape `install.sh` actually produces. 120 reports/min
absorbs all 100 checking in inside one minute (a site-wide reboot re-arming every `Persistent=true`
timer at once); 100 enrollments/hour lets that same estate enroll *completely* inside one window, so a
greenfield rollout is refused by neither. Past that, growth is bounded at ~2,400 new rows/day instead
of the ~172,800/day the rate limit alone would still allow.

**Why a rate and not a stock cap.** The first design refused a report once the reporter already held
*N live PENDING proposals*. It was rejected: it measures accumulation, not growth, so it punishes an
operator with an untriaged tray exactly as hard as an attacker, and the only remedy it offers is to
triage or delete rows — which an instance upgrading with a large existing tray must do *before* its
next genuinely-new host can enroll. A rate has no such failure mode: pre-existing rows are irrelevant
to it, and a throttled reporter recovers by **waiting**. It also needed a trustworthy per-reporter key
*on the row* (a `reportedBySaId` FK), and per-SA isolation buys nothing today anyway — `install.sh`
writes the same token on every host, so "per service account" is already "per estate". Real
per-reporter isolation arrives with the enrollment-token → per-host-credential exchange (#1146); the
in-memory key is ready for it, and no migration was paid in advance.

**These are throttles, not hard ceilings** — stated plainly rather than overclaimed. The check is not
transactional with the insert, so concurrent reports can overshoot a window by the number of requests
in flight; the buckets are per-process, so N replicas allow N× the configured rate; and the window is
fixed, not sliding, so a reporter can enroll up to 2× the rate across a boundary. What they convert is
*unbounded* growth into *bounded* growth. The legitimate agent (one host, a report every 15 minutes)
never approaches either.

**Amendment (2026-07-31, #1136) — correction: ingestion is inline, there is no report queue.** The
struck bullet above describes a design that was never built, and the one that was built is the right
one. `InfraService.ingestReport` (`apps/api/src/infra/infra.service.ts`) runs the whole upsert inline
and synchronously — one `findFirst`, one `create`/`update`, an **awaited** linked-Asset specs sync —
and the ack is returned only once the row is durable. The single piece of background work is the
pre-existing fire-and-forget Meilisearch projection (`void this.syncNodeToSearch(…)`,
[[0035-search-architecture]]), which is not a queue. The code states the call in place: *"no new BullMQ
queue for MVP — reports are light; reuse the existing fire-and-forget search sync, add a queue only if
report volume ever makes the inline upsert slow."* At the estate this ADR targets (5–20 people, one
15-minute timer per host) a report is a millisecond-scale write: a queue hop would buy nothing and
cost an eventual-consistency window in which a just-reported host is not yet on the map, plus a Valkey
dependency on the one endpoint that should keep working when the rest of the stack is degraded. That
code comment's volume trigger stands as the revisit condition — no queue until the inline upsert is
measurably slow. // BullMQ ([[0053-async-workers-bullmq-valkey]]) remains the substrate for the heavy
jobs it was chosen for (import commit); reporting is simply not one of them.

### §4 — Liveness & staleness

`lastReportedAt` is the heartbeat. A periodic **sweeper** (a plain in-process `setInterval`, `unref`'d
— no BullMQ/`@nestjs/schedule` dependency; re-entrancy-guarded and skipped under `NODE_ENV=test`,
structured like the `ImportSessionGcSweeper`) flips any node whose
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
  `Bearer lzit_sa_<id>_<secret>`, IdP-independent, ~~audit-attributed~~. No new auth mechanism.
  // **corrected 2026-07-31, #1136:** the SA *lifecycle* is audited; the calls it makes are not
  attributed — see the §8 amendment.
- A **new single permission `infra:report`** is added to the frozen catalog
  ([[0046-roles-permissions-v2]]). The agent SA is granted **only** this. Beyond the report endpoint
  it opens exactly one read — the agent binary at `GET /agent/download`, gated on the same permission
  by design (§6) — and nothing else: no secrets, no assets, no other infra, no delete.
  ~~Worst case on a leaked token is **PENDING spam a human discards.**~~ — **understated; the §8
  amendment (2026-07-31, #1136) states the real worst case.**
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

**Amendment (2026-07-31, #1133) — every wait is bounded.** The original collector awaited Bun Shell,
which exposes no timeout, so a command blocked on a degraded NFS mount (`lsblk`) or a wedged BMC
(`dmidecode`) hung the run indefinitely. That is worse than a missing fact: the unit stays in
`activating`, and since `OnUnitActiveSec` only re-arms once a unit goes **inactive**, the timer never
fires again — the host then reads as OFFLINE on the map when in truth only the agent was stuck, so the
liveness bit of §4 reports a **false outage**. Now bounded in three layers:

- **Per command:** `run()` uses `Bun.spawn` (not `$`, which has no timeout) with a 10 s budget and
  `killSignal: SIGKILL`; a timeout degrades to `null`, i.e. an omitted fact — the §2 partial-report
  contract, unchanged. A guaranteed-return race covers the case the kill cannot land, because a
  process in uninterruptible I/O ignores even SIGKILL until the I/O completes.
- **Per report:** the POST carries `AbortSignal.timeout(30 s)`, so a black-holed connection fails
  loudly and retries next tick instead of hanging.
- **Per run:** the systemd unit sets `RuntimeMaxSec=120`, reaping the whole cgroup if a child
  outlives the agent. The per-command budget is deliberately far below it, so a degraded host still
  assembles and sends a **partial** report — reporting less beats reporting nothing.

### §8 — Security model

- **Single-permission blast radius.** The agent SA holds only `infra:report` (§5).
- **Human gate.** Everything new is PENDING (§3); the official inventory is never mutated by a machine
  without human confirmation. ~~Auditability ([[0006-soft-delete-and-auditing]]) intact — agent writes
  are SA-attributed in history.~~ — **false; corrected below (2026-07-31, #1136).**
- **No secret exposure.** The agent carries no crypto and reads no vault; INV-10
  ([[0061-secret-manager-zero-knowledge]]) is untouched — the agent module never imports the secret
  manager's value side.
- **`curl | sh` posture.** The installer is served by the operator's own TLS-fronted instance
  (same-origin, no third party). The token is the operator's, scoped to one permission, revocable from
  the UI. A "download, inspect, then run" path is available for the cautious; the one-liner is the
  default.

**Amendment (2026-07-31, #1134) — throttling `POST /infra/report`.** The bullets above reason about
**authorization** and are right: one permission, a human gate, no secret reach, and a leaked token buys
nothing but PENDING proposals a human discards. They said nothing about **availability**, and that was
the gap: the endpoint is a write amplifier. Every unknown `externalId` mints a row carrying a `specs`
jsonb blob, so a leaked token — or, far likelier, a misconfigured `OnUnitActiveSec=1s` — was unbounded
row creation and unbounded jsonb churn on a self-hosted box with no ceiling. "Spam a human discards" is
true of the *inventory*; it is not true of the *database*. Two limits close it:

- **A fixed-window rate limit keyed on the SERVICE ACCOUNT** (`InfraReportRateLimitGuard`, the fourth
  sibling of the setup/login/password-reset limiters in [[0086-local-authentication-mode]]).
  Keyed on the SA id, **never the IP**: reporting agents sit behind a shared egress NAT, so an IP bucket
  would let one noisy agent starve every other host at the same site. The SA id is also the only
  *trustworthy* key — `reportingSource` is a client-chosen body field an attacker rotates per request,
  while the SA is resolved server-side from the bearer token. A non-service caller (a human role
  holding `infra:report`) falls back to the verified `req.ip` rather than going unthrottled.
  Default **120/min** (`INFRA_REPORT_MAX_PER_WINDOW`, `INFRA_REPORT_WINDOW_MS`) — sized so a whole
  estate sharing one token, all timers re-arming after a site-wide reboot, still fits.
- **A hard cap on LIVE PENDING nodes per reporting service account** — default **50**
  (`INFRA_REPORT_PENDING_CAP`), 429 past it. The rate limit bounds writes per minute, not rows over
  time; without this a leaked token reporting fresh `externalId`s at a polite cadence still fills the
  table over days. Only the CREATE branch is budgeted (a known host's check-in adds no row and is never
  charged), and the count is scoped to **non-soft-deleted** rows — load-bearing, because discarding a
  proposal *is* the soft delete (§3), so counting deleted rows would mean an operator who tidies their
  tray never gets the budget back. Confirming frees a slot the same way.

This needs a trustworthy per-reporter key on the row, so `InfraNode.reportedBySaId` is added (nullable
FK → `ServiceAccount`, SetNull), stamped server-side on create **and re-stamped on every refresh** —
which is what makes it self-healing: rows predating the column are attributed within one report cadence.
The legitimate agent (one host, a report every 15 minutes) never approaches either limit and never even
triggers the budget probe.

**Amendment (2026-07-31, #1136) — correction: agent writes are UNATTRIBUTED, by design.** The struck
clause claimed a control this ADR does not have, in the one section that gets read precisely when
someone is deciding whether the report endpoint is safe to expose. A security ADR that overstates its
own controls is a liability, so state it plainly:

- **No principal reaches the write.** `ingestReport` calls `prisma.infraNode.create` / `.update` with
  nothing that identifies the caller. Nothing records *which* Service Account produced the row.
  (Updated by #1134: the handler now *does* take a `@CurrentPrincipal()`, but purely as the
  **in-memory throttle key** of the two limits above. It is read, bucketed and discarded — it reaches
  no `data` payload and no column, so this bullet's conclusion is unchanged.)
- **There is no node-history table to attribute to.** `InfraNodeHistory` does not exist — it is one
  of the deferred "Future" items in [[0070-infra-topology-graph]]. **No** `InfraNode` write is
  recorded in history, by an agent or by a human, so the struck clause described a table the schema
  has never had.
- **No history event is emitted, deliberately.** The linked-Asset specs refresh writes `specs`
  directly instead of going through `AssetsService.update` exactly so it emits no `SPECS_CHANGED`
  event (§3 amendment 2026-07-18). At one report per host every 15 minutes, an event per report would
  bury every human edit under ~96 no-op rows a day. The suppression is the right call; the consequence
  is that **no attribution row is written at all.**
- **`ServiceAccountAuditLog` does not cover it.** That table is the SA *lifecycle* log
  (`MINT`/`ROTATE`/`REVOKE`/`RESTORE`/`PERMISSION_CHANGE`) written by the service-accounts module —
  reporting writes nothing to it.

What contains the agent is therefore **not** attribution but the two controls above it, and they hold
on their own: a discovered host lands PENDING and cannot enter the official inventory until a human
confirms it — and *that* write **is** attributed, since `confirmNode` mints the backing Asset through
`AssetsService.create` with the operator's principal — while the SA holds `infra:report` and nothing
else. The realistic worst case on a leaked token is PENDING spam a human discards, plus forged
inventory facts (`specs`/`ipAddress`/`status`) on nodes the operator already confirmed. The one read
`infra:report` grants is the agent binary itself — `GET /agent/download` is gated on the same
permission (§6), by design, since the agent must be able to fetch its own build. No topology, asset,
KB or user data is readable, nothing is deletable, no secret is reachable. The forensic trail is
coarse but not empty:
`source=AGENT`, `reportingSource`/`externalId`, `agentVersion` and `lastReportedAt` on the node, plus
the SA's `lastUsedAt` stamped by the auth guard on every call. // The cheap way to buy the original
claim back, if a compliance review ever demands it, is one provenance row per node **CREATE** (not per
report) — deliberately not built today, because the per-report flooding is what made suppression
correct in the first place.

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
- Version handshake (agent stamps + reports its build; `InfraNode.agentVersion` + an "Agent outdated"
  hint when a MAJOR behind the server): [[0083-versioning-and-releases]] Amendment (2026-07-02), issue #907.
