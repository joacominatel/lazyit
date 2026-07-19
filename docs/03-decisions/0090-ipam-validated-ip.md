---
title: "ADR-0090: IPAM — validate the node IP as a value, not a string; no IP registry"
tags: [adr, infra, topology, validation, data-model]
status: accepted
created: 2026-07-18
updated: 2026-07-18
deciders: [Joaquín Minatel]
---

# ADR-0090: IPAM — validate the node IP as a value, not a string; no IP registry

## Status

**accepted** — 2026-07-18 (issue #847). The [[infra-node]] `ipAddress` has been a **label-only string**
since [[0070-infra-topology-graph]] deliberately cut IPAM from the visual-CMDB MVP. That cut was right
for *IP management* (allocation, subnets, DHCP) but too broad on one axis: it also skipped **format
validation**, so `10.0.0.256`, `10.0..5` or `myserver` persist silently and the agent-promotion path
([[0074-server-reporting-agent]] §3, #1081) could copy a garbage NIC value straight onto a node. This
ADR **amends [[0070-infra-topology-graph]] on the VALIDATION axis ONLY** — the IP becomes a *validated
value*, not a free string — and adds a **soft, non-blocking duplicate-IP conflict signal**. It does NOT
reopen the IPAM scope cut: no registry, no allocation, no ownership of the address space.

> **Scope.** A shared `IpAddressSchema` (native zod-v4 `z.ipv4()`/`z.ipv6()` union, trimmed — **no new
> dependency**) reused by BOTH write paths: the **manual edit** (`CreateInfraNodeSchema` /
> `UpdateInfraNodeSchema` → a clean `400` on garbage, free via the DTO) and the **agent promotion**
> (`primaryIpv4()` → **validate-or-drop**, never a `400` on a whole report — [[0074-server-reporting-agent]]
> §3). Plus a **display-only** `ipConflict` read field on `GET /infra/nodes/:id` = other LIVE nodes
> sharing the same `ipAddress`. **Non-goals (unchanged from [[0070-infra-topology-graph]]):** no
> `IpAddress`/`Subnet` entity, no allocation/reservation/DHCP, no `@unique`/partial-unique index on the
> IP, no IP on [[asset]], no per-NIC IP model, no CIDR/subnet math. The read schema stays tolerant
> (`InfraNodeSchema.ipAddress` remains `z.string().nullable()`) so legacy label-only rows still read.

## Context

- **The IP is already a first-class fact, not a cosmetic label.** #1081 made the reporting agent
  *promote* the report's primary IPv4 onto the node (`ipAddressSource` = `AGENT`/`MANUAL` decides who
  wins), and the drill-in and Servers list surface it. A fact that drives display and is refreshed on
  every agent check-in deserves to be *well-formed*; a free string that can hold `myserver` is a latent
  data-quality bug, not a feature.
- **Two writers, two correct failure modes.** A human typing an IP in the panel SHOULD get a `400` on
  garbage (fail fast, fix it now). The agent MUST NOT — a single bad NIC value can never `400` the whole
  inventory report ([[0074-server-reporting-agent]] §2/§3: a partial report is valid, a bad fact is
  dropped). One validator, two dispositions: reject at the DTO for the human, drop-on-parse for the agent.
- **"Same IP on two nodes" is the operator's real pain, but it is a SIGNAL, not a rule.** In a small
  self-hosted estate duplicate IPs happen legitimately and transiently (a rebuild, a NAT, a floating VIP,
  a stale node not yet archived). A hard `@unique` would block honest edits and fight the append/soft-delete
  posture. The [[0041-soft-delete-reuse-and-restore]] *live-unique* pattern (partial unique on
  `assets_serial_active_key` / `assets_assetTag_active_key`) is the right tool for identity columns that
  MUST NOT collide — the node IP is explicitly NOT one of those. So: surface the collision, never enforce it.
- **zod v4 ships the validators natively.** The schema file already uses top-level `z.cuid()`/`z.email()`/
  `z.url()`; `z.ipv4()`/`z.ipv6()` are the same family (zod ^4.4.3). No `ip-address`/`ipaddr.js` dependency
  — the laziest correct move (ponytail).

## Considered options

### Option A — status quo (label-only string)

Keep `z.string().trim().min(1).max(255)`. **Rejected:** it is the bug. Garbage persists; the agent
promotes malformed NIC values; the drill-in shows `myserver` as an "IP".

### Option B — validate-only value-object (no conflict signal)

A shared `IpAddressSchema` on both write paths (`400` for the human, drop-or-parse for the agent), but
no duplicate detection. **Rejected as insufficient:** it fixes *well-formedness* but leaves the operator's
loudest actual complaint — "why do two servers claim `10.0.0.5`?" — invisible. Cheap to extend to C.

### Option C — validate-and-normalize value-object **+ a soft duplicate-IP conflict signal** *(chosen)*

Option B **plus** a display-only `ipConflict` on the node-detail read: the other LIVE nodes carrying the
same `ipAddress`. Non-blocking, no DB constraint, computed per read. **Chosen** — it fixes the data-quality
bug AND surfaces the collision the operator cares about, without buying a network model.

### Option D — full IPAM registry

An `IpAddress` (and/or `Subnet`) entity, allocation/reservation/DHCP, a real `@unique`, IP on [[asset]],
per-NIC modelling. **Rejected:** exactly the scope [[0070-infra-topology-graph]] cut on purpose. lazyit is
an IT-native inventory for a 5–20-person team, not an IPAM/DDI product ([[vision]]: opinionated, no
ServiceNow-creep). This ADR is a validation upgrade, not a reversal of that cut.

## Decision (Option C)

1. **`IpAddressSchema` (`@lazyit/shared`, `schemas/infra.ts`).** A trimmed string validated as **IPv4 OR
   IPv6** via the native zod-v4 union — `z.string().trim().pipe(z.union([z.ipv4(), z.ipv6()]))`. **No new
   dependency.** Normalization is **trim-only** (zod validates but does not canonicalize IPv6, so
   `2001:db8::1` and its expanded form stay distinct strings — good enough for a display fact + a
   best-effort hint; it never rewrites what the operator typed).
2. **Manual edit gets validation free.** `CreateInfraNodeSchema.ipAddress` = `IpAddressSchema.optional()`,
   `UpdateInfraNodeSchema.ipAddress` = `IpAddressSchema.nullable()` (`null` still clears the IP → stamped
   `MANUAL` server-side, #1081). Garbage is a clean `400` at the DTO — no service code.
3. **Agent promotion is validate-or-drop.** `primaryIpv4(host)` returns its chosen candidate **only if it
   passes `IpAddressSchema`, else `undefined`**. A malformed NIC value can never reach a node's
   `ipAddress`; per [[0074-server-reporting-agent]] §3 the bad fact is silently dropped, **never a `400`
   on the whole report** (the raw value still survives verbatim in `specs.host`).
4. **Read tolerance preserved.** `InfraNodeSchema.ipAddress` stays `z.string().nullable()` — a legacy
   label-only row (pre-#847) reads without a validation trap. Validation lives on the WRITE boundary.
5. **Soft duplicate-IP conflict signal.** `GET /infra/nodes/:id` (`InfraNodeDetailSchema`) gains a new
   read field **`ipConflict`** — the other LIVE (`deletedAt IS NULL`) nodes sharing this node's exact
   `ipAddress`, as lean `{ id, label, kind, status }` peers (self excluded; `[]` when the node has no IP
   or no peer shares it). It is **`.nullish()`** on the wire (an older API omits it → the client treats it
   as "no conflict"), a scoped `findMany` (**no migration**, no new index), and **display-only** — it
   drives a badge and NEVER blocks a create/update. Exact-string match (the trim-only normalization
   above), an accepted best-effort limit for a hint, not a network-truth engine.

## Consequences

- **Positive:** the node IP is now a *validated value* end-to-end; the human fails fast, the agent drops
  garbage without ever failing a report, and the operator finally sees "N other nodes claim this IP" —
  all with **zero new dependency, zero migration, zero DB constraint**, one shared value-object, and the
  validate-or-drop guarantee unit-tested in `packages/shared/src/schemas/infra.test.ts`.
- **Negative / trade-offs (accepted):**
  - **Trim-only normalization** means two nodes with the same IPv6 typed in different forms won't pair in
    `ipConflict`, and the stored value isn't canonicalized. Accepted — canonicalization is IPAM-adjacent
    scope for a display hint (ponytail: revisit only if it ever bites).
  - **No enforcement**: `ipConflict` is advisory. A genuine duplicate can persist; that is deliberate
    (legitimate transient duplicates in a small estate — a rebuild, a floating VIP). If hard uniqueness is
    ever wanted, the [[0041-soft-delete-reuse-and-restore]] live-unique partial-index pattern is the way,
    and would be its OWN decision (a migration + a real failure mode).
  - **Stricter write than before**: an operator who was (ab)using `ipAddress` as a free note now gets a
    `400`. Acceptable — the field was always documented as an IP; free notes belong in `specs`/`label`.
- **Follow-ups (frontend, separate change):** the `ipConflict` **badge** on the node drill-in (and its
  Manual page, en+es) — user-facing, so shipped in the web change that consumes this contract, not here.

Related: #847 · #1081 · [[infra-node]] · [[0070-infra-topology-graph]] · [[0074-server-reporting-agent]] ·
[[0041-soft-delete-reuse-and-restore]] · [[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] ·
[[shared-package]]
