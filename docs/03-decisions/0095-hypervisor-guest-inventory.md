---
title: "ADR-0095: One hypervisor collector with autodetection — the agent inventories its own guests"
tags: [adr, infra, topology, agent, inventory, backend, shared, installers]
status: proposed
created: 2026-08-05
updated: 2026-08-05
deciders: [Joaquín Minatel]
---

# ADR-0095: One hypervisor collector with autodetection — the agent inventories its own guests

## Status

**accepted** — 2026-08-05 (issue #1217, epic #1146 item 9 reshaped). Decisions taken under explicit
CEO delegation (2026-08-05, "tomar tus decisiones recomendadas"); each recommended decision is
recorded with its reasoning. It **extends** [[0074-server-reporting-agent]] (§1/§3/§7) and reuses
[[0093-chassis-routing-and-asset-adoption]]'s corroboration discipline for guest identity. It
**replaces the shape** of epic #1146 item 9 (a server-side scheduled Proxmox collector on BullMQ),
which was blocked by its own stated catch: a server-readable hypervisor credential that the
zero-knowledge Secret Manager ([[0061-secret-manager-zero-knowledge]], INV-10) structurally cannot
provide.

> **Scope.** ONE collector, shipped inside the existing reporting agent, that **detects it is
> running on a hypervisor host and inventories that host's own guests** — locally, as root, with
> **no credential, no network reach, no new command**. Platforms in this record: **Proxmox VE**
> (the priority), **Hyper-V** (via the Windows agent already on the host), **generic libvirt/KVM**
> (the free bonus). **VMware ESXi/vCenter is declared a remote-only platform and deferred to a
> follow-up ADR** (§Considered options B) — the *contract* below is platform-agnostic, so VMware
> data slots in the day its collector exists, with zero contract change. **Non-goals:** no network
> scanning, no remote hypervisor APIs from the agent, no credentials on the policy channel
> ([[0074-server-reporting-agent]] §7 rules intact), no guest software inventory via the host, no
> metrics, no qemu-guest-agent dependency.

## Context

- **The market-fit fact.** Proxmox is the dominant hypervisor in lazyit's segment (epic #1146
  item 9). A small-team estate typically has 1–5 hypervisor hosts running the workloads that
  matter; today each guest must run its own agent to exist on the map, and the host↔guest
  topology (`RUNS_ON`) is invisible unless drawn by hand.
- **The blocked prior shape.** Item 9 proposed a server-side scheduled collector calling the
  Proxmox HTTP API — and honestly recorded that it requires a stored API token the server can
  read, "a separate server-decryptable credential concept" needing its own ADR. That
  credential problem **does not exist on the host itself**: a PVE node is a full Debian where the
  Linux agent already runs, and `pvesh` invoked by root calls the API layer in-process — the
  official man page: *"directly invoke API functions, without using the REST/HTTPS server. Only
  root is allowed to do that."* No token, no ticket, no TLS.
