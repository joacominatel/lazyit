---
title: "ADR-0074: Server reporting agent — self-installing Linux collector that auto-reports inventory"
tags: [adr, infra, topology, agent, inventory, backend, frontend, shared, devops, security]
status: accepted
created: 2026-06-27
updated: 2026-08-02
deciders: [Joaquín Minatel]
---

# ADR-0074: Server reporting agent — self-installing Linux collector

> [!note] ~~Linux collector~~ — **Linux and Windows**, since the 2026-08-02 (#1144) amendment to
> §6/§7 below. The title and the `title:` frontmatter are left as they were written: this ADR is a
> dated record, not a living document, and rewriting its heading would erase which decision was
> made when. Every statement in it that says *Linux* and is now narrower than the code is
> corrected in that amendment.

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
| **Trust** | **Review tray** — new hosts arrive `state=PENDING`, `source=AGENT`; a human confirms. **Qualified by the 2026-08-01 amendment below: with an operator-authored auto-confirm rule saved, a proposal that rule matches is confirmed by the machine.** | ~~Auto-confirm~~ → **blanket** auto-confirm, i.e. with no operator-authored rule (any agent noise dirties the official inventory with no containment). |

**Amendment (2026-08-01, #1145) — the gate is right; exercising it one dialog at a time is not.** The
problem is the **cost** of the gate. The §3 amendment (#1139) named it as a real and separate problem
in the same breath as it created it — a single Docker host now enrols **itself plus one CONTAINER
child per running container**, so one modest host produces dozens of tray rows where it used to
produce one — and the tray answered with a Confirm/Discard pair per row, each opening a dialog, with
no selection, no bulk action, no filter and no sort. At that shape the gate is not a control an
operator exercises; it is one they route around by discarding in bulk or by never rolling the agent
out past a handful of hosts. **A control nobody can afford to use is not containment.**

**What this amendment does to the Trust row, stated plainly.** Two of the three mechanisms below are
ergonomics and change no policy. The third — **saved auto-confirm rules** — changes what the Trust row
describes, and pretending otherwise would be the more dangerous half of shipping it. With a rule saved,
a proposal it matches is confirmed *by the machine, inside the report request, with no human looking at
that row*, and the Asset it mints is created then and there. So: **not** every proposal still lands
PENDING, and a machine **does** write the official inventory for the rows a rule covers.

What stays rejected is what §1 actually rejected: **blanket** auto-confirm — an inventory that
populates itself with no human decision anywhere. The shift is in *when* the human decides, not
whether. An operator authors a rule once and the machine then applies **that operator's judgement** to
rows the operator never sees individually; a rule that could not rule any proposal out is refused on
write and ignored on read, precisely so "a rule" cannot degenerate into "everything". That is a real
transfer of a human step, made deliberately, and it widens the `infra:report` blast radius — §8's
*"the realistic worst case on a leaked token is PENDING spam a human discards"* no longer holds
unchanged once an instance has rules. The §8 amendment below states the new worst case; it is not
buried here.

Three mechanisms, in ascending order of how much they change:

**1. Bulk confirm / discard, which are the SINGLE actions run per item.** `POST
/infra/nodes/bulk-confirm` takes `{ items: [{ id, trackAsAsset?, kind?, label? }] }` and applies each
through the very `confirmNode` a tray click calls; bulk discard is the existing soft delete over a
set. Overrides are **per item, not per batch**: `label` is not a batch concept (renaming forty nodes
to one string is never what anyone meant), and a host and its containers want *different*
`trackAsAsset` answers, which one batch-level flag could not express. Delegation rather than a second
implementation is the load-bearing choice — there is no second Asset-minting path, no second serial
promotion and no second idempotency rule to keep in step, so bulk confirm is structurally incapable of
having semantics of its own. Each route carries the **same** gate as the single action it batches — bulk
confirm `infra:manage` + `asset:write` + `HumanOnlyGuard`, exactly like `POST /nodes/:id/confirm`;
bulk discard `infra:manage`, exactly like `DELETE /nodes/:id`. Anything weaker would be a cheaper door
onto the same write.

Outcomes are **per item** (`applied` / `skipped` / `notFound` / `failed` with the message the single
action would have returned) rather than one all-or-nothing verdict — the degrade-never-reject posture
of §2, applied to a human action. One node failing on a serial collision, or one another operator
discarded a second earlier, must not throw away the thirty-nine that succeeded and leave the operator
unable to tell which. Bounded at 200 items and applied **sequentially**: each item can mint an Asset
and re-index, so firing a batch at once is a thundering herd against the same tables, and a failure
attributable to one row is worth more than the milliseconds concurrency buys. The tray enforces that
bound **before** the request — over the cap, the two buttons are disabled and say why, because a
201-item batch is rejected whole and learning that from a toast after doing all of the selecting is
the one moment the information is useless.

**2. The tray groups by reporting host, and `trackAsAsset` inverts for a container child.** Grouping
is the direct answer to #1139: a host and the containers it reported are one unit because that is how
they arrived and how the operator thinks about them, so the group header's checkbox takes the host
**and** its children — the "confirm a host with its containers" action expressed as a *selection*
rather than as a second endpoint with its own rules. A child whose host is no longer pending still
groups under that host, named from the already-loaded node list.

The default flips because the confirm's meaning does. `trackAsAsset` defaults **ON** and stays ON for
a host: a discovered server is exactly the thing [[0070-infra-topology-graph]] §5's default-on asset
linkage was designed for. A container is not that thing, and ADR-0070 §5 already said so — its create
path describes `trackAsAsset: false` as *"right for ephemeral containers"*. A container is replaced by
the next `docker compose up --force-recreate`, has no SMBIOS serial for the confirm path's serial
promotion to promote, and one Docker host can add dozens, so a default-ON bulk confirm would mint
thirty Assets nobody assigns, warranties or depreciates. Children therefore default **OFF**
(`defaultTrackAsAsset`, one shared definition the tray, the bulk dialog and the rule default all read
so they cannot disagree). What that shared definition is asked is *"can this reach a container
child?"*, not *"is this a CONTAINER rule?"* — so an **ANY**-scope rule takes the child default too,
which is what makes "they cannot disagree" true rather than nearly true. It is a **default, not a
rule**: every item and every rule can set it either way, so a container that genuinely is a licensed
appliance is tracked like anything else.

Filter (name glob or substring, subnet CIDR, reported kind, host-vs-container) and sort (first seen,
name) are **client-side over the already-loaded lean list**. #1135 removed `specs` from that
projection precisely because the tray polls it, and nothing here re-fattens it — a checkbox row reads
`label`, `kind`, `ipAddress`, `createdAt` and `externalId`, all of which the list already carries. The
subnet box uses the **same** `ipInCidr` the saved rules use, so *"which hosts would this rule have
caught"* and *"which hosts does this filter show"* can never be answered by two implementations.
Server-side paging of `GET /infra/nodes` is **out of scope** and tracked separately (#1152).

**What a bulk action touches is the VISIBLE selection, and one function decides that for every
surface.** The ticked-ids set outlives a filter change, and no action and no count is derived from it:
the number beside the buttons, the two dialogs and the ids in the request all come through
`visibleSelection`, so a row a filter hides leaves the action *and* the count in the same instant it
leaves the screen. (The checkboxes read the raw set, but only ever to draw a row already on screen.) Both halves
matter — the first makes the *click* honest, the second makes *"12 selected"* honest — and without
them *select all → narrow the filter → Confirm* confirms rows nobody looked at, which is the worst kind
of bulk action and precisely what the select-all label promises it is not. Re-widening the filter
brings a hidden row back, ticked and counted: deliberate, because that is *visible*, which is the
opposite of the failure being guarded. Clearing the selection outright on every filter change was
rejected — it would throw away a careful selection on one keystroke in the search box, and React's own
guidance (and the repo's blocking lint rule) refuse the `setState`-in-effect that pruning would need.

**3. Saved auto-confirm rules — the judgement expressed ONCE, not per host.** A rule is an
operator-authored row (`InfraAutoConfirmRule`) stating at least one condition that can rule a proposal
out — a hostname glob, a subnet CIDR, or the `kind` the server **proposed** — plus what to do:
`confirmAsKind` and `trackAsAsset`. It is evaluated on the report **CREATE** branch, and a match
confirms the node through `confirmNode` with the **rule author's** principal.

Blanket auto-confirm stays rejected, and the reasons are structural rather than intentional:

- **A rule whose conditions could exclude NOTHING cannot exist.** "At least one non-null condition"
  was the first attempt and it was not enough: `hostnamePattern: "*"` is non-null and matches every
  proposal there is, so it would have stored an ordinary-looking **blanket** rule through the front
  door. The test is therefore *can this rule rule a proposal out* — a hostname glob has to carry a
  literal character (`srv-*` and even `*.*` do; a glob made only of wildcards does not), a subnet has
  to be narrower than `/0`, and a reported kind always names one kind out of several. The wildcard-only
  test is **deliberately one notch stricter than "matches everything"**: `*`, `**` and `*?*` genuinely
  match every name there is, but `?` alone matches only one-character names and is refused with them
  anyway. Refusing is the safe direction and "carries a literal" is a line an operator can check by
  looking, where "could this glob ever exclude a hostname somebody actually runs" is not. Two
  conditions that each exclude nothing do not add up to one that does. It is enforced in three places — the
  create contract, the service on the MERGED patch (the patch alone cannot see the stored row), and
  the matcher, which refuses to act on such a row so a hand-inserted one or one left by an older build
  never fires either. One shared predicate, `statesAutoConfirmCondition`, answers all three and the
  rule form as well, so the form says it before the 400 does.
- **A human discard outranks every rule.** Discarding soft-deletes the node but keeps its reporting
  key, so the next report from that host creates a new node under the same key — and a matching rule
  would confirm it, and mint another Asset, on the very next check-in, making a human's "not this one"
  undoable by a machine that says it again every fifteen minutes. A key a human has already discarded
  is therefore enrolled as it always was and left **PENDING**, for that human to decide a second time.
  (A merge is not a discard and cannot be confused with one: `mergeInto` moves the reporting key to
  the adopting node, so only a genuine discard leaves a soft-deleted row still holding it.)
- **The rule IS the human decision.** `createdById` records who wrote it, `HumanOnlyGuard` refuses a
  service account outright — a machine authoring a rule would be the reporting agent granting itself
  the confirm §1/§8 denies it — and the Asset an auto-confirm mints is created with that operator's
  principal, so §8's *"that write **is** attributed"* stays literally true. A rule whose author was
  since deleted still fires, unattributed and visibly so on the rule: instance policy must not retire
  itself because someone left, and the alternative (silently confirming nothing) is a worse surprise.
- **A human can revoke it**, and disabling is the fast path — a disabled rule stops matching on the
  next report. Deleting soft-deletes it, keeping the record of the decision.
- **First match wins, in `createdAt` order**, shown as a number on each row. Not "most specific":
  specificity needs a metric operators must learn and maintainers must keep stable, and §3 already
  rejected a rule-precedence engine on that reasoning.
- **`matchCount` / `lastMatchedAt` are recorded**, because a rule that confirms hosts with no human
  present has to be legible. Without them the only way to learn a rule is misfiring is to notice nodes
  nobody approved — the exact failure the gate exists to prevent.

**Rules are NEVER retroactive, and that is a property of where they are called, not a flag.** They are
consulted on the create branches of `ingestReport` and `applyContainerTopology` — nodes being written
in that same request — and nowhere else. The known-host refresh does not consult them, so a proposal
already sitting in a tray the operator is looking at can never confirm behind them; the rule service
exposes no method that could walk existing nodes, which is asserted structurally by test. The UI and
the Manual both state it where the decision is made, not only in a release note.

**One branch deliberately never auto-confirms: the cloned-machine-id path (§3 / #1141).** A clone's
proposal exists precisely to be SEEN as a second row, and the archetypal clone shares its peer's
hostname — so a hostname rule would confirm exactly the duplicate that detection exists to surface.

**Failure degrades, it never fails the report.** The whole apply is wrapped: the node row is already
durable, so a rule store that is unreachable leaves the node PENDING — where it was going anyway, and
where the operator can act on it — while throwing would make the host vanish from the inventory, which
is the failure class §2's amendment exists to prevent.

**Rejected.** *Auto-confirm without an operator-authored rule* — §1's original call, unchanged.
*A batch-level `trackAsAsset`* — it cannot express the host/container split, which is the case the
whole amendment is about. *Reverting nodes when a rule is deleted* — they are confirmed inventory rows
a human policy approved, and un-confirming them would be as retroactive as applying a rule backwards.
*A rule-priority/reordering UI* — the §3 rejection of an identification-rule engine covers it; ordering
by creation and showing the number is enough for this estate size.

**Upgrade safety.** One **additive** migration: a new enum and a new table, no existing table touched,
no column dropped or made `NOT NULL` without a default, nothing to backfill. An instance that upgrades
lands with **zero rules**, which is byte-identical to the behaviour it had before — every discovered
host keeps arriving PENDING until a human confirms it. The bulk routes are new endpoints; the single
confirm, merge and discard routes are unchanged, so an operator who never opens the new affordances
sees exactly the tray they had, plus a filter bar. Nothing in the report path changes for an instance
with no rules beyond one indexed read that returns nothing.

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

**Amendment (2026-07-31, #1138) — contract v2: the wire is now actually OS-neutral, and the root
degrades instead of rejecting.** §1 calls this contract OS-neutral and the shape above is not, in three
specific places. It carries **no platform discriminator** — `os` is a free-text `{name, version,
kernel}` triple, so nothing downstream can branch on the platform. It carries **IPv4 only**, while the
shared `IpAddressSchema` has always accepted v6, so a v6-only host reported *no address at all*. And it
documents `externalId` as `/etc/machine-id`, which **Windows and macOS do not have**. Everything else
genuinely was neutral; v2 closes those three and the contract survives Windows, macOS and BSD without
another migration. This lands **once, before any new collector is written** — the identity choices here
are effectively permanent, because §3 promises *one host = one node, forever*.

Added, all **additive and optional** except `os.family`:

| Field | What it answers |
| --- | --- |
| `os.family` (`linux`\|`windows`\|`darwin`\|`bsd`\|`other`) + `os.build` | the discriminator every consumer branches on; `build` is the identifier Windows/macOS keep distinct from `version`. |
| `host.chassis` (`server`\|`desktop`\|`laptop`\|`vm`\|`container`\|`unknown`) | what the host *is* — the hint #1139's `kind` inference **will** read instead of landing every host as `PHYSICAL_HOST`. Stored on the node's blob today; nothing reads or displays it yet. |
| `host.virtualization` (`{ type, host? }`) | what it runs *under*. `{ type: 'none' }` is a **positive** bare-metal finding, not "unknown". |
| `host.fqdn`, `host.domain` (`{ name?, joined? }`) | the Windows/macOS facts `host` had nowhere to put. `hostname` stays the SHORT name; without these a Windows collector would have to overload it or wait for a v3, and §3 says there is no v3 identity migration. Unpopulated on Linux today, which costs nothing. |
| `host.identifiers[]` (`{ kind, namespace?, value }`) | the **corroborating** identity set #1141 will consume. `externalId` stays the primary dedup key; these are evidence beside it, never a second key. `value` is **canonicalised and sanitized per kind** (below); `namespace` labels an identifier whose `kind` this build does not recognise. Stored on the node's blob; nothing compares or displays it yet. |
| `nics[].ipv6[]` (`{ address, prefixLength?, scope?, temporary?, deprecated? }`), `nics[].isVirtual` | the v6-only host — with enough context to pick a **stable** address (below); and a way to ignore the container plumbing (`docker0`, `veth*`) that dominates a NIC list. |
| `host.bootedAt` | *"did this box reboot after the patch window?"* — an **inventory** question. **ONE scalar**, overwritten each report. It is **not** a metric and must not become one: §1's line stays where it is. Stored on the node's blob; no surface displays it yet. |
| `software[].source` (`dpkg`\|`rpm`\|`apk`\|`registry`\|`msi`\|`appx`\|`winget`\|`brew`\|`app-bundle`\|`pkg`) | provenance, which is what makes a cross-OS software list comparable rather than a bag of strings. Stored per package; the software panel still renders only name + version. |
| `diagnostics?` (`{ warnings, privileged, durationMs }`) | what the collector **could not do**. An empty serial column looks identical whether the host lacks `dmidecode`, the agent lacks root, or a collector timed out (§7's #1133 path). **Stored** on the node's `specs` blob beside the host facts, so a fleet view can one day say *"web-03: reporting unprivileged, no serial/model"* — no UI reads it yet; the agent also echoes the same notes on stdout when run by hand. Emitted on **every** report, not only unhappy ones. |
| `policyRevision?` | ~~**reserved** for the policy channel; the server parses it and discards it~~ — **the policy channel made it real; corrected 2026-08-01, #1140.** The server now persists the echo on the node (`policyRevision`, plus `policyAppliedAt` when it *changes*) and the drill-in compares it to the instance revision to say *applied* vs *pending*. Absent from any pre-#1140 agent, so an absent echo writes nothing rather than clearing a good value. See the §7 Amendment. |
| `softwareState?` (`reported`\|`unchanged`\|`unavailable`\|`disabled`), `softwareHash?` | what the **absence** of `software` means, and which list the agent is claiming. Added by the §2/§3 Amendment (2026-08-01, #1142) below — the reason an omitted package list can mean *keep* without meaning *clear*. |

**`os.family` is required on the wire and defaulted server-side to `linux`.** A discriminator that is
optional is a discriminator every consumer has to re-derive, so it is required — and every agent that
predates v2 is a Linux-only collector, so reading an old report as Linux is *honest*, not a fallback.
The shared `osFamily(host)` mapper is the one place that default lives, since a partial report may omit
the `os` block entirely.

**Degrade, never reject — the same rule one level down.** An unknown enum *value* is not a 400 either:
an enum is a guess about a world (chassis types, hypervisors, package managers) that keeps producing
values we did not enumerate — `systemd-detect-virt` alone emits ~30 — and rejecting one costs the
operator a whole **host**. Vocabularies with a natural unknown member fall back to it (`other` /
`unknown`); `software[].source`, which has none, degrades to absent. The **bounded** fields follow the
same rule by TRUNCATING rather than rejecting: `host.identifiers` past 16 and `diagnostics.warnings`
past 50 (or 300 chars) are trimmed, because those two fields exist precisely to serve agents that are
*not* version-locked to the instance, and making them the contract's only hard 400s would defeat the
amendment they belong to. The fact is lost; the host is not.

**`software[].source` degrades to ABSENT while `identifiers[].kind` degrades to `other` — on purpose.**
A package's `source` is *decoration* on a fact that stands alone: `{ name: "nginx" }` is still fully
usable. An identifier's `kind` is *constitutive*: a value with no kind cannot be compared to anything,
so "degrade to absent" is not available — the only choices are to drop the evidence or keep it under a
catch-all. We keep it, and the catch-all carries its label: an unrecognised `kind` becomes
`{ kind: 'other', namespace: '<the wire label>' }`. Without that, `.catch("other")` silently relabelled
and two different unknown kinds collapsed into one indistinguishable bucket.

**`identifiers[].value` has a canonical form per `kind`, enforced at parse time.** #1141 reconciles this
evidence across operating systems, and the same physical host otherwise produces non-equal strings
depending on who read it — Windows prints a MAC as `AA-BB-CC-DD-EE-FF`, Linux as `aa:bb:cc:dd:ee:ff`,
some switch agents as `aabb.ccdd.eeff`; a `product_uuid` comes back braced and upper-cased on Windows
and bare lower-case on Linux. Three spellings of one fact are three hosts to anything that compares
strings, so the **contract** decides the spelling, not each consumer, and it decides it before the value
is ever stored. MACs → lower-case colon-grouped; the three UUID kinds → bare lower-case dashed
8-4-4-4-12; `machine-id` → lower-case; `serial` → trimmed with internal whitespace collapsed and **case
preserved** (vendors ship case-significant serials, and upper-casing would manufacture collisions on the
unique `Asset.serial`). A value whose shape the rule does not recognise — an odd-length "MAC", a UUID
that is not 32 hex digits — is never re-grouped or padded into one: conservative beats mangled.

**Junk is never corroborating evidence: `identifiers[].value` is SANITIZED, not merely normalised.**
Normalisation on its own made the OEM placeholders *consistently spelled*, which is exactly the wrong
outcome for evidence #1141 compares. `To be filled by O.E.M.`, `Default string`, `System Product Name`
and the notorious placeholder SMBIOS UUIDs (`03000200-0400-0500-0006-000700080009`, all-zero, all-F)
are shipped verbatim on whole production runs, so two *unrelated* boards both reporting one would
corroborate into a single physical host — the silent CMDB-corruption failure class this contract exists
to prevent, and a confidently wrong inventory is worse than an empty one. The rule is the **same list**
`sanitizeSerial` has used on `Asset.serial` since #1081 (`isJunkIdentityValue`), extended with the
placeholder UUIDs and with a separator-stripped repetition check for the hex kinds — the separators in
`00:00:00:00:00:00` and `00000000-0000-0000-0000-000000000000` would otherwise hide the repetition.
Reusing that list rather than writing a second one is the point: identity evidence and `Asset.serial`
can never disagree about what counts as junk. An identifier that sanitizes to nothing is **omitted**,
never emitted with an empty value.

**A malformed `identifiers[]` element degrades the element, not the host.** A non-object entry (a bare
MAC string, a number, `null`) collapses to a dropped element and is recorded in `agentSkew`, matching
the posture `nics[].ipv6` already takes on the identical reasoning — a third-party or older collector
sending the simpler shape must not make the whole host vanish from the inventory with a 400. It stays
consistent with the `kind`-is-constitutive rule above: an element with no kind cannot be compared to
anything, so it is dropped rather than kept under a catch-all.

**Which MAC becomes the `mac` identifier is specified, not incidental.** The rule is a property of the
NIC *set*: canonicalise every candidate, discard loopback and all-zero addresses, rank by how likely the
address is to be burned in (physical beats unknown beats virtual; universally-administered beats
locally-administered), and break ties lexicographically. "Whichever physical NIC the collector listed
first" was kernel ifindex order, which changes on a driver load-order change, a udev rename or an added
NIC — and #1141 compares this value *across reports*, so an order-dependent rule would manufacture
identity churn on hosts whose hardware never changed. Locally-administered MACs are ranked down but
never excluded: EC2 hands out `02:…` addresses on real ENIs.

**`nics[].ipv6` carries scope and the RFC 4941 flags, and only a stable routable address is promoted.**
A bare `string[]` was not enough to choose the node's displayed `ipAddress`: "the first non-`fe80:`
entry" is, on any modern distro with privacy extensions, a **temporary** address that is regenerated on
a timer — so the map entry would stop resolving to the host within hours. `primaryIpv6` therefore skips
any address flagged temporary or deprecated, and any whose *reported* scope is not `global`; it also
rejects `fe80::/10`, `::1` and `::` by prefix regardless, so a collector that could not report a scope
still cannot slip one through. Among what survives it prefers global unicast to a ULA, but takes the
ULA rather than showing nothing. IPv4 still wins wherever the host has one, so this can only ever fill a
field that was previously blank.

**`chassis` distinguishes "the probe did not run" from "bare metal".** `{ type: 'none' }` is a positive
finding and stays one; an ABSENT `virtualization` block is not. The Linux collector reads its SMBIOS
chassis code only once `systemd-detect-virt` has confirmed the host is not a guest, because inside a
container `/sys/class/dmi` exposes the **host's** board — so treating a missing probe as `none` had a
container reporting `chassis: server` with full confidence. The absent probe is reported in
`diagnostics.warnings` rather than guessed around. Since #1139 will infer `kind` from this field, a
wrong classification silently pre-empts the human's call where `unknown` leaves it intact.

**The root is now `z.object`, not `z.strictObject`.** It was strict on the rationale that the agent is
version-locked to the instance it downloaded itself from (§6), so an unknown key could only be a bug.
That rationale holds *today* and **stops holding** the moment an agent ships on its own schedule — a
Windows MSI pushed by GPO/Intune, self-update, or an agent baked into a golden image. Then a **newer
agent against an older server was a hard 400**, which for a CMDB means the host **vanishes from the
inventory**: the same silent-and-misdiagnosed failure shape as #1132, and strictly worse than a host
that is merely stale on fields the server does not understand yet. The decisive detail is that only the
**root** was strict — every nested object in the schema is a plain `z.object`, which strips unknown
keys silently, and essentially every field above lands *inside* one of those. The schema already did
forward-compat everywhere except its outermost layer: the strictness was **inconsistent, not
protective**.

**But the signal is moved, not lost — and it is recorded at every depth, not just the root.** The
handler diffs the **raw body against its own parse** (`agentReportSkewPaths`) and records both
`droppedPaths` (what did not survive parsing) and `coercedPaths` (what the build had to change to
accept) in the node's `specs` blob under `agentSkew`, alongside a server-side warning. Diffing against
the parse rather than against a root key list is the whole point: a key-list diff sees only the root,
while *every* realistic future skew is either a **nested** key — which a plain `z.object` strips
silently, and essentially every field this amendment adds lands inside one — or an unknown **enum
value**, which our own `.catch()` coerces silently. `os.family` is the sharpest case: it is required
precisely so no consumer re-derives the platform, so swallowing a malformed one without a trace would
be self-defeating. Diffing against the parse also means the recorder can never drift from the schema,
because it *is* the schema's output. Bounded on every axis (paths per list, path length, depth, visits,
array indices collapsed to `[]`) — the body is attacker-controlled and the result is persisted.

It rides the **existing** version handshake ([[0083-versioning-and-releases]] Amendment, #907) rather
than inventing a surface: `agentVersion` already travels in every report and already has its own column,
so the server can say the useful thing — *this agent is newer than me* — instead of the generic "I don't
understand these fields". The record **self-heals**: `agentSkew` is part of what the write path
compares, so the first clean check-in differs from what is stored and rewrites the blob without it.
// This originally read *"the blob is rewritten wholesale on every report"* — true until the
~~unconditional rewrite~~ became a **conditional** one; **corrected 2026-08-01, #1153.** The clearing
still happens on the next clean report; it is the *mechanism* that changed, not the outcome. It is
deliberately **not** copied into the linked `Asset.specs`. Nor
is `diagnostics`: both are REPORT diagnostics, not inventory facts, and an Asset's specs are *merged*
rather than rewritten, so anything that reaches them never clears itself. The same strip therefore
applies on both Asset-facing paths — the repeat-report refresh and the review-tray confirm that mints
the Asset.

**Rejected.** *Keeping the root strict* — it buys nothing the nested objects already refuse to enforce,
and pays for it with vanishing hosts. *Loosening without recording* — a typo'd root key would become
silent, which is dangerous next to a future delta protocol where an **absent** `software` key comes to
mean "unchanged". *A `schemaVersion` field with accept-N-1* — it does not solve this case at all: an
older server does not know a newer version exists and rejects it identically, so the whole cost buys a
nicer error message in exchange for maintaining N-1 parse paths forever.

**Upgrade safety.** Nothing here is a migration: no column, no index, no backfill. A pre-v2 agent's
report parses **byte-identical** through an upgraded server except for the documented `os.family`
default (pinned by a test — it is the load-bearing promise of this change), so an operator upgrades the
instance while every agent in the estate keeps running the binary it was installed with, and nothing
re-installs.

**The forward tolerance is NOT retroactive, and must not be described as if it were.** A new server
accepts everything an old agent omits — that direction always worked and still does. The other
direction starts **with this build**: every server released before it has a `strictObject` root and
hard-400s a report carrying a key it does not know, so a v2 agent reporting to a pre-v2 instance is
still refused. The property is real and it is the entire point of the change; it simply only protects
instances from this version forward, which is exactly why the loosening had to land *before* any agent
ships on its own schedule rather than alongside the first one that does.

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
  `serial`/`name`/`modelId`; a soft-deleted asset is skipped. The agent-owned keys
  (`host`/`software`/`reportedAt`) are replaced; every human-added specs key is preserved. **Amended
  2026-08-01 (#1153/#1157):** the sync is still *asked* on every report, but it writes only when the
  merged snapshot differs from what is stored — and a confirmed **CONTAINER child** now gets the same
  sync, which it never had.
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

**Amendment (2026-07-31, #1139) — the agent feeds the topology GRAPH, not an inventory list.** The
product's centrepiece is a graph: `InfraEdge`, `PLAUSIBLE_EDGE_TARGETS`, and the blast-radius
traversal of [[0070-infra-topology-graph]] §7. Through contract v2 the agent produced **not one edge**,
and the upsert above landed **every** host as `PHYSICAL_HOST` — the "`kind` inferred" clause was
aspirational, and the code said so in a `ponytail` note. Concretely: install the agent on a Proxmox
host and its eight guests and lazyit showed nine identical boxes floating on a canvas, and the
operator hand-drew eight `RUNS_ON` edges and hand-re-classified eight nodes *before* the feature that
justified the graph did anything. The agent had automated the boring half.

**Auto-kind, on the CREATE branch only.** `host.virtualization` and `host.chassis` are already on the
wire and already populated by the Linux collector, so the inference is a **mapping, not a heuristic**:
`{ type: 'none' }` → `PHYSICAL_HOST`, any hypervisor (including the `other` catch-all) → `VM`,
`docker`/`lxc`/`wsl` → `CONTAINER`; `chassis` answers only when no `virtualization` block did, which
is the case a future Windows/macOS collector lands in. It lives in `@lazyit/shared` as `inferNodeKind`
beside the other promotion mappers, so the rule has one definition.

**No evidence proposes nothing.** `chassis: 'unknown'` means *the probe did not run* — a different
fact from bare metal, which the contract spells `{ type: 'none' }` — so the mapper returns `undefined`
and the caller keeps the pre-#1139 `PHYSICAL_HOST` default. A pre-v2 agent therefore lands **exactly**
where it always did. That distinction was built for this in the §2 amendment and it is what stops a
guess from silently pre-empting the human's call.

**A node a human confirmed is NEVER re-kinded.** The inference is read on the create branch and
nowhere else; `refreshKnownNode` writes `specs`/`status`/`lastReportedAt`/`agentVersion`/`ipAddress`
and nothing more. The server **proposes**, the human still confirms — and the confirm dialog's `kind`
override, which has existed since §3 with nothing intelligent to prefill, is now the correction path
rather than the data-entry path.

**Containers become child nodes with real edges.** A new **additive, optional** `host.containers[]`
(`{ name, id?, image?, imageDigest?, state?, ports? }`) carries what a readable
`/var/run/docker.sock` lists; the server creates or refreshes a `CONTAINER` node per entry and opens
an active `RUNS_ON` edge to the reporting host. `PLAUSIBLE_EDGE_TARGETS.RUNS_ON` has anticipated
`CONTAINER -> PHYSICAL_HOST` since [[0070-infra-topology-graph]] shipped, so nothing in the
plausibility model changed. This stays inside §1's **self only** scope: it is the local runtime's own
list of what it is executing, read over a local socket — not a network scan. **Running** containers
only; a `RUNS_ON` edge describes what *executes*, and an exited one-shot job from six months ago has
no relationship worth drawing. The collector decides whether to try the socket by **stat**ing it:
`Bun.file(path).exists()` is a regular-file check that answers `false` for a unix socket, and gating
on it made the whole collector unreachable on every host — the container half of this amendment
existed only on paper until that check was corrected. The agent tests stand a real socket up and read
a canned `/containers/json` off it, because a pure-parser suite is exactly what let it ship.

**The child identity key is the container's NAME, scoped to its host** — `<host externalId>/container/<name>`
— reconciled on the **same** `(reportingSource, externalId)` partial unique index the host path uses,
so it needs no column, no index and no migration. This is as permanent as the host key §3 froze, so
both halves are stated rather than left to be re-derived. **Name, not the runtime id:** a container id
is regenerated by every `docker compose up --force-recreate`, every image bump and every rebuild, so
an id-keyed node would mint a fresh PENDING proposal on each deploy and orphan the last one — the
duplicate-node failure the host key was designed to avoid, reproduced one level down. **Scoped to the
host:** container names are unique only within one runtime, so a host-less key would fuse two boxes'
`redis` into one node whose `RUNS_ON` edge flapped between hosts. The separator cannot occur in a host
`externalId` (machine-ids, MachineGUIDs and platform UUIDs are hex and dashes), so a child key can
never collide with a host one. The runtime id still ships, as corroborating evidence, never as a key.

**Absent and empty are different answers, and the server acts on the difference.** An **absent**
`containers` key means the collector never probed — an older agent, a non-Linux collector, an
unreadable socket — so nothing is touched and a host keeps every child it has. `[]` means the probe
**ran and found none**, which retires them. Conflating the two would let an agent downgrade, or one
momentarily unreadable socket, silently wipe a host's whole container topology.

**A vanished container goes OFFLINE; it is never auto-deleted.** Deleting is the human's call (the
existing Discard = soft-delete), and an auto-delete would also *churn*: the dedup index is over LIVE
rows, so a flapping container would accumulate one dead row per flap instead of reviving the one node
the operator curated. Its `lastReportedAt` simply stops advancing, so the §4 staleness sweeper
independently agrees. A container that comes back under the same name refreshes that same node back
to ONLINE — no duplicate, no resurrection ceremony. The `RUNS_ON` edge is **self-healing**: an edge
that is missing is re-opened, and an edge whose target is a **discarded** (soft-deleted) host is
closed and re-opened onto the live one. That second case is not hypothetical — discarding a node
soft-deletes the row and leaves its edges open, and the next report cannot reuse the dead row, so
without it a discarded-then-re-discovered host left its children wired to a node that is off the map,
permanently. An edge to a **live** target is left completely alone, which is what keeps the
one-active-`RUNS_ON`-per-source invariant intact and what keeps a deliberate human re-parent from
being overwritten every fifteen minutes. // A human who *closes* the edge does get it back next
report: "this container executes on this host" is a reported fact, not a layout choice — the same
rule `ipAddress` already follows, minus the `MANUAL` escape hatch, which does not exist here.

**Children land PENDING, like their hosts.** §1 ratified the review tray as the containment for
everything a machine proposes, and a container node is not a lesser proposal — it is a row in the
official inventory the moment it is confirmed, and it can be asset-backed like any other. The
**ergonomics** of forty children arriving as forty individual tray items is a real and separate
problem, and it is a **UI** problem (grouping the tray by reporting host, a confirm-all-children
action); answering it by quietly weakening the gate in the ingestion path would be the wrong place and
the wrong mechanism. Nothing here changes the gate.

**A child row costs the same enrollment slot a host does** (§8's #1134 limiter), because one report
enrolling N+1 rows must be as bounded as one enrolling one. The failure mode differs, and only because
the caller's position differs: a host is enrolled before anything is durable, so refusing it refuses
the report (429, retried); children are reconciled **after** the host row is committed, so the limiter
gains a non-throwing `tryCharge` and a spent budget stops **creating** rows: the host lands, every
container that already has a node is still refreshed, and the ones that do not have a node **yet**
arrive on a later report. Throwing there would turn a partial success into a whole-report failure the
agent reads as "nothing landed" and retries identically forever. For the same reason the **entire**
container reconcile is wrapped: a failure degrades to a stale container topology plus a warning, never
to a host vanishing from the inventory.

**A refused enrolment must never become a retirement.** This budget is per service account and shared
fleet-wide (`install.sh` writes the same operator token on every host), and children spend it too, so
exhausting it mid-list is a **normal rollout event**, not an attack. The retire sweep therefore reads
the set of externalIds computed from the **whole reported list** before anything is written — it
answers "did the agent still list this container?", never "did the server get around to it?" — and
the refusal **skips** the create rather than abandoning the rest of the list, so children after it
keep their `lastReportedAt` advancing. Both halves matter: the first version marked still-running,
already-confirmed children OFFLINE immediately, and stopping the loop would have had §4's staleness
sweeper retire them a few hours later instead. A throttle that invents outages is worse than no
throttle.

**What this does NOT build.** Listening-socket `DEPENDS_ON` hints (`ss -lntp` as *suggested* edges a
human accepts) are deliberately deferred: machine-guessed dependency topology is roughly 60% right,
which is the worst possible number for a graph whose value is that it reflects human intent, and it
belongs behind an opt-in when it lands. Service Mapping stays rejected on §1's terms. Nothing here
approaches monitoring.

**Upgrade safety.** No migration: no column, no index, no backfill — children ride the existing
`(reportingSource, externalId)` partial unique index and the existing `specs` jsonb. Auto-kind touches
only the create branch, so **every node an operator already has keeps its kind**, confirmed or not. A
legacy agent (no `virtualization`, no `chassis`, no `containers`) produces byte-identical behaviour to
before. An upgraded server plus an un-upgraded agent is the ordinary case and is a no-op; an upgraded
agent plus an upgraded server starts proposing kinds for hosts discovered **from then on**, and never
retro-classifies the estate.

**Surfaces, stated honestly.** Container nodes appear **on the diagram** (the canvas reads the node
list unfiltered by `state`, so a PENDING child renders with its edge), **in the Pending review tray**
(which queries `state=PENDING` and applies no kind filter), **in a host's drill-in Children list**
(which renders label + kind + status from the active inverse `RUNS_ON`), and **in the blast radius**
(`GET /infra/nodes/:id/impact` filters on `deletedAt`, not on `state`). Their reported facts render in
a **Container panel** — name, image, image digest, runtime state, container id and the published-ports
table — on the node drill-in's Reported-facts section and, when a child is confirmed with asset
tracking on, on that Asset's detail page.

That panel exists because the alternative was worse, not because containers demanded a surface. The
first cut asserted the facts were "stored and not displayed", reasoning that the host projection keys
off `specs.host.hostname` and a container blob deliberately carries no `host`. It renders nothing on
that route, true — but **both** callers fall back to the raw **Custom fields** grid when the host
projection declines, and that grid renders every `specs` entry through `formatSpecValue`, which
`JSON.stringify`s an object. Confirming a child mints an Asset by default, so the exact design choice
cited as the reason nothing renders was what routed the whole blob into a JSON dump under a heading
that means "a human typed this". A container arm of the projection (`getAgentContainerFacts` +
`AgentContainerPanel`, disjoint from the host arm by construction) is the honest fix; the two arms
share one renderer each, so there is no second layout to keep in step.

One surface needed a fix rather than a disclosure: the **create-agent wizard's** "it checked in" step
matched *the newest agent PENDING node*, and children are enrolled in the same request as their host
while the list is newest-first — so a host running containers would have had the wizard announce
`redis` as the server just installed. It now excludes container children via the key's own exported
rule (`isContainerChildExternalId`), rather than re-deriving the separator at the call site.

**Amendment (2026-07-31, #1141) — the dedup key is machine-id twice, so corroborate it.** §3's
dedup bullets call `(reportingSource, externalId)` a **composite** key. It is not one. `externalId` is
`/etc/machine-id` (`apps/agent/src/collect.ts`) and `reportingSource` is
`agent:${machineId.slice(0, 12)}` (`apps/agent/src/index.ts`) — the same value twice, so the pair has
exactly the uniqueness of its weaker half. And `/etc/machine-id` is not reliably unique: a VM template
or golden image with a **baked** machine-id is the single most common Proxmox/VMware/Packer mistake, it
is the documented reason `systemd-firstboot` exists, and Ubuntu cloud images shipped the footgun for
years. Against a key that is machine-id twice, twelve cloned servers all matched **one node**: the label
kept whoever reported first (correctly — that is human curation), `ipAddress` flip-flopped every
report, and `specs` was whichever host reported last. The CMDB showed 1 server; the estate had 12, with
no warning, no badge and no log line. **A confidently wrong inventory is worse than an empty one**, and
this was the worst failure class in the system — it corrupted the map *silently*, which is the property
that makes it worse than an outage.

The mirror failure is the same root: **re-image**. Reinstall the OS on the same physical box and it
mints a new machine-id, so it arrives as a brand-new PENDING proposal while the node the operator
curated — asset link, owners, position, edges, KB links — drifts OFFLINE forever with nothing
connecting the two. There was **no re-key and no merge path anywhere** in the service.

Three parts, and deliberately **not** an engine:

1. **Corroboration on match.** Matching still starts at `externalId` (unchanged, one indexed lookup).
   On a match, the incoming `host.identifiers[]` are compared against the ones **already stored** in
   that node's `specs` blob — contract v2 (§2 amendment, #1138) stores the whole `host` block on every
   report, so this needs **no schema change and no migration**. If the serial set **and** the MAC set
   both differ, the two reports are two hosts and the merge does not happen.

   **The hostname is deliberately NOT part of the rule.** The issue this amendment implements
   originally specified all three — serial, MAC set *and* hostname — and that was wrong, in the one way
   that mattered: the archetypal golden-image clone has a baked machine-id **and a baked hostname**,
   because that is what "cloned from a template" means. A hostname condition would have excused
   precisely the scenario this whole amendment cites as its motivation, silently collapsing those hosts
   into one node. The hostname survives as **corroborating detail in the notification** — two hosts
   answering to one name is itself the template signature, and saying so is the difference between a
   message that reads as confused and one that reads as evidence — never as a condition.

   **Both, not either.** Serial and MAC are hardware-unique facts: a hypervisor hands every guest its
   own SMBIOS serial and its own MACs, so cloned guests differ on both while sharing machine-id and
   name. Requiring both to differ tolerates exactly one legitimate hardware change on a real box — a
   NIC swap moves the MACs alone, a board swap moves the serial alone. Both moving at once under one
   machine-id is overwhelmingly two machines.

   **The error asymmetry justifies biasing toward detection.** A false positive costs one spurious
   PENDING node and one notification, which a human dismisses and `merge-into` undoes. A false negative
   silently merges two production servers into one inventory row — the worst failure class in this
   product, and the one this amendment exists to end. When the two errors are that unequal, a rule
   should lean toward the recoverable one.
2. **Tell the operator; never block them.** The colliding host lands as its own `state=PENDING`
   proposal and the report is **accepted** — degrade and inform, the same posture as the rest of the
   contract, since a rejected report means the host *vanishes*, which is the failure being fixed, not a
   remedy for it. One broadcast **`infra.identity_conflict`** nudge is emitted
   ([[0056-in-app-notification-bell]]), deduped `infra.identity_conflict:<peerNodeId>:<discriminator>`
   so a clone checking in every 15 minutes nudges **once** — the same one-per-event discipline §4's
   `infra.agent_offline` follows. The summary names the **actual remedy**, because "identity conflict
   detected" would leave the operator exactly as stuck as the silence did — and since #1144 the remedy
   is **chosen from the reporting host's `os.family`**: `systemd-firstboot --setup-machine-id` on the
   clones on Linux, `sysprep /generalize` on Windows (the very property §3's Windows identity section
   cites as the reason `MachineGuid` is a safer key than a baked machine-id). The colliding FACT is
   renamed with it — the title and summary say `machine-id` on Linux and `MachineGuid` on Windows,
   because a Windows operator has no `/etc/machine-id` to go and look at. Families lazyit ships no
   agent for (`darwin`, `bsd`, `other`) get the action with **no command**: naming one for a platform
   this product has never run on is the same defect wearing a different OS. It is **bell-only**:
   adding a type to the email allowlist is a product call
   ([[0079-instance-smtp-outbound-email]] fork #1), not an implementation detail.
3. **Re-key / merge-into as a HUMAN action.** `POST /infra/nodes/:id/merge-into` transplants the
   addressed node's reporting key onto an existing node and soft-deletes the duplicate, in **one
   transaction and in that order** (the partial-unique index covers live rows only, so the source must
   lose the key before the target can take it). **Identity moves; curation does not** — `label`,
   `state`, `kind`, `x`/`y`, `assetId` and the target's edges are never written.

   The archived duplicate's own `reportingSource`/`externalId` are **cleared** as it is archived. They
   have to be: the same pair is being written onto the target, and leaving them on the archived row
   would make restoring it violate the partial-unique index — a soft delete that cannot be undone,
   which [[0006-soft-delete-and-auditing]] does not allow. The values are not lost; they move into the
   `_infraMergedInto` marker, and restoring the row brings back its curation, never the reporting key.

   **A merge can destroy a live reporting key, and says so.** The re-image case always does: the target
   still carries the key it had before the reinstall, a node holds exactly one, and the transplant
   overwrites it. That key is therefore recorded on the archived row (`replacedTargetKey`) and logged,
   and the merge dialog's copy states the consequence — a host still checking in under the replaced key
   matches no live node and returns as a fresh PENDING proposal. Refusing the case instead was
   rejected: it is the *primary* use case, not an edge one. `GET
   /infra/nodes/:id/identity-matches` surfaces the adoption hint above a fresh proposal (*"this looks
   like `srv-app-04` re-imaged"*) from a shared **serial or MAC**; a hostname match is deliberately
   never offered, because recycling a hostname is a naming convention working as intended and a hint
   that is usually wrong teaches the operator to click past the one time it is right.

**A colliding host cannot keep the key it claims, so it gets a derived one.** The partial-unique
`infra_nodes_reporting_source_external_id_key` physically forbids two live rows sharing a key, and the
clone keeps reporting the same baked machine-id forever — so its node is keyed
`<externalId>#<serial-or-MAC>`, which is deterministic (the same clone lands on the same node every
15 minutes) and human-readable rather than hashed (an operator staring at two tray rows can see *why*
they are two). The row also carries `specs.identityConflict` naming the value actually reported and the
peer node it collided with. **This is an identity choice, and it is effectively permanent** — the same
weight as §2's canonicalisation rules — so it is stated here rather than left in code.

**A colliding host's CONTAINERS are not tracked, and that gap is deliberate (#1158, 2026-08-01).** A
container child's key is `<hostExternalId>/container/<name>`, derived from the **reported**
`externalId` — the very value both clones share. The node key is disambiguated; the container key is
not, so two clones compute **identical** container keys. Reconciling containers on this branch would
therefore have each clone's report claim its peer's children, and the retire sweep — which selects
children by the reported key's prefix — would flip the peer's still-running containers to OFFLINE
every cadence tick, in both directions. So the collision branch does **not** reconcile containers at
all. The cost is narrower and it **self-clears**: a colliding host's containers go untracked until its
`/etc/machine-id` is fixed, at which point it takes the ordinary unknown-key path and tracking resumes
by itself. The proper fix — deriving the container key from the **node's** `externalId` — is
**deferred**, because it re-keys every container child that already exists: either a data migration
over the partial unique index or an operator-visible one-time re-enrolment in which confirmed children
retire and return as PENDING. Neither is free, and a collision is an anomaly the product is actively
surfacing for repair rather than a state anyone lives in. **The guarantee that makes the deferral safe
to revisit — a colliding host's report never retires its peer's container children — is asserted by
test** (`infra.service.spec.ts`, `#1158`), not left as a comment. Revisit if
`infra.identity_conflict` turns out to fire often in practice.

**`identityConflict` is re-stamped on every report**, for as long as the collision lasts, keeping the
`detectedAt` of the FIRST detection. A marker written only when the node was created would be gone the
first time anything in the blob moved — leaving the operator holding a notification that points at a
node showing no evidence of why it exists. It still **self-heals**: once the clone is given a real
machine-id it takes the ordinary unknown-key path, nothing re-stamps, and the next blob write drops
the marker. // "the blob is rewritten wholesale on each check-in" was the reason given here; since
#1153 the rewrite is **conditional**, which changes nothing about this marker — it is part of what the
write path compares, so a report that still carries it matches and a report that drops it writes.
**Corrected 2026-08-01, #1153.**

**Nothing is auto-merged and nothing is auto-split.** The only automatic action in the whole change is
a notification; every mutation is a human action. The corroboration check can only ever *withhold* a
merge that would otherwise have happened silently — it never rewrites, re-keys or archives an existing
node. That is asserted by test, not by intention.

**Explicitly rejected: a full identification-rule engine.** Priority tables, configurable identifier
entries, a reconciliation-precedence UI. ServiceNow's IRE needs all of it because fourteen discovery
sources fight over one CI; there is **exactly one source here**. Three hard-coded identifiers plus one
warning covers this estate size completely, and a rule-ordering UI would be a permanent tax on every
later feature. Also rejected: *making `reportingSource` genuinely independent of `externalId`* — it
would need a per-host credential, which is #1146's exchange, and it fixes clones only for hosts
installed *after* it ships. And *refusing the colliding report* — a 400 loses the host, which is
strictly worse than listing it twice.

**Upgrade safety.** No column, no index, no backfill, no migration. Pre-v2 agents send no
`identifiers[]` and every row stored before contract v2 has none, so the check **skips silently** when
either side carries no evidence and the ingest behaves exactly as it did before — the evidence
backfills itself on the first v2 report, and only reports from then on can be corroborated. Warning on
*absence* would have lit up every legacy estate on the day it upgraded; that is why absence is not a
difference. Existing nodes are never touched by the upgrade itself.

---

**Amendment (2026-08-01, #1142/#1153/#1157) — §2 + §3: stop rewriting inventory that did not change,
and name the three things an absent `software` key can mean.**

Every check-in rewrote the whole `specs` blob on the node, and a second time on the linked Asset. On a
real Linux server that blob is ~350 KB, ~90% of it the installed-package list, and the package list
changes when somebody runs `apt upgrade` — perhaps twice a month. At the shipped cadence that is ~96
full rewrites of a multi-hundred-KB TOAST value per host per day, on two tables, for data that did not
change: TOAST churn, autovacuum load and backup growth in exchange for nothing. Against a leaked
`infra:report` token reporting the same `externalId` at the #1134 rate limit it is on the order of
**172,800 rewrites a day** — and #1147 raised the ceiling on how large each one may be from Express's
100 KB default to 8 MB, so the two changes had to be reconciled.

**Two halves, and precisely what each one bounds.** The agent hashes its package list, caches the
fingerprint and omits an unchanged list — which takes that same ~90% off the steady-state report body
and helps the honest majority. The server compares what arrived against what it holds and **skips the
jsonb write when nothing changed**. That second half does not need the client to **cooperate**: the comparison is
made against the server's *own* fingerprint of whatever arrived, so a pre-#1142 agent and an attacker
who sends no fingerprint at all are compared just the same, and a report that repeats what is stored
writes nothing however it was produced. It is **not** a bound on a client that *varies* its report.
Anything the comparison covers, differing by one byte, is a real change and therefore writes — which
is deliberate, because a comparison that ignored a difference would be losing inventory. So a
determined caller can still drive one rewrite per request, and #1142 made that **cheaper** for them,
not dearer: `softwareState: 'unchanged'` plus one varied host fact reaches the same write with a few
KB instead of a few hundred, and on that one branch it also costs a read of the stored list. What
bounds *that* is `InfraReportRateLimitGuard` (#1134) — 120 requests per service account per minute by
default — and ultimately §8's posture that `infra:report` is a low-value credential whose blast radius
is noise rather than damage. What #1153 removes is the ~96 rewrites per host per day a legitimate
estate pays at the default 900-second cadence — the ~172,800 above is the *abuse ceiling*, what the
rate limit alone would still allow, not what an honest fleet drives — and, for a leaked token that
merely replays a report, that ceiling too; it is not a ceiling on a caller who is deliberately
making every request different. The write half of that is not new either — before #1142 the same caller
drove the same rewrite by sending a different package list, at several hundred KB a request.
// the earlier wording here, *"holds regardless of what the client sends"*, promised the stronger bound
and the code never delivered it. **Corrected 2026-08-01, review of #1163.**

They ship together because separately the first one is a landmine.

**The landmine, and the three-state contract that defuses it.** Before this, an absent `software` key
DELETED the stored list, and #1140's `applySoftwarePolicy` depended on it: a policy that turns software
collection off correctly empties a panel nobody is filling any more. Give "absent" the meaning
*unchanged* and that same policy silently **freezes** a stale package list instead — the operator reads
versions from months ago with nothing on screen saying so. So the wire now distinguishes **three**
answers, not two, in an explicit `softwareState`:

| `softwareState` | The agent is saying | The server |
| --- | --- | --- |
| `reported` | the list is in this report | stores it |
| `unchanged` | identical to my last accepted report — `softwareHash` says which list | **keeps** what it holds |
| `unavailable` | I could not enumerate packages (no package manager, a timed-out `dpkg-query`) | **keeps** what it holds |
| `disabled` | policy says do not report software | **clears** the stored list |
| *absent* | a pre-#1142 agent | **clears** — the pre-#1142 reading, unchanged |

An **unrecognised** value degrades to `unavailable`, not to absent. Every other vocabulary in this
contract degrades toward *we know less*; this is the one where "we know less" and "delete the
operator's data" point in different directions, so the safe one is named. The destructive reading is
reachable only from an explicit, recognised instruction, or from an agent that predates the field.

**And the delta is gated on a capability handshake, because the loose root cuts both ways.** §2's
contract root is a `z.object()` rather than a `strictObject` — the #1138 decision that stops a newer
agent from 400-ing itself off the map. Its cost is that an older instance does not *reject* what it
does not know; it silently **strips** it. So a #1142 agent reporting to a post-#1138, pre-#1142 server
has `softwareState` and `softwareHash` removed on the way in, that server sees no `software` key, and
it **clears the stored list** — the pre-#1142 reading, correctly applied to a report that never meant
it. And because the agent believes the list unchanged, it would never send it again: the host's
inventory would be gone permanently, with no error anywhere and the Manual's *"the list on screen is
always the current one"* quietly false. The skew recorder would list `softwareState` in
`droppedPaths`; **recording is not preventing.**

So the ack states the server's capability — **`softwareDelta: true`**, a fact about the *build*, on
every ack, through the channel #1140 already established for `policy`. The agent caches it in
`state.json` beside its fingerprint and may omit a list only on a run that STARTED with that evidence
already on disk; until then it sends everything, which costs exactly what a pre-#1142 agent cost. An
agent that has never recorded the capability — a fresh install, a deleted or corrupt `state.json` —
therefore always sends a full first report, and that single wasted payload is the entire price of the
guarantee. The capability is re-read from every ack rather than latched once, so it
also heals **downwards**: an instance rolled back below #1142 stops advertising it, the agent forgets
it, and the next report carries the full list again — one report's exposure to the old clearing
behaviour, self-repaired, instead of permanent silent loss. **The failure mode is always "sent more
than necessary", never "deleted the operator's inventory."** All three cross-version directions — new
agent → old server, new agent → new server, old agent → new server — are asserted by test.

`unavailable` and `disabled` are deliberately **not** gated, because neither has a list to withhold:
both carry no `software` key with or without the handshake, so gating them would change nothing on the
wire and would only cost the cache. An old server reads both as the pre-#1142 absent key and clears —
exactly right for `disabled`, and for `unavailable` an empty panel until the next successful collection
sends the whole list again, which it does precisely because the agent holds no evidence against that
server. That is **exactly** what a pre-#1142 agent did in the same situation, and the two cases were
never distinguishable: `applySoftwarePolicy` returned `undefined` — never `[]` — both when the
collector enumerated nothing and when policy turned software collection off, and the report was
assembled with `...(software ? { software } : {})`, so both left the `software` key **absent** and both
made the server clear. Neither of these branches is worse than what the estate already runs.
**`unchanged` is the only branch whose omission can cost an inventory permanently, and it is the only
one gated.**

**`softwareHash` is corroboration, never authority.** The wire's fingerprint is read on exactly one
branch — an omitted list, where it is the claim being checked. A list that *arrives* is fingerprinted
by the **server**, with the same shared function the agent uses, so a node's stored fingerprint is
always the server's own reading of what it stored. That is what makes the skip independent of the
client's cooperation rather than something a client opts into: one that sends no fingerprint at all —
every pre-#1142 agent, and an attacker, who has no reason to send one — is compared just the same. (It
is *not* what makes it a bound on a client that varies its report; see "Two halves" above.) A claim it
*cannot* corroborate — the node holds no list, holds one fingerprinted differently, or the
`unchanged` claim arrived carrying **no fingerprint at all** — is never resolved by guessing: the
stored list is kept and the ack carries
**`softwareResend: true`**, which the agent answers by forgetting its cache. That is what makes the
delta self-healing across a node discarded and rediscovered, a restore from backup, and a merge.

**Least evidence means least trust, and it did not at first.** The third case above was added in
review of #1163: every resend site keyed the request on a fingerprint *having arrived*, so a claim the
server *could* check and that failed was answered while one it *cannot* check was believed forever.
The worst case was a create branch — the ordinary one and the clone split-off alike — where a
brand-new node whose first report claimed `unchanged` with no fingerprint was created with no package
list and never asked for one: a permanently empty inventory with nothing on screen saying so, which is
the exact failure the state enum exists to prevent. It is reachable from a hand-rolled client and,
without any adversary, from a future agent whose fingerprint outgrows `AGENT_SOFTWARE_HASH_MAX` — that
cap is a `.catch(undefined)` rather than a rejection, so the agent's own `safeParse` strips the hash
while `softwareState: 'unchanged'` survives. That agent now pays a full list every other report, which
is the failure mode this contract accepts. `unavailable` is *not* asked: it preserves identically but
never claimed to have a list, so asking it would ask a collector that could not enumerate, forever,
for something it does not have.

The fingerprint is a 96-bit non-cryptographic digest of a canonical, order-independent form (package
manager output order is not a fact about the host) carrying a format version, so changing the
canonicalisation costs one resend rather than a wrong answer.

**What the server compares, and what it therefore skips.** Everything in the blob except the two
fields that change on every report while the inventory does not: `reportedAt` and
`diagnostics.durationMs`. A changed warning list, a changed `privileged` flag, a new `agentSkew` record
and the `identityConflict` marker are all real changes and all write. **Skip only on a confident
match** — a wasted write costs I/O, a missed one leaves an operator reading an inventory that has not
been true for weeks. The package list is compared by fingerprint and is deliberately kept out of the
hot path, which reads `specs - 'software'` — a few KB, the same lesson as #1135 one layer down. The one
path that does read the list back is a report that omitted it while its *host facts* changed, because
the blob is written wholesale and writing it without the list would delete it.

That read is allowed to come back empty — the list can vanish between the two reads, to a concurrent
report or a merge — and when it does the node write is skipped rather than performed without the list:
between losing the inventory and being one report late, late wins. **The linked Asset is then held at
the same point**, mirroring what the node still holds rather than what the report brought. Syncing it
from the report would leave the Asset a report ahead of its own node — two surfaces disagreeing about
one host, and the Asset is the one an operator reconciles from. *(Corrected in review of #1163; the
first implementation synced the Asset from the report.)*

**Reading the stored blob back must never fail a check-in.** The projection strips the package list
with `specs - 'software'`, and `jsonb - text` raises `cannot delete from scalar` against a `specs`
somebody hand-edited into a bare string or number. On the *report* path that is not a degradation but
a 500, so one edited row would stop its host checking in at all — against the degrade-never-reject
posture the whole contract is built on. The delete is guarded by `jsonb_typeof`, which sends every
non-object to NULL: the "no evidence" reading both callers already handle. *(Also corrected in review
of #1163.)*

**A consequence stated plainly: `specs.reportedAt` now dates the FACTS, not the check-in.** When the
write is skipped the stored blob keeps the collection time it already had, so on the Asset inventory
panel the label reads **"Collected {date}"** rather than "Reported {date}". *Is this host still
checking in?* is answered by `InfraNode.lastReportedAt` — a scalar column written on every report, the
one the §4 staleness sweeper and the `infra.agent_offline` notification already read — and by the
topology node panel, not by a timestamp inside a blob. Two different questions that happened to share
one answer while the blob was rewritten unconditionally.

**The Asset half, and the container gap it closes (#1157).** Skipping the node's write and then
rewriting the Asset would simply move the amplification one table across, so the linked-Asset sync
decides its own write the same way. It is still *asked* on every report — an Asset linked to a node
whose facts have not moved since would otherwise never receive them — and writes only when the merged
snapshot differs, **judging the package list by the same order-independent fingerprint the node uses**.
Comparing that one key byte-for-byte instead left the node's write skipped while the Asset's fired on
every report from a host whose package manager re-sorted its output, which is this amplification
surviving on the other table. Everything else, the list's contents included, still compares by value.
*(Corrected in review of #1163.)* And `syncAssetSpecs` was called only from the **host** path, so a
container child
confirmed with `trackAsAsset` (which defaults ON) froze its Asset panel at the instant it was
confirmed: image tag, digest, runtime state and published ports drifting silently while the node panel
stayed fresh, with nothing marking it stale. The container path now performs the same sync, under the
same discipline — a direct write (no `SPECS_CHANGED` event per report), human-owned
`serial`/`name`/`modelId` untouched, a soft-deleted asset skipped, only the agent-owned keys replaced,
and nothing resurrected onto a node that was since discarded (the child lookup is soft-delete-scoped,
so a discarded child is simply not in it).

**Explicitly rejected: splitting the package list into its own column.** It would make the node's
remaining blob cheap to rewrite unconditionally and keep `reportedAt` fresh — at the cost of a
migration, a backfill, a read-side recombination, and an `Asset.specs` that still has exactly one
column and therefore still has this problem. Also rejected: *comparing the blob in SQL* (exact, but
untestable in a suite with no database, and the honest comparison still has to exclude the same two
volatile fields), and *trusting `unchanged` without corroboration* (which is how a rediscovered node
ends up with a permanently empty package list). Also rejected: *inferring the server's capability
from a version number* — the agent already knows `serverVersion` from the skew path and could guess.
A guess that is wrong once is wrong for as long as the agent's cache lives, and the failure it would
produce is the silent wipe the handshake exists to prevent; the ack costs one boolean and states the
fact.

**Upgrade safety.** No column, no index, no backfill, no migration. A node stored before this carries
no `softwareHash`, so its first post-upgrade report compares unequal and writes once — the server
stamps its own fingerprint as it writes, and every report after that can be skipped, **including from
an agent that was never upgraded**. A pre-#1142 agent sends neither new field and keeps its exact
pre-#1142 semantics, the #1140 policy clearing included.

The client-side delta, and only that, requires the **new agent binary** — and, by construction, the new
instance as well, since an agent that has not seen `softwareDelta: true` sends its whole list. So both
one-sided upgrades are safe and neither saves anything: upgrade the instance alone and you get the whole
server-side write skip while every agent keeps paying full payload; upgrade the agents alone and they
keep paying it too, until the instance follows. Neither order can lose an inventory, and the ordering
therefore does not need documenting as a procedure — only the fact that the saving appears when both
halves are current.

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

**Amendment (2026-08-01, #1140) — the threshold is per node, not one global env var.**
`INFRA_AGENT_STALE_AFTER_MS` was a single instance-wide cutoff, which made heterogeneous cadences
structurally impossible: the moment the §7 amendment let an operator move a host to a daily report,
that host would sit OFFLINE 23 hours out of 24 and nudge the bell every day. Each node is now judged
against the `staleAfterSeconds` **it was actually served**, denormalized onto
`InfraNode.policyStaleAfterSeconds` on every report **that echoed a `policyRevision`** (and onto each
container child from its host, so a daily host's containers are not swept dark hourly). The echo is
the gate, not merely the resolution succeeding: an agent that predates the policy channel never
receives, caches or applies a threshold, so writing the resolved one on its row would have overridden
a deliberately tuned `INFRA_AGENT_STALE_AFTER_MS` for precisely the hosts the env var is documented to
still cover. The env var remains the fallback for a manual node, an agent that predates the policy
channel, and any report whose policy resolution failed — so an instance that configures nothing
behaves exactly as it did. The sweep filters the per-node comparison
in memory over the candidates already past the shortest possible threshold; that is a deliberate
bound for a few-dozen-host product, not a claim that it scales indefinitely.

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

**Amendment (2026-08-01, #1137) — which artifact, and how you know it is the right one.** Two gaps
in the paragraph above, both silent until a host was already broken.

**The x86-64 artifact was the AVX2 one, and only that one.** `bun-linux-x64` assumes AVX2 (Haswell,
2013). A pre-Haswell host, or a vSphere cluster whose EVC baseline masks the flag, does not report an
error the operator can act on — it takes SIGILL, and the nastiest shape of this is a VM that ran the
agent happily for months until a vMotion put it on older silicon. So the build stage now also emits
`bun-linux-x64-baseline` as `lazyit-agent-x64-baseline`, `GET /agent/download` accepts it as a third
arch, and `install.sh` reads `/proc/cpuinfo` and asks for it when `avx2` is absent (`--baseline`
forces it for a cluster that may migrate later). A baseline download that 404s is a **hard failure**
with its own message, never a silent fall back to the AVX2 build: handing that binary to the one host
that cannot run it would trade a clear install error for a crash weeks later.

**And whether a host can run the binary at all was checked nowhere — but the number everyone
expected turned out to be wrong.** The premise this was raised on was "Bun needs glibc ≥ 2.29, so
CentOS 7 (2.17) cannot run the agent". That is **not true of the artifacts this repo builds**: on Bun
1.3.14 the compiled x64, x64-baseline and arm64 executables link no versioned symbol newer than
`GLIBC_2.17`, which is exactly CentOS/RHEL 7's level. Writing `2.29` into the installer would have
refused hosts that are fine, and it would have gone stale the next time Bun moves its floor — in
either direction.

So the check is **evidence rather than a version number**: after installing the binary and *before*
writing a unit or arming a timer, `install.sh` runs `lazyit-agent --help`, which prints and exits
without touching the network, `/etc` or any state, and fails precisely when the dynamic loader or the
kernel cannot start the executable. A failure removes the binary again and says so, leaving the host
as it was found. That replaces the real failure mode — a host that *looks* installed, has a timer
armed, and silently never reports, with the only clue a `GLIBC_x.y not found` in a journal nobody
reads. What remains genuinely unverified is the **kernel**: Bun states 5.6 recommended and 5.1
minimum with degradation on 3.10 (RHEL 7), and this repo has no RHEL 7 host to settle it on. The run
check answers that question per host, which is the point of asking the host instead of a table.

**Each artifact now ships a `.sha256` beside it**, generated in the same build step that produced the
binary, published by `GET /agent/checksum` (same `infra:report` gate) and compared by `install.sh`
before installing. Before this, the installer's integrity check was TLS plus four bytes of ELF magic
— which answers "did the bytes arrive intact from the origin I dialled" and says nothing about "are
these the bytes the build produced", for a file that becomes **root on every host in the estate**.
Stated honestly, and it is worth stating because the temptation is to oversell it: **this is a
checksum, not a signature.** Anyone who can write both files in the API container defeats it, and it
is not meant to survive that — cosign stays deferred below. What it buys is a corrupted layer, a
half-written volume, a caching proxy serving a stale artifact, and a tamper that changed one file and
not the other, all stopping at the installer instead of nowhere. A build that publishes no digest
(any instance older than this) makes the installer **warn and continue**, because web and API ship
from the same image and failing closed there would brick every install during a rollback;
`--require-checksum` makes it fatal for an operator who wants that.

### §7 — The agent

- **A Bun single-file executable**, not a Go/Rust binary and not a shell script. It imports the
  **same `@lazyit/shared` zod contract** the API validates (zero drift), keeps the repo to one
  language, ships as one static artifact with no runtime deps on the host (no `jq`/`curl`/node
  required), and avoids hand-building JSON in shell (the edge-case trap).
- **A systemd `timer` (oneshot), not a daemon.** It runs, gathers, POSTs, exits. No long-lived
  process, no memory growth, crash-safe — a failed tick is simply retried next interval. Default
  interval: 15 min (configurable). // upgrade to a daemon only if sub-minute reporting is ever needed,
  which inventory never requires.
- **Collection (Linux; Windows added 2026-08-02, #1144 — see the amendment below):**
  `hostname`/`/etc/os-release`/`uname` (identity, OS, kernel),
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

**Amendment (2026-08-01, #1140) — the agent is configured centrally, and the schedule is inverted.**
The `Config` bullet above describes three settings in a per-host file, and one of them —
`LAZYIT_INTERVAL` — was **never read by the binary**: the systemd timer owned cadence. Changing
anything therefore meant SSH-ing to every host. That is a per-host config file behaving as a
distributed spreadsheet, which is the exact artefact the Context section says lazyit exists to
abolish. Four decisions close it, and the first three are effectively permanent.

**1. The ack is the channel — no new endpoint.** `AgentReportAckSchema` gains an optional `policy`,
and the reserved `policyRevision` on the report (§2 amendment) becomes real: the agent echoes the
generation it collected under. This round trip is already authenticated, already per-agent and
already happening every interval, so a `GET /agent/policy` would have bought a second auth surface, a
second throttle and a bootstrap ordering problem in exchange for nothing. // The §2/§3 amendment
(#1142) reuses this channel twice more: `softwareResend` asks for a full package list the server could
not corroborate, and `softwareDelta` states that this build understands `softwareState` at all. Same
shape as `policy` in every respect — optional in both directions, cached by the agent, acted on by the
NEXT run.

**Pickup is deliberately one tick behind.** Run N POSTs its report; the ack carries the policy; the
agent writes it verbatim to `/var/lib/lazyit-agent/policy.json` and exits. Run N+1 loads it at
startup and echoes its revision. No cache — a first run ever, a deleted file, or a server that
predates this — means the built-in defaults, which are byte-for-byte the pre-#1140 behaviour, so
there is no bootstrap and no chicken-and-egg. The delay is a **feature**: a policy is only ever
applied by a run that started cleanly with it already on disk, so a bad policy cannot brick a fleet
mid-collection and a rollback lands one tick after it is saved.

**2. The interval inversion.** Cadence used to mean rewriting a unit file and `daemon-reload` — a root
filesystem mutation driven by an HTTP response, which is an unpleasant capability to grant a fleet
agent and which ports to neither launchd nor Windows Task Scheduler. Instead the timer is installed at
a **fixed 5-minute tick on every platform and never rewritten**, and the agent **no-ops** when
`now - lastSuccessfulReport < policy.intervalSeconds`, tracked in `/var/lib/lazyit-agent/state.json`.
The server then owns cadence from 5 minutes to 24 hours with zero unit-file mutation and identical
semantics on every scheduler. A deterministic per-machine-id offset (FNV-1a over the machine id,
bounded by half the tick, so at most 149 s) is **subtracted** from each host's interval. What that
offset actually buys is narrower than "it spreads the estate", and the narrow version is the true one:
it **absorbs scheduler slack**, so a tick landing a hair short of the interval (systemd's
`AccuracySec`, the previous run's own duration, `OnUnitActiveSec` re-arming from activation rather
than from the report) reports instead of waiting a whole extra tick. It does **not** spread an estate:
the gate is only ever evaluated *on* a tick, so the due instant is quantized to one, and an offset
smaller than a tick moves a host's report by a whole tick or by nothing at all — never by the smooth
few-seconds de-phasing "spreading" implies. At the 900 s default, and at every round value the
minutes-only editor makes natural, the interval is an exact multiple of the tick, so there is no
sub-tick position to be nudged into at all. Hosts that need de-phasing are de-phased by their own
timers, whose phase follows each host's boot instant and run durations. The **reboot** case is
likewise not its doing: that is handled by the state file *surviving* the reboot — a host that
reported four minutes before it went down is still not due when it comes back. On the 900 s default
the offset leaves an effective cadence of at least 751 s (83.4% of what was asked for), and at the
300 s minimum at least 151 s, so no cadence is ever cut to half or below.

**Subtracted, not added,** and the direction is load-bearing. Adding it would push the due instant
*past* a scheduler tick whenever the tick and the interval are close — precisely the host that
upgraded its binary without re-running `install.sh`, still on the old 15-minute `OnUnitActiveSec`
with the 15-minute default interval. That host would miss every other tick and quietly report half as
often as configured. Being due slightly *early* has no such failure mode: the tick catches it.

`install.sh` still accepts `--interval` and **ignores** it; existing installs keep whatever
`OnUnitActiveSec` they were given until the installer is re-run, which means their cadence cannot go
*below* that value in the meantime. Everything else works immediately.

**Re-running the installer keeps this host's own settings.** Re-running is the documented upgrade
path, and it rewrites `/etc/lazyit-agent/config` — which since this amendment is also the *only* store
of the local veto. Truncating it would silently re-enable collection the host's owner had turned off,
on the upgrade path, with nothing on screen to say so; that is the worst possible failure mode for a
security-relevant setting whose owner is frequently not the person running the upgrade. So the
installer now **merges**: every `LAZYIT_*` assignment in the existing file is carried into the new one
except the three keys the installer owns (`LAZYIT_URL`, `LAZYIT_TOKEN` and the ignored
`LAZYIT_INTERVAL`), fenced by a comment marker so it is obvious what was kept. Merging rather than
moving the veto into a second file the installer never touches, because this file is where every
existing host already keeps it — the commented template `install.sh` writes has invited exactly that
since this amendment — and a separate file would orphan those settings on the very upgrade this
protects. Carrying unknown `LAZYIT_*` keys rather than an explicit allowlist means a veto key added by
a later release survives an installer that predates it.

**3. Two hard rules, enforced in code rather than promised in prose.**

- **Local config may VETO, never widen.** `/etc/lazyit-agent/config` gains `LAZYIT_COLLECT_*=false`,
  `LAZYIT_MIN_INTERVAL` (a floor), `LAZYIT_SOFTWARE_MAX` (a ceiling) and `LAZYIT_EXCLUDE_*` globs
  (unioned in). There is no shape in `AgentLocalLimits` that can loosen anything: a local `true` is
  simply not carried, because re-enabling a collector the server turned off would be widening. This is
  the honest posture for a self-hosted product where the host owner and the lazyit admin are often
  different people, and it is documented as a feature. `LAZYIT_INTERVAL` is deliberately **not** read
  as the floor — `install.sh` wrote it on every host that exists, so doing so would have silently
  pinned every upgraded install at 15 minutes. The union of the two exclusion lists is bounded by the
  schema's 32-glob cap, and **the host's entries go in first**: something has to be dropped when both
  sides are full, and what is dropped has to be the server's, or a policy that filled the cap would
  discard the host's own exclusions and thereby *widen* what a root agent reports. That is the one
  place the rule could have broken by construction, so it is pinned by a test rather than by prose.
- **No server-pushed commands, scripts, paths or file reads. Ever.** `AgentPolicySchema` is a
  `z.strictObject` at every depth over booleans, integers and **globs** — the deliberate inverse of
  `AgentReportSchema`, whose root is loose so a newer agent never vanishes from the CMDB. The
  directions are not symmetric: a report is data flowing into a server, a policy is instruction
  flowing into a process running as root. Globs rather than regex because a server-supplied regex is a
  ReDoS primitive against a root process, and the matcher is a two-pointer walk that compiles nothing.
  The exclusion lists are **filters on facts already gathered** — a `mountpoints` entry says *do not
  report this mountpoint*, never *read this path* — so nothing in the schema can widen what the agent
  touches. If a future requirement seems to need an escape hatch here, it needs a new ADR and a very
  good reason: the moment the server can push executable content to a root agent, §8's honest worst
  case ("PENDING spam a human discards") becomes remote code execution as root on every host in the
  estate, and the security argument for the `curl | sh` installer collapses with it.

**4. Three scopes, no group machinery.** Most specific wins: **per-node** (post-confirm) >
**per-service-account** (the natural anchor before a node exists, since the wizard mints one SA per
agent) > **instance default** (a singleton `AgentPolicySettings` row). Deliberately no tags, groups,
behaviours or dynamic membership: at this estate size "instance default plus one override" covers
essentially every case, and when it stops, one `tag: string[]` on the node and one join is the answer,
not a rules engine. Every write at any scope bumps one **instance-wide** revision counter — which
means editing one node's override marks the whole fleet "pending" until each host next checks in. That
is a deliberate trade for a single ordered number an operator can reason about.

Storage is additive and nullable throughout (`InfraNode.agentPolicy` / `policyRevision` /
`policyAppliedAt` / `policyStaleAfterSeconds`, `ServiceAccount.agentPolicy`, plus the singleton), and
reads are **tolerant** while writes are **strict**: a stored layer this build cannot parse resolves as
"no override" and is logged, never an exception, because one bad config row must not 500 the endpoint
that keeps an estate visible.

**Shipped surface, stated plainly.** The UI edits the **instance default** (Settings → Instance →
Reporting agents) and the node drill-in exposes the echoed revision. The per-node and
per-service-account scopes are **API-only in this build** (`PUT /infra/nodes/:id/agent-policy`,
`PUT /infra/agent-policy/service-accounts/:id`) — they work, and they have no editor yet.

**Amendment (2026-08-01, #1137) — operational hardening: the unit, the network, and the two things
an operator could not do.** Everything here is individually small. Collectively it is the difference
between an agent that works on three test VMs and one that survives a real estate — and several of
these are things a prospective operator checks *before* deploying rather than after.

**1. The unit is sandboxed.** It ran as full root — which it needs, because `dmidecode` reads
`/dev/mem` — with none of the free confinement systemd offers, and a unit file is exactly what a
security-conscious buyer opens first. It now carries `NoNewPrivileges`, `ProtectSystem=full`,
`ProtectHome`, `PrivateTmp`, `ProtectKernelTunables` and `ProtectControlGroups`. None of them costs
the agent anything it uses: it reads `/proc`, `/sys`, `/etc` and the package databases, and writes
only `/var/lib/lazyit-agent`. `ProtectSystem=full` leaves `/var` writable while making `/usr`,
`/boot` and `/etc` read-only, so the agent cannot rewrite its own binary or its own config;
**`strict` is deliberately not used**, because it would take the state directory away and break the
interval inversion. **`PrivateDevices=yes` is deliberately absent** and should stay absent: it would
remove `/dev/mem`, and every host would silently lose its serial, manufacturer and model — the facts
the #1141 clone check depends on. That is the exact shape of hardening that reads well in a unit file
and quietly costs an inventory its data.

**2. `Nice=19` and `IOSchedulingClass=idle`.** `rpm -qa` on a 3000-package host is real CPU and real
I/O, and this agent runs on database servers whose job is not being inventoried. Nothing about the
run has a deadline — a one-shot behind a 5-minute tick and a server-set cadence — so yielding to
every other process on the box costs the report nothing anyone can perceive.

**What it does cost, and the ordering that paid for it.** Deprioritising the run makes the package
enumeration more likely to hit the agent's **10 s per-command collect budget**, on exactly the busy
hosts that motivated the directives. Until #1163 that was a **data-loss** cost and not a latency one:
a collect that timed out produced no package list, and under the reading these two lines were
originally written against, an **absent `software` key deleted the stored list** rather than
preserving it. Three individually correct decisions composing into data loss: deprioritise → time
out → omit → wipe.

The fix was never a second timeout mechanism in the unit file, but the wire state that already
existed to say this. **#1142/#1153 (PR #1163) replaced the two-state reading with an explicit
`softwareState`** — the §2/§3 Amendment above — in which a collection that could not enumerate
reports `unavailable` and the server **keeps** what it holds, while only an explicit `disabled`
clears it. That change **landed first**, which is why these two directives are here at all; the chain
now ends at *omit*, and a timed-out enumeration costs a stale **Collected** date rather than an
inventory. What it leaves behind is no longer a merge order but an **invariant**, recorded in the
unit heredoc in `install.sh` as well so whoever reads the unit next finds it: an absent package list
must never again be given the meaning *delete*.

**3. `RandomizedDelaySec` on the timer, which is a different layer from the agent's own jitter, and
the distinction is the whole justification.** The per-machine offset in `agentPolicyDue` absorbs
scheduler slack and, as the #1140 amendment says at length, **cannot spread an estate**: it is only
ever evaluated *on* a tick, so its effect is quantized to one. The ticks themselves are what a
patch-and-reboot window aligns, and this is the layer where the ticks live. Every elapse is delayed
by 0–60 s, so hosts that came back together drift apart instead of POSTing a full inventory in the
same second and running into the per-token report limit (#1134) — at the 120/min default, a
100-server estate sharing one token needs roughly this much spread to fit. The cost is bounded and
small: a report already lands at the first tick at or after its due instant, so it can be up to one
tick late; this adds at most 60 s on top. Against the default staleness cutoff of three reporting
intervals, both are far inside tolerance. Plain `RandomizedDelaySec` rather than
`FixedRandomDelay=yes`, which would give each host a *stable* offset instead of a walk, because that
directive needs systemd 247 and RHEL 8 ships 239 — a per-elapse random walk de-phases just as well
and works everywhere.

**4. Egress proxy and private CA — `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` and `LAZYIT_CA_FILE`.** Both
are the norm in this segment and neither was reachable. A systemd unit starts with an almost-empty
environment, so a host-wide proxy in `/etc/environment` or a shell profile is simply **not there**
when the timer fires: the agent worked by hand and failed on the tick, which is the worst shape a
networking bug can take. And an instance behind a LAN self-signed certificate had exactly one
documented answer — trust that CA **system-wide** — which is a far larger grant than "one inventory
agent talks to one host". Both are now read from `/etc/lazyit-agent/config` (environment still wins,
per key) and applied **explicitly** on every request the agent makes, report and diagnostic alike, so
a `test` that reached the instance cannot have taken a route the report does not. Bun honours the
proxy variables by itself, but only from the process environment — the one place they are not — and a
`NO_PROXY` living in the config file is invisible to it, so resolving both from one source is what
keeps the two halves of the decision together.

**"One source" is a promise, and it needs one more line of code to be true.** Passing an explicit
`proxy` option is only half of taking the decision away from the runtime: Bun consults the ambient
environment whenever the option is *absent*, so a config-file `NO_PROXY` could not stop an inherited
`HTTPS_PROXY` — and, measured on Bun 1.3.14, an ambient `NO_PROXY` overrides even an explicit `proxy`
option, so a host-wide bypass list could defeat the config file's proxy in the other direction. The
agent therefore **blanks the six ambient spellings** once, after resolution and before the first
request (`disableAmbientProxy`). Nothing is lost — the environment has already won, per key — and
after it the agent's own resolution is the whole decision, which is what makes `test`'s "bypassed for
this host (NO_PROXY)" line true rather than hopeful. Blanked rather than deleted, deliberately: on
Bun 1.3.14 `delete process.env.HTTP_PROXY` leaves the proxy in force and assigning `""` does not.

**Which spelling wins, checked against the tools it cites.** When a host sets both `HTTPS_PROXY` and
`https_proxy`, the **lowercase** one wins — measured on curl 8.7.1 and Bun 1.3.14, both of which take
the lowercase value (and curl ignores a bare `HTTP_PROXY` outright). An operator who copies a working
pair off a host must get the same answer from the agent as from the tools they copied it from. The
installer's re-install preservation matches **both cases** for the same reason: the agent reads both,
so a pattern that carried only the UPPERCASE half would silently delete a working proxy on the
upgrade path — the erasure #1160 fixed on the local veto, one key over.

Neither is a policy field and neither ever will be:
both name a local file or a local egress path, which is precisely the class of thing §7's second hard
rule keeps the server from being able to say.

**5. `lazyit-agent show` and `lazyit-agent test`.** The only feedback the agent ever gave was a
one-line summary printed *after* a report the server had already accepted, so every diagnosis was a
blind guess with a round trip attached. `show` runs the whole collector under the real policy —
including this host's veto — and prints the report as JSON on stdout without sending it, so "why is
this host's serial column empty" is answerable on a box with no credentials and no network. `test`
checks config, DNS, TLS, the proxy, the CA and the token, and **writes nothing anywhere**: the probe
is a `HEAD` on `GET /agent/download`, gated on the same `infra:report` permission as the report
endpoint and a pure read, so it proves the exact credential the report uses without creating a
PENDING node, touching a `specs` blob, consuming the per-token report budget or moving
`lastReportedAt`.

**The probe is sent twice, and the pair is what proves anything.** A `404` from that route is a
**pass** — the guard runs before the handler, so it means the token was accepted and only then did
the route say this image bundles no binary for that arch, and reporting that as a failure would send
an operator to re-mint a token that works. But a lone `404` proves nothing: it is byte-for-byte what
an ordinary web server, an S3 bucket or a reverse proxy that does not route `/api` answers, so a
`--url` pointing at the wrong origin entirely produced **PASS** from the one command whose purpose is
catching a wrong URL or token before the operator gives up debugging. So `test` first sends the same
`HEAD` with **no `authorization` header**: a lazyit instance answers `401` there, from the permission
guard, before anything else runs. Only then does the authenticated answer mean something, because
only then did the answer change *because of* the credential. A front door demanding its own basic
auth answers `401` to both and therefore can never produce a pass, which is the property that
matters; it is *not* told apart from a bad token, and the printed diagnosis names the Service Account
in a case where the real cause is a layer in front — distinguishing the two needs something
identifying in the answer, and a `HEAD` gives no body to read it out of. Both requests are reads on
the same route, so the second one writes exactly as much as the first: nothing.

`test` also prints
the effective policy, the last successful report and whether the next tick would report, which is the
other half of "this host is silent and I do not know why".

**6. `install.sh --uninstall`.** There was no removal path: taking the agent off a host meant
hand-deleting four files and two units, and "I will not deploy something I cannot cleanly remove" is
a reasonable position to hold. It disarms the timer *first* (deleting the binary under an armed timer
does not stop it — it turns every tick into a failed unit on a host somebody believes is clean), then
removes both units, the binary and `/var/lib/lazyit-agent`.

**The config file needed a decision, because #1140 made it two things at once.** It holds the SA
token *and* it is the only store of the host's local veto. Uninstall **destroys the token,
unconditionally** — a working credential for your instance must not survive on a host somebody just
decommissioned and will hand on or wipe in six months — and by default removes the file with it.
`--keep-config` is for the operator re-imaging a host that will get the agent back: it keeps the veto
and the proxy settings, which are the host owner's and genuinely painful to lose, while still
stripping `LAZYIT_TOKEN` and `LAZYIT_URL`. There is no flag that keeps the token. (Revoking the
Service Account in lazyit remains the complete answer; this is the half the operator can do from the
host.)

**7. The documented production path keeps the token out of `ps`.** `--token <value>` is visible in
`ps` for every user on the box while the install runs and lands in root's shell history. The window
is short and the token is narrow, but it costs one flag to close, so `install.sh` and the binary both
take `--token-file <path>` (`-` reads stdin) and `install.sh` also reads `LAZYIT_TOKEN` from the
environment. `--token-file -` cannot be combined with `curl … | sh`, because the pipe already **is**
the script's stdin — and that is enforced rather than merely documented: `cat` would read the rest of
the script perfectly happily, so the installer rejects anything containing whitespace as "not a
token" and names the mistake, instead of sending a few kilobytes of shell as a bearer token and
reporting a 401 nobody can explain.

**What reaches an existing host, and when.** Items 1, 2, 3, 6 and the artifact selection live in
`install.sh`, so they land only where it is **re-run** — an installed agent keeps the unit it was
given until its next upgrade, which is the same contract as the `--interval` note above. Items 4, 5
and 7 are in the binary and arrive with it. Nothing here alters the wire contract, the policy schema
or the data model.

**Amendment (2026-08-02, #1144) — a second operating system, and the four things that had to move
before it could exist.** ADR-0074's title says *Linux collector* and §7 said "Collection (Linux)".
That was honest and it was also the product's largest commercial gap: a representative target estate
is ~180 Windows endpoints and ~25 Windows Servers against ~40 Linux boxes, so an agent covering only
Linux leaves the spreadsheet alive, and a surviving spreadsheet makes the Linux agent a demo rather
than a reason to buy. The wire contract has been OS-neutral since #1138; this is the collector
catching up. (This supersedes the agent half of #842. The network-sweep half of that issue is closed
as **wontfix** against §1, which rejected network scanning outright.)

**Identity — `MachineGuid`, and it is permanent.** §3 promises *one host = one node, forever*, so the
Windows key cannot be revised later. `externalId` on Windows is
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`: generated once when the OS is installed,
surviving reboots, renames and hardware changes — the same KIND of fact `/etc/machine-id` is — and,
critically, **regenerated by `sysprep /generalize`**, so a properly prepared image does not collapse
every clone onto one node. That is strictly better than the Linux baked-machine-id trap #1141 exists
to detect. The corroborating set (`host.identifiers[]`) carries `windows-machine-guid`,
`smbios-uuid` (`Win32_ComputerSystemProduct.UUID`), `serial` (`Win32_BIOS.SerialNumber`) and the
primary `mac`, through the SAME `sanitizeIdentifierValue` canonicalisation and junk list the Linux
collector uses — no second implementation, so the two platforms can never disagree about what counts
as evidence. **The asymmetry is the reason the array exists:** MachineGuid survives a motherboard
transplant but not an OS reinstall; the SMBIOS UUID is the reverse. Neither alone is enough.

**Collection — one PowerShell call for the fact sweep, and two absolute prohibitions.** Everything
needing CIM/WMI or the registry rides a single
`powershell -NoProfile -NonInteractive -Command <script>`, emitting one
`ConvertTo-Json -Compress -Depth 4` document; every mapper over it is pure and unit-tested. A ~400 ms
interpreter start once per reporting interval is free, and a single impure boundary is the only shape
this repo can TEST — CI is Linux and the developers are on macOS. **What a tick actually costs, since
"one call per tick" was stated and was not true:** `readMachineGuid` makes a SECOND, much smaller
PowerShell call for the dedup key, and must, because `index.ts` needs that key *before* the cadence
gate — folding it into the sweep would make a tick that reports nothing pay for the full CIM walk.
Both are memoized per process (the agent is a one-shot, so that is once per report), so a reporting
tick is **two** `powershell.exe` starts and a not-due tick is **one**. Sources: `Win32_OperatingSystem`
(name/version/**build** — "version 10" is useless to an operator, and Windows 11 reports major
version 10), `Win32_ComputerSystem` (memory, manufacturer, model, **domain**),
`Win32_Processor`, `Win32_DiskDrive` with `MSFT_PhysicalDisk` as the fallback for hosts where the
first enumerates nothing, `Win32_NetworkAdapter` joined to `Win32_NetworkAdapterConfiguration` on
Index (v4 **and** v6), `Win32_BIOS`, `Win32_ComputerSystemProduct`, and
`Win32_SystemEnclosure.ChassisTypes` → `chassis`.

**A per-fact failure inside that one call is EXPLAINED, not silent.** The script runs under
`$ErrorActionPreference='SilentlyContinue'` — correct, because a class this SKU does not have must
leave its key null rather than abort the document — but that made the single Windows sweep the only
collector in this agent that could degrade with nothing in `diagnostics.warnings`, while every Linux
probe warns. So the script clears `$Error`, and emits it as a bounded `errors[]` (last key in the
hashtable literal, which is evaluated in written order, so it sees what the earlier keys raised);
`buildWindowsHost` files each line as a warning and adds one per fact group the document came back
empty for, naming the class and what it cost. Three rules keep the column readable: no document ⇒
nothing (`collectHost` already files the one note saying the whole sweep failed), a policy-vetoed
group is explained once by the policy's own note, and a healthy host is silent. This is what makes
§2's rule — a degraded probe is reported in `diagnostics.warnings` rather than guessed around
(#1138) — true on Windows as it already is on Linux.

Two things it must NEVER do, and both are enforced by a test over the script text rather than left to
memory. **Never `Win32_Product`:** enumerating that class makes the Windows Installer run a
consistency check that RECONFIGURES every installed MSI package, floods the event log and takes
minutes — the most notorious footgun in Windows inventory. **Never `wmic.exe`:** deprecated, and
REMOVED in Windows 11 24H2 and Server 2025, so an agent built on it would work on an estate's old
machines and silently stop working on its new ones. Software comes from **both** Uninstall hives —
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*` **and** the `WOW6432Node` mirror,
because half a real inventory lives in the 32-bit hive and missing it is the single most common
defect in homegrown inventory scripts — filtered on "has a `DisplayName`" and "not
`SystemComponent=1`", stamped `software[].source: registry`. The filters live in the **mapper**, not
in the PowerShell string: the script selects the three properties and filters nothing, so the rule
sits in the one place this repo can test it.

**Machine-wide only, and the Manual must not overstate it.** Both hives are under `HKLM`, so a
**per-user** install — anything registered under `HKCU`, which is a large share of what a laptop user
installs for themselves — is **not** in the list. Reading it means walking `HKU\<sid>` for every
loaded profile from a SYSTEM context, which is its own piece of work behind its own policy flag and
is deliberately **not** in #1144. The Manual therefore says *machine-wide* rather than claiming parity
with the list Windows shows in *Apps & features*, which is a claim this collector cannot honour.

**`chassis` follows a DIFFERENT rule on Windows, deliberately.** On Linux an absent virtualization
probe forces `chassis: unknown`, because a container reading `/sys/class/dmi` gets the HOST's board
and would confidently report `server`. A Windows agent installed by `install.ps1` runs on the machine
whose enclosure it is reading, so it falls through to the SMBIOS code — which is what keeps
laptop-vs-desktop-vs-server on every physical Windows host, and on an estate of 180 endpoints that is
most of the value #1139 gets from the field. Virtualization itself is inferred from the hypervisor
signature a guest advertises in its synthetic SMBIOS strings, and a non-match reports **nothing**
rather than `none`: `none` is a positive bare-metal finding and there is no `systemd-detect-virt`
here to produce one.

**Containers: the named pipe is NOT dialled, and that is a decision, not an omission.** Docker
Desktop and the Mirantis runtime expose the engine on `\\.\pipe\docker_engine` — a **named pipe**,
not a unix socket. Bun documents `fetch({ unix })` as "the local file path to a unix domain socket"
and says nothing about Windows, and Bun's named-pipe support has a documented history of ENOENT
failures (oven-sh/bun #11820, #13042, #14329, #24682). **This repo cannot reach a Windows host to
settle it empirically, and this campaign has already lost an entire feature to exactly this class of
assumption** — `Bun.file().exists()` answers `false` for a unix socket, nobody checked, and
`collectContainers` was dead on every host on earth. So the Windows collector shells out to
`docker ps --format "{{json .}}"`, which Docker Desktop and Windows Server both put on the SYSTEM
path, and maps it into the same `containers` shape the engine-API path produces. `tcp://localhost:2375`
is **refused outright**, not merely unused: it is off by default and enabling it exposes an
unauthenticated root-equivalent Docker API on the host, and an inventory agent must not leave an
estate less safe than it found it. One fact is genuinely lost — the CLI does not render the image
DIGEST, so `imageDigest` is absent from a Windows-reported container. Revisiting the pipe once a real
Windows host has verified `fetch({ unix })` is a follow-up, not a blocker.

**The Linux "install Docker later" property is preserved, and tested.** The lookup runs on EVERY tick
and caches nothing, and a host with no client returns `undefined` **silently** — exactly as a Linux
host with no socket does, and for the same reason: warning would put a line in the majority of the
estate's reports until operators learned to ignore the field. Everything *after* a successful lookup
warns — a stopped engine, a Desktop nobody is logged in to, a pipe ACL refusing SYSTEM, a timeout —
because that is the "why is this host's container list empty?" question `diagnostics.warnings` exists
to answer, and `run`'s own degradation notes are passed through rather than swallowed.

**The lookup gets the same treatment as the pipe, and did not at first.** Refusing the named pipe as
an unverified Windows boundary and then gating on a bare `Bun.which("docker")` was the same
assumption wearing a different name — and this one's failure mode was **silent by design**: Windows
has no execute bit and no extensionless executables, a bare name on PATH resolves through `PATHEXT`,
whether Bun does that expansion on Windows is undocumented, and a miss meant a host running Docker
Desktop reporting no containers for ever with nothing in `diagnostics.warnings`. The extensions are
now walked explicitly (`PATHEXT`, falling back to `.COM;.EXE;.BAT;.CMD`, bare name last) in a pure
function the tests drive, and the **resolved absolute path** is what gets spawned — which takes
`Bun.spawn`'s own PATH resolution out of it too.

**Scheduling: a Scheduled Task, not a Service.** It preserves the one-shot design of §7 exactly, and
#1140's fixed-tick / server-cadence inversion was designed so the same semantics hold under Task
Scheduler. `Register-ScheduledTask -User "SYSTEM" -RunLevel Highest`, **two triggers**,
`StartWhenAvailable` (the `Persistent=true` analogue), a 60-second random delay on the **time**
trigger (the `RandomizedDelaySec` analogue) and a 5-minute `ExecutionTimeLimit` (the `RuntimeMaxSec`
analogue). It
also runs **on battery**: most of a Windows estate is laptops, and a task that waited for mains power
would leave roaming machines reporting only when docked. A Windows Service would force a daemon
rewrite for zero benefit.

**TWO triggers, and the first attempt at one was a blocker.** The systemd unit has two independent
activations (`OnBootSec=` and `OnUnitActiveSec=`) and the translation had collapsed them into a single
`-AtStartup` trigger carrying the repetition. That does not work, and Microsoft's own documentation
says why: a repetition pattern is "how long the repetition pattern is repeated **after the task is
started**", and Task Scheduler "can run a task any number of times **after a trigger is fired**" — an
`-AtStartup` trigger "starts a task when the system is started" and does not fire for a boot that has
already happened. On a machine that was already running, the install completed, the first manual
report succeeded, and **the agent then never reported again until somebody rebooted the host**.
`StartWhenAvailable` does not rescue it either: it "applies only to time-based tasks", which a boot
trigger is not. So the tick now rides its own `-Once -At (Get-Date)` trigger, which begins repeating
immediately, and the boot trigger (2-minute delay) keeps its own job of re-arming after a power-off;
`Register-ScheduledTask -Trigger` takes an array and Task Scheduler starts the task when **any**
trigger occurs, with `-MultipleInstances IgnoreNew` making an overlap at boot a no-op. Two adjacent
corrections came with it: `-RepetitionDuration` is now **omitted** (the schema: "if no value is
specified for the duration, then the pattern is repeated indefinitely"; the `[TimeSpan]::MaxValue`
idiom is reported to fail XML validation from Windows 10 / Server 2016 on), with a long finite
duration as the fallback — wrapped around **both** calls that can reject a repetition, because the two
documented errors name two different cmdlets: `New-ScheduledTaskTrigger` refuses an interval with no
duration on the older cmdlet ("The RepetitionInterval and RepetitionDuration Job trigger parameters
must be specified together"), while the MaxValue rejection ("(12,42):Duration:P99999999DT23H59M59S")
comes from the cmdlet that WRITES the task, since the XML is validated at registration and not at
construction. Wrapping only construction would have left the registration case aborting the install
after the binary and the token file were on disk, which is exactly what the fallback exists to
prevent; a second failure rethrows rather than retrying an identical registration. And `-RandomDelay`
moved to the **time trigger**, because `New-ScheduledTaskSettingsSet` publishes no such parameter and
passing it there throws under `$ErrorActionPreference='Stop'`, after the token file is already on
disk — and it goes on the time trigger *only*, because `timeTriggerType` extends the trigger base
type with `RandomDelay` while `bootTriggerType` extends it with `Delay`, so a boot trigger has no
schema home for one however willingly the cmdlet accepts the parameter. Nothing is lost: the estate's
real de-phasing is the agent's own machine-id-keyed cadence jitter (#1140). **None of this is verified on a real Windows host** — nothing in this repo can run Task
Scheduler — so it is what the documentation specifies, to be confirmed with
`Get-ScheduledTask lazyit-agent | Select-Object -ExpandProperty Triggers` before any rollout.

**It runs as `NT AUTHORITY\SYSTEM`, never a domain service account.** SYSTEM holds the local WMI/CIM
rights the collector needs with **no credential stored anywhere on the host**; a domain account means
a working password in a file on every machine in the estate and a standing pen-test finding. Without
Administrator the collector **degrades** rather than failing — no serial, exactly as Linux without
root — and `diagnostics.privileged` carries what the collection actually ran under, which is why
`collectHost` now returns the privilege alongside the facts instead of `index.ts` asking
`process.getuid()` (a function that does not exist on Windows and would have reported every SYSTEM
run as unprivileged).

**Distribution: `install.ps1`, and the artifact rename it forced.** The download controller keyed the
filename on **arch alone**, so `lazyit-agent-x64` would have meant two different binaries the moment a
second OS shipped. `GET /agent/download` and `/agent/checksum` now take an `os` parameter and serve
`lazyit-agent-<os>-<arch>[.exe]`. **An omitted `os` still means Linux, and must keep meaning it:**
every `install.sh` already deployed asks for `?arch=x64`, those copies live on the HOSTS rather than
in the image, and upgrading the instance does not upgrade them. The config path is likewise
platform-resolved (`%ProgramData%\lazyit-agent\config`) with a `--config` override, rather than the
hard-coded `/etc/lazyit-agent/config` it was. `install.ps1` mirrors every check `install.sh` makes,
including the ones #1137 added: elevation, arch, bearer-header download, `-MaximumRedirection 0`, **PE
`MZ` magic** as the ELF-magic analogue, published-sha256 verification with `-RequireChecksum`, the
run-once check before any task is registered, `-Uninstall` (which destroys the token unconditionally)
and local-veto preservation across a re-install. The `chmod 600` analogue is an ACL: inheritance
DISABLED — an inherited ACE cannot be removed while inheritance is on, and a fresh `%ProgramData%`
directory grants Users read — rebuilt for SYSTEM + Administrators only. **An MSI is a later phase**
and was not built: it is what GPO/Intune/SCCM push will need, and building it speculatively before
the agent has run on a real estate would be guessing at the properties it should expose.

**The binary is UNSIGNED, on purpose, and that is a GATE.** `bun build --compile
--target=bun-windows-x64` produces a self-extracting-runtime executable that scores badly on AV
heuristics and will be SmartScreen-flagged. It ships unsigned for **internal validation inside the
organisation that builds lazyit** — own domain, own policies, own machines. An **OV/EV code-signing
certificate is an explicit gate before any third party installs it**, not a blocker now and not a
detail to discover later. The code is identical either way; only the signing step differs. This is
stated in the installer's own header and in the Manual (en + es) so it cannot ship externally by
accident.

**The collector was SPLIT before any Windows code was written.** `collect.ts` became
`collect/{shared,linux,windows,index}.ts`: OS-neutral primitives and pure mappers in `shared`, one
file per OS, and a dispatcher that picks by `process.platform`. Growing the existing file with
branches would have put two unrelated failure models in every function. The split is
behaviour-preserving by construction — the pre-existing `collect.test.ts` and `collect-policy.test.ts`
import from `./collect` and pass unchanged.

**What reaches an existing host, and when.** Nothing here alters the wire contract, the policy schema,
the data model or any migration; a Linux estate that upgrades its instance and never re-runs anything
is untouched. `?arch=`-only downloads keep working forever. The renamed artifacts and the `os`
parameter arrive with the API image. Windows support arrives only where `install.ps1` is **run**;
there is no upgrade path that turns an existing Linux host into a Windows one, and none is wanted.


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

**Amendment (2026-08-01, #1145) — saved auto-confirm rules widen this blast radius, and the paragraph
above no longer holds unchanged.** The §1 amendment adds operator-authored rules that confirm a
matching proposal *inside the report request*. On an instance that has saved one, the two sentences
above are no longer both true:

- *"a discovered host lands PENDING and cannot enter the official inventory until a human confirms
  it"* — true only for proposals **no rule matches**. A matched proposal is confirmed by the machine.
- *"the realistic worst case on a leaked token is PENDING spam a human discards"* — the new worst case
  is that a leaked token enrols hosts **shaped to match an existing rule** (a name matching the glob,
  reporting from the right subnet, claiming the facts that make the server propose the right kind) and
  those land **CONFIRMED**, each minting an Asset. Reversing that is a per-node cleanup, not a discard
  of a tray.

What still holds, and is what the risk was accepted on: an instance with **no rules** behaves exactly
as this section described (that is every instance immediately after upgrading); the attacker cannot
author a rule, because rule writes need `infra:manage` + `asset:write` + `HumanOnlyGuard` and the
reporting SA holds `infra:report` and nothing else; a rule cannot be blanket, so the shape a forged
report has to hit is one a human wrote down; the Asset is attributed to the **rule's author**, so
these writes are attributed where an ordinary agent write is not; `matchCount` / `lastMatchedAt` make
a firing rule visible without waiting for someone to notice unfamiliar nodes; and disabling the rule
stops it on the next report. **The operator-facing consequence is the honest one to state: writing an
auto-confirm rule is a decision to widen what a leaked `infra:report` token can do, in exchange for a
gate the operator can actually afford to exercise.** The narrower the rule, the smaller the exchange.

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
- Contract v2 (OS-neutral wire, forward-compatible root, `diagnostics`): §2 Amendment (2026-07-31),
  issue #1138 — the prerequisite for multi-OS collectors, identity/dedup, auto-classification, the
  fleet view and the policy channel.
- Auto-kind on create + containers as child nodes with `RUNS_ON` edges (the agent's first real
  topology): §3 Amendment (2026-07-31), issue #1139 — consumes contract v2's `virtualization`/`chassis`
  and adds `host.containers[]`.
- Identity corroboration (cloned machine-id detection, the `infra.identity_conflict` nudge, node
  re-key/merge-into): §3 Amendment (2026-07-31), issue #1141 — the consumer of contract v2's
  `host.identifiers[]`.
- The review tray at scale (bulk confirm/discard, grouping by reporting host, filter/sort, and
  operator-authored auto-confirm rules): §1 Amendment (2026-08-01), issue #1145 — the ergonomics debt
  the #1139 container amendment named as it created it. It moves *when* the human decides, so it
  carries a paired **§8 Amendment (2026-08-01)** stating the widened `infra:report` blast radius.
  Server-side paging of `GET /infra/nodes` is tracked separately (#1152).
- Server-driven agent policy (the ack as the config channel, the fixed-tick interval inversion, the
  local veto, the three scopes): §7 Amendment (2026-08-01), issue #1140 — the consumer of contract
  v2's reserved `policyRevision`, with a §4 amendment making the staleness threshold per node.
- Software delta + the unchanged-write skip + the container child's Asset sync: §2/§3 Amendment
  (2026-08-01), issues #1142, #1153 and #1157 — one change, because giving an absent `software` key
  the meaning *unchanged* is only safe once the wire can also say *disabled*. It reconciles #1147's
  raised body limit with #1134's bounded-but-nonzero refresh cost, and closes the gap the #1139
  container work left: `syncAssetSpecs` ran on the host path only.
