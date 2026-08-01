---
title: InfraAutoConfirmRule
tags: [domain, entity, infra, topology, agent]
status: accepted
created: 2026-08-01
updated: 2026-08-01
---

# InfraAutoConfirmRule

> 🟢 implemented · Area: Infra topology · Implementation order: after [[infra-node]] (it decides what a
> freshly-proposed node becomes)

## Purpose

An **operator-authored rule** that says, once, what a discovered host should become — *"hosts
reporting from 10.20.0.0/16 named `srv-*` are VMs I want tracked"* — instead of the operator saying it
again for every host that arrives ([[0074-server-reporting-agent]] §1 amendment, #1145).

It exists because of the ergonomics debt the §3 amendment (#1139) created and named in the same
breath: a single Docker host enrols **itself plus one CONTAINER child per running container**, so one
modest host produces dozens of PENDING tray rows, each with its own confirm dialog. The gate was
right; paying it per row was not. A control nobody can afford to use is not containment.

**What it changes, stated first.** A proposal a rule matches is confirmed **by the machine, inside the
report request**, and its Asset is minted then — no human looks at that row. The human decision moves
*earlier* (authoring the rule), it does not disappear. That widens what a leaked `infra:report` token
can do, which [[0074-server-reporting-agent]] §8's 2026-08-01 amendment states rather than hides.

**It does not reopen §1's rejection of *blanket* auto-confirm.** The rule *is* the human decision:

- a rule **must state at least one condition that can rule a proposal OUT** — a hostname glob carrying
  a literal character, a subnet narrower than `/0`, or a reported kind. A glob made only of wildcards
  states nothing usable: most of them (`*`, `**`, `*?*`) match every name there is, and the few that
  do narrow (`?` alone matches only one-character names) are refused with them **conservatively**, so
  the line stays "carries a literal", which an operator can check by looking. One shared predicate,
  `statesAutoConfirmCondition`, is applied by the create contract, by the service on the **merged**
  patch and by the matcher on read, so neither a widened patch, a hand-inserted row nor one left by an
  older build can become a blanket rule;
- a **human authored it** (`createdById`), a service account cannot (`HumanOnlyGuard`), and the Asset
  an auto-confirm mints is created with that operator's principal — so §8's *"that write **is**
  attributed"* stays literally true;
- a **human can revoke it**: disabling stops it matching on the next report, deleting soft-deletes it;
- a **human discard outranks it**: a reporting key someone already discarded is never auto-confirmed on
  a later report, so a discard cannot be undone by a machine repeating itself every fifteen minutes;
- it is **never retroactive** — see below.

## Not retroactive

Rules are consulted on the report **CREATE** branches (`ingestReport`'s unknown-key branch and
`applyContainerTopology`'s new-child branch) and nowhere else. The known-host refresh does not consult
them, so a proposal already sitting in the tray an operator is looking at can never confirm behind
them. This is a property of **where the code calls the matcher**, not of a flag: the rule service
exposes no method that could walk existing nodes, and a test asserts that structurally.

The **cloned-machine-id branch** (§3 / #1141) also never auto-confirms. A clone's proposal exists
precisely to be seen as a second row, and the archetypal clone shares its peer's hostname — a hostname
rule would confirm exactly the duplicate the detection exists to surface.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | [[0005-id-strategy]]. |
| `name` | `String` | What the operator called the decision; shown in the rules list and the log line. |
| `enabled` | `Boolean` | `@default(true)`. The fast revocation — a disabled rule stops matching on the next report. |
| `appliesTo` | `InfraAutoConfirmScope` | `@default(HOST)`. Stated explicitly, never assumed by omission, so a host rule can never silently start confirming a Docker host's thirty children. |
| `hostnamePattern` | `String?` | Glob: `*` any run, `?` exactly one. **Anchored** and case-insensitive; every non-wildcard character is regex-escaped, so `srv.01` does not match `srv-01`. |
| `subnetCidr` | `String?` | IPv4 or IPv6 CIDR, matched against the node's promoted primary IP with the shared `ipInCidr`. A host that reported **no** IP never matches — a stated condition is not a wildcard on missing evidence. |
| `reportedKind` | `InfraNodeKind?` | Matches what the server **proposed** (`inferNodeKind`, #1139), not what the agent claimed. |
| `confirmAsKind` | `InfraNodeKind?` | The kind override applied at confirm — the same field the review dialog offers. Null keeps the proposed kind. |
| `trackAsAsset` | `Boolean` | `@default(true)` in the column; the API defaults any rule that can reach a container child — **CONTAINER or ANY** — to `false` via the shared `defaultTrackAsAsset`. See the note below. |
| `createdById` | `uuid?` | The authoring [[user]], `SetNull`. Null = the author was deleted; the rule keeps running, visibly unattributed. |
| `matchCount` | `Int` | `@default(0)`. Incremented per fire, best-effort. |
| `lastMatchedAt` | `DateTime?` | When it last fired. |
| `createdAt` / `updatedAt` / `deletedAt` | `DateTime` | Mutable domain entity, soft delete ([[0006-soft-delete-and-auditing]]) — a deleted rule stops matching, the record of the decision is kept. |

`InfraAutoConfirmScope` = `HOST` · `CONTAINER` · `ANY`.
Indexes: `@@index([enabled])`, `@@index([createdById])`. Table `infra_auto_confirm_rules`.

**Why `trackAsAsset` inverts for a container.** ADR-0070 §5's default-on asset linkage was designed
for a thing the operator owns, assigns, warranties and depreciates — a server. Its create path already
described `trackAsAsset: false` as *"right for ephemeral containers"*. A container is replaced by the
next `docker compose up --force-recreate`, has no SMBIOS serial for the confirm path's serial
promotion to promote, and one Docker host can add dozens. `defaultTrackAsAsset` is asked *"can this
reach a container child?"*, not *"is this a CONTAINER rule?"*, so an **ANY** rule takes the child
default too — the tray, the bulk dialog and the rule form therefore cannot disagree about a container.
It is a **default, not a rule**: a container that genuinely is a licensed appliance is tracked like
anything else, and the switch is in the form.

## Matching

`firstMatchingAutoConfirmRule` over the enabled rules in `createdAt` **ascending** order — the order
the rules list shows, numbered, so the operator can see which rule answers first. Conditions **AND**;
reading them as OR would auto-confirm every host on a wire because one of them matched a name.

**First match wins, not most specific.** Specificity needs a metric operators must learn and
maintainers must keep stable, and ADR-0074 §3 already rejected a rule-precedence engine for the same
reason (ServiceNow's IRE exists because fourteen discovery sources fight over one CI; there is exactly
one source here).

## Endpoints

- `GET /infra/auto-confirm-rules` — oldest first, **including disabled** rules (a hidden disabled rule
  is a surprise waiting for whoever re-enables it). Each row carries `createdByName` (null when the
  author is gone or soft-deleted), `matchCount` and `lastMatchedAt`. `infra:read`.
- `POST /infra/auto-confirm-rules` — `infra:manage` + `asset:write` + **human-only**. 400 when no
  stated condition can rule a proposal out.
- `PATCH /infra/auto-confirm-rules/:id` — same gate. 400 if the patch would leave the **merged** rule
  with no such condition — nulling the last one, or widening it to a wildcard-only pattern or `/0`.
  Dropping **one** of several conditions is fine: the survivor still excludes proposals. The patch
  alone cannot see the stored row, so the contract refuses only the shape it can settle on its own (a
  patch that restates all three condition fields and narrows with none) and the service checks the
  genuine merge.
- `DELETE /infra/auto-confirm-rules/:id` — `infra:manage` + human-only. Soft delete. Nodes the rule
  already confirmed are **not** reverted: they are confirmed inventory rows a human policy approved,
  and un-confirming them would be as retroactive as applying a rule backwards.

## Failure posture

The whole apply is wrapped. The node row is already durable when a rule is consulted, so a failure
leaves the node **PENDING** — where it was going anyway, and where the operator can act on it — while
throwing would make the host vanish from the inventory, which is the failure class ADR-0074 §2's
amendment exists to prevent. `matchCount` failing to increment likewise never fails a confirm that
already happened.

## Links

- [[0074-server-reporting-agent]] §1 Amendment (2026-08-01, #1145) — the decision and its rejections
- [[infra-node]] — what a rule confirms · [[0070-infra-topology-graph]] §5 — the asset-linkage default
- [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] (the gate) · [[0048-service-accounts]]