- **The boundary that makes it legal.** [[0074-server-reporting-agent]] §1 scopes the agent to
  *"Self only — the host the agent runs on"* and rejects network scanning. The §3 amendment
  (#1139) already crossed the host→child line for containers with a defence that transfers
  verbatim: *"it is the local runtime's own list of what it is executing, read over a local
  socket — not a network scan."* A hypervisor's guest list read from `pvesh`/WMI/`virsh` on the
  host itself is exactly that. Reading a **remote** vCenter or a cluster peer's API over the
  network is the rejected axis and stays rejected here.
- **Half the machinery exists.** `InfraNodeKind.VM` exists; `PLAUSIBLE_EDGE_TARGETS` already
  sanctions `VM RUNS_ON PHYSICAL_HOST` and `CONTAINER RUNS_ON PHYSICAL_HOST|VM`
  (`packages/shared/src/schemas/infra.ts:2023-2038`); child nodes ride the same
  `(reportingSource, externalId)` unique index via a namespaced key (no migration);
  `applyContainerTopology` (`apps/api/src/infra/infra.service.ts:1949`) is the battle-tested
  host→child reconcile template (reported-set diff, enrollment charge per child skip-not-break,
  vanished→OFFLINE never deleted, self-healing `RUNS_ON` via `openMissingRunsOnEdges`); the
  PENDING tray, bulk confirm and auto-confirm rules absorb "one host proposes N children".
- **The real design problem is identity, not transport.** The host knows a guest's VMID and
  SMBIOS UUID but not its `/etc/machine-id`. A host-proposed guest node can never share an
  `externalId` with the node that same guest's own in-guest agent mints — **two nodes for one
  machine** unless this record specifies the join. The join key exists on every platform in
  scope: Proxmox writes `smbios1: uuid=<UUID>` into the VM config and QEMU exposes exactly that
  value inside the guest as `/sys/class/dmi/id/product_uuid`; Hyper-V's `BIOSGUID`
  (`Msvm_VirtualSystemSettingData`) and VMware's `bios_uuid` are the same fact. The agent
  already collects it in-guest (`smbios-uuid` in `host.identifiers[]`), and `findIdentityMatches`
  / `mergeNodeInto` (`infra.service.ts:3404/:3290`) already exist server-side.
- **Prior-art convergence.** ohai and facter both learned the same lesson (nested virt broke
  single-answer detection): report **facets, not a scalar** — a box can be guest and host at
  once. netdata's collector model (probe well-known paths/sockets, enable on success, config
  only to override) is the CEO's "zero config, un flag para desactivar" verbatim. telegraf,
  Datadog and every NetBox sync tool use remote APIs with tokens **because they run off-host**
  — none has lazyit's on-host-root option, which strictly dominates where available.

## Decision

### 1. Collection runs on the hypervisor host, inside the existing agent

The agent gains one new collector, `collectGuests`, dispatched alongside the existing host
collectors on every tick. It runs **only** when host-side detection (§2) fires, reads **only
local** sources (`pvesh` / WMI / `virsh` on the box it runs on), and degrades to a warning when
the probe fails. No new command, no new install step: the operator installs the agent on the
hypervisor host exactly like on any other server — the one-liner from
[[0094-assisted-agent-update]]'s fleet view included — and the guests appear in the PENDING tray.

**VMware is out of this collector by evidence, not preference:** ESXi 8 enforces
`execInstalledOnly` by default (the kernel refuses to exec any binary not delivered in a signed
VIB; disabling it is a STIG finding and a ransomware-protection downgrade), ESXi's userworld is
not Linux (a Bun-compiled binary will not load), and SSH/shell access is off by default with
every hardening baseline agreeing it stays off. "Install the agent on the hypervisor" is
therefore **Proxmox/Hyper-V/libvirt-shaped, never ESXi-shaped**. The VMware path is a
**server-side scheduled collector** (vCenter REST is plain HTTPS + JSON, no SDK) with a
server-decryptable read-only credential following [[0091-on-prem-ad-ldap-directory-source]]'s
envelope pattern (its "explicit inverse of INV-10" reasoning transfers unchanged) — a real
architectural step that gets its own ADR instead of a paragraph here. This record's contract
(§3) already carries VMware's data shapes (`bios_uuid` **is** the SMBIOS UUID, modulo a
byte-order normalization recorded in §6).

### 2. Detection: facets, most-specific-wins, re-probed every tick

Detection answers two independent questions, always both: *am I a guest* (the existing
`systemd-detect-virt`/DMI path, unchanged) and *am I a host* (new). Signals, evaluated
cheapest-and-strongest first:

