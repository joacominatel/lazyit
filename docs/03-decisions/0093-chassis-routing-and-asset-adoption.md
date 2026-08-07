---
title: "ADR-0093: Chassis routing — adopt an existing Asset by corroborated serial, and keep endpoints off the topology map"
tags: [adr, infra, topology, agent, inventory, asset, backend, frontend, shared]
status: proposed
created: 2026-08-03
updated: 2026-08-03
deciders: [Joaquín Minatel]
---

# ADR-0093: Chassis routing — adopt an existing Asset by corroborated serial, and keep endpoints off the topology map

## Status

**accepted** — 2026-08-03 (issue #1196, split out of epic #1146 item 7). Design only: no code, no
migration and no Manual page ship with this record. It **extends** [[0074-server-reporting-agent]]
(§1/§3) and [[0070-infra-topology-graph]] (§5, the asset-link contract), and **supersedes one
behaviour** named in the §3 amendment of [[0074-server-reporting-agent]] (#1081): the serial-collision
retry that mints a *second* Asset for a machine already in inventory. Nothing about ingest identity,
the `(reportingSource, externalId)` dedup key or the PENDING gate changes.

> **Scope.** Two mechanisms, from one fact the agent already collects and nothing acts on.
> **(1) Adoption:** at the confirm gate, when the report's serial *corroborates* a live [[asset]],
> the node **links that Asset** instead of minting a duplicate. **(2) Endpoint routing:** a new
> agent-owned `InfraNode.chassis` column lets the topology canvas **hide laptops and desktops by
> default** — a view-level treatment, reversible with one toggle. Plus chassis in the review tray and
> as an [[0074-server-reporting-agent]] §1 auto-confirm rule condition. **Non-goals:** no new
> `InfraNodeState` member, no change to `inferNodeKind`'s precedence, no `AssetModel`/category
> auto-create, no retroactive re-linking of already-confirmed nodes, no automatic merge of the
> duplicates an existing install has already minted, and no relaxation of the #1117 re-point `400`.

## Context

- **A representative estate is ~180 Windows endpoints and ~25 servers against ~40 Linux boxes**
  ([[0074-server-reporting-agent]] §7, #1144). The agent treats all 245 identically: an unknown key
  mints an `InfraNode`, PENDING, in the tray; a confirm with `trackAsAsset` mints a **brand-new**
  Asset. On an estate where those endpoints are *already* curated inventory rows, that is the wrong
  end of the funnel — it duplicates the operator's data and it drowns the map.
- **The duplicate is not hypothetical; it is the current code path.** `confirmNode`
  (`apps/api/src/infra/infra.service.ts:2394-2440`) promotes `sanitizeSerial(host)` onto the minted
  Asset, catches the `assets_serial_active_key` violation, and **retries the create without the
  serial**. The result is two live Assets for one physical machine, one of them serial-less. The
  index was telling the truth — *this machine is already in inventory* — and the catch throws that
  answer away.
- **The `assets_serial_active_key` partial unique index already commits lazyit to serial uniqueness
  among live Assets** ([[0041-soft-delete-reuse-and-restore]]). Adoption does not introduce that
  assumption; it stops fighting it. "No repeated serials in theory" is already the schema's position.
- **The chassis fact is collected on BOTH platforms and read by nothing that matters.** `chassisFor`
  (`apps/agent/src/collect/linux.ts:201-211`) returns the SMBIOS-derived `laptop`/`desktop`/`server`
  on exactly the `virtualization === 'none'` branch, and `windowsChassis`
  (`apps/agent/src/collect/windows.ts:463-478`) does the same from the enclosure code. **A Linux
  laptop already sends `chassis: 'laptop'` today.** What it never reaches is `inferNodeKind`
  (`packages/shared/src/schemas/infra.ts:1651`), which consults `virtualization` first and
  exclusively — so `'none' → PHYSICAL_HOST` short-circuits before chassis is looked at. The field is
  not missing on Linux; it is **unused**.
- **Most of the plumbing exists and must not be rebuilt.** The `InfraNode.assetId` link and its
  attach/detach contract (#1117), serial promotion at confirm (#1081), the change-gated
  `syncAssetSpecs` (#1153/#1157), the `INFRA_AUTO_ASSET_MARKER` that makes a detach safe, the #1141
  identity-evidence helpers (`hostIdentityEvidence`, `sanitizeIdentifierValue`, `isClonedMachineId`),
  the `?kind=` list filter, and the auto-confirm rule engine's AND-ed / first-match-wins contract
  (`packages/shared/src/schemas/infra-review.ts`).

## Considered options

### Option A — a laptop mints no node at all

Route on chassis at ingest: an endpoint is recorded somewhere else (or nowhere) and never becomes an
`InfraNode`. **Rejected.** It breaks the stated invariant *one host = one node, forever*
([[0074-server-reporting-agent]] §3): with no node there is no row to migrate when the same
`(reportingSource, externalId)` later reports as a server — a chassis misread, a board swap, a
docked laptop, a collector upgrade. It also puts a **classification** in front of the **identity**
key, which is the one ordering [[0074-server-reporting-agent]] §2 fixed permanently. And an
endpoint that reports and then vanishes from every surface is worse than one that is merely quiet.

### Option B — every host mints its node; route at the confirm gate and in the view *(chosen)*

Ingest is untouched. Chassis changes **what a confirm does** (adopt vs. mint) and **what the canvas
renders** (endpoint hidden by default). **Chosen** — it takes the whole decision out of the identity
path, keeps every host recoverable, and both effects are reversible by a human without a migration.

### Option C — fix the serial collision only; no routing

Replace the drop-the-serial retry with an adopt-the-existing-Asset link and stop there. **Rejected as
half the problem.** It fixes inventory duplication and leaves the map with 180 endpoint boxes on it,
which is where the operator's actual pain is. It is also strictly contained *inside* Option B, so
shipping C alone buys a second release for no design saving.

### Option D — a new `InfraNodeState` (e.g. `ENDPOINT`) or a new `InfraNodeKind`

Model "endpoint" as lifecycle state or as a ninth kind. **Rejected on both counts.** `InfraNodeState`
is `{ CONFIRMED, PENDING }` — a two-member *trust* axis, not a taxonomy; adding a member would mean
every existing `state` check has a third case to be wrong about. And `InfraNodeKind` answers *what
runs where* (`PHYSICAL_HOST`/`VM`/`CONTAINER`/…) — a laptop **is** a physical host, so `LAPTOP` would
be a second, conflicting answer to a question already answered. Form factor is an orthogonal fact; it
gets its own column.

## Decision (Option B)

### §1 — Two questions, deliberately not merged

`inferNodeKind` answers *"is this virtual or physical, and what runs it?"*. Chassis routing answers
*"is this box an endpoint or a server?"*. They are different questions with different taxonomies, and
the ADR keeps them apart. **`inferNodeKind` is not touched** — its precedence, its create-branch-only
rule and the #1139 reasoning behind them all stand unamended. Routing reads `host.chassis`
**directly**, as an orthogonal signal, through a new pure mapper in `@lazyit/shared`.

The payoff is that the "Linux never reads chassis" problem **dissolves rather than needing a fix**:
Linux already puts `laptop` in `host.chassis`; only `inferNodeKind` declines to look. Reading the
field directly makes Linux laptops work on day one — **no collector change, no wire-contract change,
no re-flashed agents**.

Where the signal is genuinely absent it is absent on purpose, and the default is today's behaviour:

| Report | `host.chassis` | Routing verdict |
| --- | --- | --- |
| Bare-metal Linux or Windows laptop/desktop | `laptop` / `desktop` | **endpoint** — off the canvas by default |
| Bare-metal server | `server` | server — on the canvas |
| Guest / container | `vm` / `container` | not an endpoint — on the canvas |
| Linux without `systemd-detect-virt` | `unknown` (forced — a container reading `/sys/class/dmi` sees the HOST's board) | **no signal** — on the canvas |
| Pre-v2 agent, or a value a future collector invents | absent (`.catch(undefined)`) | **no signal** — on the canvas |

**No signal always means "behave exactly as lazyit does today".** Routing can only ever *remove* noise
that a positive fact identified; it can never hide a host on a guess.

### §2 — `InfraNode.chassis`, an agent-owned column

- **Migration:** one additive, nullable `chassis String?` on `infra_nodes`. No default, no `NOT NULL`,
  no index, **no backfill script**.
- **`String?`, not a Prisma enum**, deliberately. `AgentChassisSchema` is `.catch(undefined)` precisely
  so an unrecognised value degrades instead of failing a report; a DB enum would turn that same value
  into a write error on the hot report path. Validation lives in shared zod on the write boundary,
  the read stays tolerant (`AgentChassisSchema.nullish().catch(null)` on `InfraNodeSchema`), and the
  column is small enough to sit on the **list row** — which `specs` deliberately is not (#1135).
- **Written on every report**, create *and* update branches, from `host.chassis`. Chassis is a *fact*
  (the [[0090-ipam-validated-ip]] / `ipAddress` class), not curation (the `kind` class): a re-image or
  a board swap changes the truth and the column should follow. **There is no `chassisSource` and no
  `MANUAL` counterpart**, because chassis is never on the create/update DTOs — a human cannot edit it,
  so there is no human write to protect. A hand-drawn `source=MANUAL` node has `chassis = null` and is
  always on the canvas.
- **Never written for a CONTAINER child**, whose blob is `{ container, reportedAt }` and carries no
  `host` key at all (#1139). Children are unaffected by this ADR.

### §3 — Adoption at the confirm gate

On the `trackAsAsset && !node.assetId` branch of `confirmNode`, before minting anything:

1. `serial = sanitizeSerial(host)` — as today. `undefined` (absent, or a factory placeholder like
   `To be filled by O.E.M.`) ⇒ **no adoption**, mint as today.
2. **Corroboration gate** (§3a below). Not satisfied ⇒ **no adoption**, mint as today.
3. One indexed probe: the live Asset carrying that `serial` (`assets_serial_active_key`,
   `deletedAt IS NULL`). None ⇒ mint as today, **with** the serial — unchanged.
4. Exactly one ⇒ **adopt**: set `node.assetId` to that Asset. **No Asset is created.** The
   `INFRA_AUTO_ASSET_MARKER` is **NOT** stamped (§4). The node's `label`, `kind` and `state`
   transitions are unchanged.

The superseded behaviour is named plainly:

> ~~*"A unique-serial collision (`assets_serial_active_key`) **retries without the serial** rather
> than failing the confirm."*~~ — [[0074-server-reporting-agent]] §3 amendment, #1081.
> **Superseded by this ADR.** That retry answered "this serial already exists" with "then make a
> second Asset without one", which is the duplicate it was trying to avoid, wearing a different
> shape. Under §3 the collision is unreachable on the mint branch: a serial that would collide is a
> serial that corroborates, and a corroborating serial adopts. A collision that still surfaces (a
> race between two confirms) keeps the existing catch as a **backstop** — retry-without-serial
> remains strictly better than failing an operator's confirm — but it stops being the designed path.

#### §3a — Why corroboration, and what it actually costs

**Why not a bare serial match.** `sanitizeSerial` exists because vendors ship placeholder serials by
the rack, and `isClonedMachineId` exists because burned-in identity **does** collide in the field. A
bare match on a value the codebase already distrusts would silently attach the wrong machine to a
curated inventory row — and the wrong-link failure is far worse than the duplicate it replaces,
because a duplicate is visible and a mis-link is not. Corroboration is what makes "no repeated serials
in theory" safe to act on **in practice**.

Corroboration reuses the #1141 machinery and adds no second notion of "same machine". A report
corroborates its serial when **all** hold:

- `sanitizeSerial(host)` returns a value (placeholders already rejected);
- `hostIdentityEvidence(host)` carries that serial **and at least one MAC** that survives
  `sanitizeIdentifierValue` — i.e. `identityDiscriminator` is derivable. A report whose *only*
  identity fact is a serial is one fact, not corroboration;
- the node is **not** in an identity collision — no `specs.identityConflict` (#1141). A node whose
  machine-id is under active suspicion never adopts. **Fail closed:** it mints, which is recoverable.

**The cost is one indexed lookup, and `findIdentityMatches` is deliberately NOT called.** That helper
(`infra.service.ts:3165`) asks *"which other **nodes** look like this node?"* over an un-indexed jsonb
containment scan — a different question, on the wrong side of the join, whose sequential scan is
accepted only because it is a per-UI-read cost. Adoption asks *"which **Asset** carries this serial?"*,
which `assets_serial_active_key` answers as an index lookup. Everything else in §3a is a pure,
query-free computation over the payload already in memory.

The remaining hot-path exposure is bounded and worth stating: with an auto-confirm rule saved
([[0074-server-reporting-agent]] §1 amendment, #1145), `confirmNode` runs **inside the report
request**. Adoption therefore adds one indexed `findFirst` to that request — **once per node, ever**,
since confirm is a one-way transition.

### §4 — What the agent writes to an adopted Asset, and what the audit trail says

**Adoption changes who the target is, not what the agent writes.** The recurring path stays exactly
`syncAssetSpecs` (`infra.service.ts:2342-2367`): **`specs` only**, written directly rather than
through `AssetsService.update`, change-gated (#1153), agent-owned keys (`host`/`software`/`reportedAt`)
replaced and every human-added key preserved, and **never** `serial`, `name`, `modelId`, `status`,
`location` or any assignment. That list is now a **contract about a human's row**, not an
implementation detail of a row lazyit invented, so this ADR restates it rather than inheriting it.

**The marker is the load-bearing safety rule.** `detachAsset` (`infra.service.ts:2957-2967`)
**soft-deletes** the Asset when `specs._infraAutoCreated === true`. Stamping that marker on an adopted
Asset would mean a later detach silently soft-deletes the operator's curated inventory row. So:
**`INFRA_AUTO_ASSET_MARKER` is written on the mint branch only, never on the adopt branch.** Detaching
an adopted Asset un-links it and leaves it intact — which is precisely what the #1117 error message
already promises ("*a pre-existing one is left intact and merely un-linked*").

**The audit consequence, decided rather than inherited.** No `SPECS_CHANGED` per report stays correct
at a 5-minute cadence — an event per report would flood the asset's history and drown every human
edit in it. What changes is that the flooding would now be on a curated row, so the ADR pins where the
trail lives:

- **Facts** are audited on the **node**, not the Asset: [[infra-node-fact-change]] (#1143) already
  records what moved (packages, OS/kernel/memory/disk/serial, image digests). The trail exists; it is
  one join away, and this ADR makes that an explicit, documented answer instead of a silence.
- **The link itself** gets exactly **one** `AssetHistory` event, emitted at adoption: a new
  `AssetHistoryEventType.AGENT_LINKED` (additive enum member — the `ACKNOWLEDGED` precedent, a
  Postgres `ADD VALUE`, no rewrite), payload `{ nodeId, reportingSource, externalId }`. It answers the
  only question a human reading a curated Asset's history will actually ask: *when did a machine start
  writing to this row, and which one?* One event per link, none thereafter.
- **What an operator will notice**: an adopted Asset's `specs` grows the full inventory blob
  (`host`/`software`/`reportedAt`) on its next report, and the inventory panel starts rendering it.
  That is the feature working, but it is a visible change to a row the operator curated, and the
  Manual must say so when this ships.

### §5 — Endpoints off the canvas: a view-level treatment

The canvas today calls `useInfraNodes({})`
(`apps/web/app/(app)/assets/diagram/_components/infra-canvas.tsx:168`) — every node, every kind, every
state. The decision:

- **The canvas hides `chassis ∈ { laptop, desktop }` by default**, with a URL-backed **"Show
  endpoints"** toggle in its toolbar (the `diagram-view.tsx` param-preservation mold), so the state
  survives a reload and a Map↔Table switch, and a hidden count is shown rather than implied
  (*"142 endpoints hidden"*).
- **Client-side, over the rows the canvas already fetches.** `chassis` is a scalar on the list row, so
  no second request, no second cache entry, and the toggle is instant. The cost is a payload, not a
  canvas: ~200 lean rows is well inside what the Servers table already renders, and the thing that was
  actually unusable — 180 boxes and their edges laid out on a graph — is what goes away.
- **The canvas filters; the graph does not.** Impact / blast-radius traversal, search, the Servers
  table and every API read are **unchanged** — an endpoint is still fully in the CMDB, still
  reachable, still counted. Hiding is a rendering decision about one surface. A hidden node takes its
  edges with it *on that surface only*.
- **No per-node "pin this laptop to the map" override in v1.** The class toggle covers the operator
  need this ADR is built from; a per-node pin is another column, another DTO field and another thing
  to explain. *ponytail:* add it when someone asks twice.
- The same mechanism generalises to the other known canvas-noise class — a Docker host's CONTAINER
  children (#1145) — but that is **not** in this ADR.

### §6 — Chassis in the tray and in auto-confirm rules

- **Visible:** the review tray row and the node drill-in show the chassis, so a human confirming 40
  rows can see which are endpoints without opening each one.
- **Actionable:** `chassis` joins `RULE_CONDITION_KEYS` on `InfraAutoConfirmRule`
  (`infra-review.ts:212`) and `InfraAutoConfirmCandidate` gains the reported value. Purely additive,
  and it fits the existing contract with no new semantics: conditions still **AND**, the first
  matching rule in the given order still wins, and *"a stated condition never matches on missing
  evidence"* is exactly the behaviour wanted here — a report with `chassis: unknown` or no chassis
  **never** matches a rule that states one.
- **It can rule a proposal OUT**, so a rule stating only `chassis` satisfies
  `statesAutoConfirmCondition` (`infra-review.ts:272`) on the same footing as `reportedKind` does
  today. *"Auto-confirm the servers, review the laptops"* is a bounded operator judgement, and it is
  the rule this whole ADR makes writable.
- `trackAsAsset` on the rule is **unchanged** (§7).

### §7 — What this ADR deliberately does NOT change

- **The #1117 re-point `400` stands, unamended.** Adoption happens on the
  `trackAsAsset && !node.assetId` branch — the node carries **no** Asset at that moment, and attaching
  to a node that carries none is already allowed directly. There is no re-point at confirm. Where a
  re-point *does* appear is remediation on an install that already duplicated (§8), and there the
  answer is the existing **two-step**: `assetId: null` (the auto-created Asset is soft-deleted, since
  it carries the marker) then `assetId: <the curated one>`. The UI may sequence those two existing
  calls behind one button; the API keeps its rule and its error message intact.

  **Taken up in #1202 — the UI now sequences it.** The permission the §7 sentence granted was unused
  for as long as the drill-in carried no attach/detach control at all, which is what left the §8.5
  notice pointing at a remediation with no path in the product. The duplicate notice now carries a
  *"Point this node at the record you curated"* button that issues exactly those two PATCHes, and the
  drill-in carries a general **Inventory link** control (attach when the node has none, detach when it
  has one). **No API change of any kind**: no merge endpoint, no amended re-point rule, no new
  permission. Two things the implementation had to add, both display-only:

  - `InfraNodeDetail.assetAutoCreated` — the linked Asset's marker, projected as a `.nullish()`
    boolean off the row `getNodeDetail` already reads for the inventory name. Without it the client
    could not tell the two detach outcomes apart, and *"are you sure?"* over "archives an inventory
    row" and "removes a link" is not a confirmation. Null/absent must render the **destructive** copy:
    an unknown provenance is exactly when a dialog must not promise a survivor.
  - The sequence is **resumable, never restartable.** `resolveDuplicateAssetSuspicion` returns null
    for a node with no `assetId`, so step 1 erases the hint that named the curated Asset — the peer id
    is captured before step 1, and a step-2 failure keeps the dialog open on a resume. Replaying the
    detach after step 2 had landed would archive the curated row the operator was rescuing.
- **`modelId` stays null on the mint branch, and untouched on the adopt branch.** Auto-creating an
  `AssetModel` is a human product call ([[0074-server-reporting-agent]] §3 amendment, #1081) and
  adoption strengthens that: an adopted Asset may already carry a human's `modelId`, and category
  lives on `AssetModel.categoryId`, not on [[asset]] — so the agent has no path to a category either,
  by construction.
- **Adoption never writes `Asset.serial`, including a blank one.** The question dissolves: adoption is
  *keyed on* the serial, so an adopted Asset provably already carries it, and an Asset with **no**
  serial can never corroborate and is therefore never a candidate. Accepted limitation, stated
  honestly: a serial-less inventory row must still be linked by hand through the existing attach
  path. Guessing at one from a hostname is the mis-link failure §3a refuses.
- **`trackAsAsset` stays a boolean, and `ConfirmInfraNodeSchema` stays `strictObject` with three
  fields.** There is no third value and no new field, because the flag never named *which* Asset — it
  asks *"should this node be backed by an Asset?"*. Adoption is **how `true` is satisfied**, chosen by
  the server from evidence, not a third thing the caller asks for. `defaultTrackAsAsset` and the rule
  field are untouched. What the human needs is not a new input but **foresight**: a display-only
  `assetCandidate` (`{ id, name, serial }` or `null`) on the node read — the [[0090-ipam-validated-ip]]
  `ipConflict` mold, `.nullish()` on the wire, computed per read, never a gate — so the tray says
  *"Confirm will link **Dell-XPS-7490** (existing)"* rather than *"will create"*.
- **No opt-out from adoption in v1.** An operator who wants a *second* Asset for a machine already in
  inventory is asking for the state `assets_serial_active_key` forbids. If they want no Asset at all,
  `trackAsAsset: false` already says so. *ponytail if this is ever wrong.*

### §8 — Upgrade path (workflow rule #8)

An operator upgrading into this release sees, in order:

1. **Nothing breaks and nothing moves at the moment of the migration.** One additive nullable column;
   every existing row has `chassis = null`, which is *no signal*, which is today's behaviour. The map
   is identical the second after `prisma migrate deploy` as the second before.
2. **The estate self-heals within one report cadence.** Every agent-reported node re-reports on its
   own timer and writes its `chassis` then — so the column fills without a backfill script, without a
   maintenance window, and without a data migration that could be wrong. This is the same lazy-fill
   posture #1153 used for stored software lists.
3. **Then the map gets smaller, and that is the one genuinely visible change.** Stating it loudly
   rather than burying it: as endpoints acquire a chassis they drop off the canvas. It is reversible
   in one click ("Show endpoints"), the hidden count is on screen, and nothing left the CMDB. The
   Manual page shipped with the implementation must lead with this.
4. **Confirms behave differently from that release forward, and only forward.** Adoption is
   **enforce-only-on-write**: it changes what a *future* confirm does. **Already-confirmed nodes are
   never re-linked retroactively** — silently repointing an operator's confirmed inventory at a
   different Asset is exactly the class of change this repo does not make.
5. **Existing duplicates are surfaced, never auto-merged.** They are cheaply detectable — an
   auto-created Asset (`_infraAutoCreated`) with a **null** `serial` whose node's
   `specs.host.hardware.serial` sanitizes to a value carried by a *different* live Asset is, by
   construction, the collision-retry outcome. That becomes a display-only **duplicate-suspicion**
   signal on the node drill-in ([[0090-ipam-validated-ip]] `ipConflict` mold again: computed per read,
   one indexed lookup, a hint and never a gate), with the §7 two-step as the remediation an operator
   performs deliberately. **No automatic merge.** Machine-merging two inventory rows — assignments,
   history, tags, attachments — is not a thing an upgrade should do while nobody is looking.

## Consequences

- **Positive.** The duplicate-minting path is closed at its root, and closed by *using* the index that
  was already telling the truth. The map becomes usable on a real estate — the headline value — with a
  view-level toggle rather than a new lifecycle state, so nothing about trust or identity is spent on
  a rendering problem. Linux laptops are fixed with **no collector change** because the fact was
  already on the wire. Corroboration reuses #1141 wholesale, so lazyit still has exactly **one** notion
  of "same machine". One additive nullable column is the entire schema cost, and every new read
  (`assetCandidate`, duplicate-suspicion) is a display-only `.nullish()` field on the established
  [[0090-ipam-validated-ip]] pattern.
- **Negative / trade-offs (accepted).**
  - **An agent now writes `specs` on human-curated rows** with no per-report `AssetHistory` event. The
    trail lives on [[infra-node-fact-change]] and the link gets one `AGENT_LINKED` event (§4) — but
    someone reading only the Asset's history sees fewer events than things that happened. Accepted
    deliberately; the alternative floods the trail at a 5-minute cadence and destroys it for everyone.
  - **A corroborated mis-link is possible in principle** — two machines genuinely sharing one
    non-placeholder serial, both with MACs. `assets_serial_active_key` already makes that estate
    unrepresentable in live inventory, so the mis-link would be a symptom of a schema assumption
    already broken elsewhere. Fail-closed on collision-flagged nodes (§3a) is the mitigation.
  - **The canvas still fetches endpoints it will not draw.** A payload cost at ~200 rows, traded for
    one request, one cache entry and an instant toggle. *ponytail:* push the filter server-side (the
    `?kind=` plumbing generalises) if an estate ever makes the payload the slow part.
  - **Adoption is not offered for serial-less Assets**, which is a real estate shape (older rows,
    hand-entered inventory). Those keep the manual attach path.
  - **The map shrinking on upgrade will surprise someone** even documented. It is the intended value
    and it is one click to undo.

## Decisions resolved — 2026-08-03

All five open questions were put to the CEO and **confirmed as drafted**. They are settled, not
defaults awaiting a later objection; a change to any of them supersedes this record rather than
amending it in passing.

1. **The hidden set is `{ laptop, desktop }`.** A workstation is an endpoint, not estate topology.
2. **No per-node "pin to map" override in v1** (§5). The class toggle is enough; a per-node override
   is added only if an operator asks for one.
3. **No opt-out from adoption in v1** (§7) — a corroborating serial always adopts. An escape hatch on
   the confirm DTO was declined deliberately: it would be used before it was understood.
4. **`AssetHistoryEventType.AGENT_LINKED` is approved** (§4) — additive (`ADD VALUE`, no rewrite), and
   it answers the one question a human reading a curated Asset's history will ask.
5. **Endpoint hiding is canvas-only**; the Servers *table* keeps showing everything (§5). The map is
   the surface that drowns at ~200 endpoints; the table is not.

## Links

- Issue: #1196 · epic #1146 (item 7)
- ADRs: [[0074-server-reporting-agent]] (§1 trust/auto-confirm, §3 ingest + fact promotion, §7 estate) ·
  [[0070-infra-topology-graph]] (§5 asset link) · [[0090-ipam-validated-ip]] (the display-only
  read-field mold) · [[0041-soft-delete-reuse-and-restore]] (the live-unique index this ADR finally
  believes) · [[0007-flexible-asset-specs-jsonb]] · [[0006-soft-delete-and-auditing]] ·
  [[0033-asset-history-event-model]] · [[0078-asset-category-specs-dictionary]]
- Entities: [[infra-node]] · [[infra-node-fact-change]] · [[asset]] · [[asset-model]]
- Prior issues: #1117 (attach/detach, the re-point `400`) · #1081 (serial promotion, the superseded
  collision retry) · #1139 (`inferNodeKind`, container children) · #1141 (identity evidence,
  collision) · #1144 (Windows collector, chassis on Windows) · #1145 (auto-confirm rules, bulk tray) ·
  #1153 (change-gated specs sync)