| Platform | Predicate (all parts required) | Why this one |
| --- | --- | --- |
| **Proxmox VE** | `/etc/pve` is a **mounted FUSE fs** (pmxcfs alive, not a leftover dir) **and** a scoped `pvesh get` succeeds | detection and capability probe in one; `/etc/os-release` says only "Debian"; stable across PVE 7/8/9 |
| **Hyper-V host** | `vmms` service exists **and** WMI namespace `root\virtualization\v2` exists | exists only where the management stack is installed. **Never CPUID "Microsoft Hv"** — the host's own root partition reports it too (the classic false positive) |
| **libvirt/KVM** | `/dev/kvm` exists **and** libvirt daemon active (or its socket present) **and** `virsh` present | `/dev/kvm` alone = "capable", not "acting hypervisor"; reported as capability, collects nothing |
| **XCP-ng/XenServer** | `/etc/xensource-inventory` exists and `/proc/xen/capabilities` contains `control_d` | **detection recorded, collection deferred**: dom0 is a locked-down CentOS derivative and the binary's glibc compatibility is untested — an honest "detected, not yet collected" warning beats a promise |

Precedence when several fire: **Proxmox > XCP-ng > Hyper-V > generic libvirt/KVM**. A PVE node
is also Debian+KVM, and `virsh` on PVE sees *nothing* (Proxmox does not use libvirt) — the most
specific platform selects the one collection module that runs. Container-runtime facets
(Docker/Podman, already collected) never compete for the platform slot and keep running
orthogonally. Nested virt reports both axes: a PVE lab node inside a VM is `virtualization:
{type: kvm}` **and** a hypervisor host — both true, both sent.

Detection re-runs on **every tick**, exactly like the Docker socket probe (`linux.ts:411-414`):
enable the Hyper-V role or install PVE a month after the agent, and the next report just has
guests. The installer's banner (§8) is informational, never authority.

### 3. The report contract: `host.hypervisor` + `host.guests[]`

Two new **optional** keys on `AgentReportSchema.host`, plain `z.object` like every sibling
(forward-compat: an old server strips them silently and records the skew paths —
`infra.ts:982-996` — so a new agent against an old server degrades instead of 400-ing):

- **`host.hypervisor`** — the host facet: `{ platform: 'proxmox'|'hyperv'|'libvirt'|'xcpng'|'other',
  version?, clusterName?, nodeName? }`. On PVE, `nodeName` comes from the `/etc/pve/local`
  symlink target (authoritative; the hostname-vs-node-name mismatch is telegraf's documented
  footgun) and `clusterName` from `/cluster/status`, so the server can group cluster members and
  disambiguate "same vmid, different cluster".
- **`host.guests[]`** — the guest inventory, capped `AGENT_GUESTS_MAX = 500` per report.
  Per guest: `{ ref, name, kind: 'qemu'|'lxc'|'hyperv'|'libvirt', state, smbiosUuid?, macs[],
  cores?, memoryBytes?, osHint? }`. `ref` is the platform's stable per-host handle (PVE vmid,
  Hyper-V VMId GUID, libvirt domain UUID). `smbiosUuid` and `macs` exist for exactly one
  purpose: the §6 identity join. Absent `guests` ≠ empty `guests` — same semantics the
  containers channel already has (§3 of ADR-0074, #1139).

Vocabulary schemas follow the degrade-never-reject house rule (`infra.ts:460-465`): unknown
platform/kind strings fold to `'other'`, never fail the report.

### 4. Per-platform recipes (the collector's whole contract with each platform)

- **Proxmox VE** (Linux agent, root): `node=$(basename "$(readlink -f /etc/pve/local)")`, then
  `pvesh get /nodes/$node/qemu --output-format json` + `.../lxc --output-format json`, then per
  guest `.../config --output-format json` for `smbios1.uuid`, `net0..N` MACs, `ostype`, cores,
  memory. **Each node reports only its own guests** — a guest's config lives under exactly one
  `nodes/<name>/` directory in pmxcfs at any moment, so a cluster of N agent-carrying nodes has
  zero overlap *by construction*, and a migration is simply "node A stops reporting vmid 104,
  node B starts". `/cluster/resources` (cluster-wide) is deliberately **not** used.
  `qm list`/`pct list` (parse-hostile ASCII) and raw `/etc/pve/*.conf` reads are rejected.
  qemu-guest-agent queries (`qm guest cmd …`) are **not in v1**: they hang up to the agent
  timeout on wedged guests and add nothing to identity (§6 needs config facts only).
- **Hyper-V** (Windows agent): one PowerShell document alongside the existing facts script —
  `Get-VM` (VMId, name, state, cores, memory; requires only the Hyper-V module and
  Administrators *or* the "Hyper-V Administrators" group), `Get-VMNetworkAdapter` for MACs, and
  one CIM query on `Msvm_VirtualSystemSettingData` (`root\virtualization\v2`) for `BIOSGUID` —
  the SMBIOS UUID the guest sees, which `Get-VM` itself does not expose.
- **libvirt/KVM** (Linux agent, root): `virsh -c qemu:///system list --all --name`, then one
  `dumpxml` per domain — the only machine-stable output virsh has (no JSON exists; the
  human tables are explicitly not parsed): `<uuid>` (the SMBIOS UUID QEMU exposes in-guest),
  `<name>`, `<vcpu>`, `<memory>`, every `<interface><mac address=…>`. The URI is explicit —
  root's default can surprise on modular-daemon distros.

All of it inside the existing budgets: each command under the 10 s `COLLECT_TIMEOUT_MS`, the
whole run inside systemd's `RuntimeMaxSec=120` — one list call per type plus N bounded config
reads fits comfortably at small-team scale (the PVE API has no pagination; lists arrive whole).

### 5. Server ingest: a second child namespace, the container reconcile parameterized

A new child key namespace **`/guest/`** beside `/container/`:
`externalId = <hostExternalId>/guest/<ref>` on the same partial unique index — no column, no
migration. `applyContainerTopology`'s shape is parameterized (or mirrored) into a guest
reconcile with the same hard-won properties: reported-set diff, skip-when-unchanged, each new
child charges an enrollment slot (**skip, don't break** — a spent budget must never invent a
false outage), vanished guests → `OFFLINE` never deleted, `openMissingRunsOnEdges` self-heals
`RUNS_ON` (one active edge per source, close-before-open).

Child `kind` derives from the guest's own nature, not a hardcode: `qemu`/`hyperv`/`libvirt` →
`VM`; `lxc` → `CONTAINER`. Both edges are already plausible
(`PLAUSIBLE_EDGE_TARGETS.RUNS_ON`). Children stay `state: 'PENDING'` into the existing tray,
`defaultTrackAsAsset` follows the existing rules (container children default OFF; VM children
default OFF too — a VM becomes an Asset when an operator says so, or when its own in-guest
agent's confirm does, per [[0093-chassis-routing-and-asset-adoption]]). **Chassis is never
written for a child** — consistent with ADR-0093 §2; a guest's chassis arrives when its own
agent reports.

A 200-VM host against the 100/hour enrollment window enrolls **gradually over two windows** —
accepted and documented rather than raising the cap: the budget exists to keep a
misconfigured or hostile service account from flooding the tray, and a one-time two-hour
ramp-in on first install is the cheap side of that trade.

### 6. The identity join: corroborated SMBIOS UUID, guest-agent node wins

The two-nodes-for-one-machine problem is resolved with ADR-0093's discipline — **one notion of
"same machine", corroborated, never a single-signal auto-merge**:

- A `/guest/` child stores its `smbiosUuid` (normalized: lowercased; VMware's raw-VMX byte
  order — first three fields byte-swapped vs. the guest's pretty-print — is normalized at the
  edge the day that collector lands) and `macs` in its specs blob.
- When a report's own `host.identifiers[]` carries an `smbios-uuid` matching a live `/guest/`
  child **and** at least one MAC corroborates (`canonicalMac` both sides), the in-guest node and
  the host-proposed child are the same machine. **The guest's own agent-reported node is
  canonical** — it has the machine-id, the software inventory, the real identity evidence. The
  child is absorbed into it (existing `mergeNodeInto`), and the `RUNS_ON` edge lands on the
  canonical node. UUID alone **never** merges: clones demonstrably duplicate BIOS UUIDs
  (VMware KB 321451; PVE clones regenerate `smbios1` but templates deployed outside the happy
  path exist) — uncorroborated matches surface as the existing display-only duplicate-suspicion
  hint, an operator call.
- Without an in-guest agent, the child **is** the guest's node — confirmable, trackable,
  OFFLINE when it vanishes. A cross-node migration inside a PVE cluster appears as old child
  OFFLINE on node A + new child on node B; the same corroboration surfaces them as
  duplicate-suspects for a one-click operator merge. **v1 does not auto-merge migrations** —
  same reasoning as ADR-0093's no-retroactive-re-linking: wrong merges are expensive, hints are
  cheap.

### 7. Policy flag and the rollout order it forces

`collect.hypervisor` becomes the **sixth** key of `AgentPolicyCollectSchema`, **default `true`**
(zero-config: detection gates collection; the flag exists to say no). The local veto
`LAZYIT_COLLECT_HYPERVISOR=false` rides the existing veto-never-widen contract
([[0074-server-reporting-agent]] §7) and — because the installers preserve every unrecognized
`LAZYIT_*` key verbatim — survives `--upgrade` with **zero installer changes**.

The strict-policy asymmetry is handled honestly: an old agent receiving a six-key policy fails
`safeParse` **wholesale** and keeps its cached policy (`apps/agent/src/index.ts:293-299` — by
design). So the server **projects** the policy per agent at ack time: agents whose
`agentVersion` predates the flag receive the five-key shape (the semver machinery from
[[0094-assisted-agent-update]] already grades versions; `dev`/unparseable get the five-key
shape too — fail-soft). On the agent side the new schema key carries `.default(true)`, so a
new agent against an old server parses the five-key policy and simply applies the default.
Neither direction stalls a policy generation. The four-places-move-together checklist
(schema+default, agent `COLLECT_KEYS`, installer config templates, agent help text) plus the
Settings → Reporting agents UI land in one change.

### 8. Operator surface: zero config, one honest banner, one Manual page

- **Installers**: print a detection summary as an operator-trust feature — *"Detected: Proxmox
  VE 8.4 — this host's QEMU VMs and LXC containers will be inventoried (disable with
  --no-hypervisor)"* — where `--no-hypervisor` / `-NoHypervisor` just writes the veto into the
  config template. Informational only: the agent re-detects every tick, the banner never
  becomes stale authority. The CEO's bar — one command, at most one extra parameter — is met
  with the parameter being **optional and negative**.
- **Manual** (`apps/web/content/manual/{en,es}`, ADR-0062): one page — install the agent on the
  hypervisor host like any server; what appears (guests in the review tray, `RUNS_ON` on the
  map); how the in-guest agent and the host's view become one node; the veto; ESXi honestly:
  "VMware hosts cannot run agents; vCenter support is planned as a server-side connection."
- **Fleet/topology UI**: guests ride entirely on existing surfaces (tray, canvas, node panel).
  No new screens in this record.

## Considered options

- **A. On-host collector inside the existing agent — CHOSEN.** No credential (root reads its
  own hypervisor locally), no INV-10 tension, inherits every hard-won agent property (policy
  vetoes, budgets, PENDING gate, staleness, assisted update), covers the priority platform
  natively, and stays inside ADR-0074 §1 via the #1139 local-runtime defence.
- **B. Server-side scheduled collector with stored API token** (epic item 9's original shape) —
  **DECLINED for the platforms in scope, NAMED as the VMware follow-up.** For PVE/Hyper-V/libvirt
  it is strictly worse: it adds a server-decryptable credential concept, cert handling against
  self-signed endpoints, and reachability coupling — to obtain data root already has locally.
  For ESXi/vCenter it is the **only** shape (§1 evidence), and its ADR should follow
  [[0091-on-prem-ad-ldap-directory-source]]: dedicated envelope crypto axis, `setInterval`
  sweeper (the repo has zero BullMQ repeatables), read-only role, write-only credential wire.
- **C. Installer-downloads-the-right-collector-script** (an auto-selecting downloader) —
  **DECLINED.** It reintroduces the version-skew axis ADR-0074 §6 eliminated and walks straight
  at §7's *"no server-pushed commands, scripts, paths or file reads. Ever."* One binary that
  detects at runtime gives the same UX with none of the surface.
- **D. Extending `host.containers[]` for guests** — **DECLINED.** Different key namespace,
  different fields (UUID/MACs for identity vs image/ports), different child kinds, and the
  containers channel's semantics (#1139's absent-vs-empty, name-derived keys) are load-bearing;
  generalizing it risks the working half to save one array.

## Upgrade behavior (workflow rule #8)

Additive everywhere: two optional report keys (old server: stripped + skew-recorded; old agent:
never sends them), one policy key handled by ack-time projection + client default (§7 — neither
direction stalls), a new child namespace on the existing index (no migration), no schema
change, no backfill. Existing container children, edges, confirmed nodes: untouched. An
operator who updates the server first sees nothing change until an agent updates — and the
fleet view from ADR-0094 names exactly which hosts those are.

## Known limitations (recorded, not hidden)

- `ingestCollidingHost` returns before child reconciliation (`infra.service.ts:1674/1711`) — a
  hypervisor host with a cloned machine-id reports no guests until its identity conflict is
  resolved. Pre-existing (#1139 containers have the same property); noted for the tray copy.
- XCP-ng: detected and surfaced, not collected (§2). Its recipe (`xe vm-list` +
  `/etc/xensource-inventory`) is recorded in #1217 for when demand exists.
- PVE cross-node migration produces an OFFLINE/new child pair pending operator merge (§6) —
  unless the guest runs its own agent, in which case the canonical node just re-points.

## Consequences

- One agent install on a PVE host puts the whole guest estate on the map with `RUNS_ON` edges —
  the "punto fuerte" lands as: *install the same agent, same one-liner, on the hypervisor*.
- The identity join makes the in-guest agent and the host's view converge on one node instead
  of forking the inventory — and it reuses ADR-0093's corroboration rather than inventing a
  second same-machine notion.
- VMware ships later but slots into a contract already designed for it; the honest cost is a
  second ADR with a credential story this record refused to rush.
- The strict-policy projection (§7) is new server-side complexity — the price of ADR-0074 §7's
  reject-unknown-policy rule, paid once and reusable for every future collect flag.

## References

- Epic #1146 item 9 (original shape + its recorded blocker) · #1139 (containers-as-children) ·
  #1217 (this work)
- [[0074-server-reporting-agent]] §1/§3/§7 · [[0093-chassis-routing-and-asset-adoption]] ·
  [[0094-assisted-agent-update]] · [[0091-on-prem-ad-ldap-directory-source]] ·
  [[0061-secret-manager-zero-knowledge]]
- Proxmox: pvesh man page (root in-process API), pmxcfs, qemu-server `smbios1` ↔ guest
  `product_uuid` · VMware: Broadcom KB 344815 (`execInstalledOnly`), KB 321451 (duplicate BIOS
  UUIDs), vSphere Automation REST · Hyper-V: `Msvm_VirtualSystemSettingData.BIOSGUID` ·
  libvirt: virsh manpage (no JSON; `dumpxml`) · Prior art: ohai facets, netdata probe-and-enable,
  telegraf/Datadog/NetBox-sync (remote-token camp)
