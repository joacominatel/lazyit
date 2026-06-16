---
title: Asset-Centric Design
tags: [domain]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Asset-Centric Design

The central design choice of lazyit: the **Asset** is the first-class citizen of the
system — not the User.

## Rationale

- **Assets persist, users rotate.** In internal IT, hardware and licenses outlive the
  people who hold them. Modeling around the durable thing is more stable than modeling
  around the transient holder.
- **The audit question is about things.** The critical question in an audit is "*what do
  we have and where is it?*" — an asset question, not a user question.
- **Traceability falls out naturally.** Centering the asset gives us, for free: a history
  of owners and state changes over time.

## What "asset-centric" means concretely

- An [[asset]] points to an [[asset-model]] (generic make/model/specs) and lives at a
  [[location]].
- Ownership is **not a column on the asset**. It is the join entity [[asset-assignment]],
  which carries `assignedAt`/`releasedAt` so ownership history is automatic. Ownership is
  many-to-many and **concurrent** — an asset can have several active owners at once.
- Asset-specific attributes that vary by type (a switch vs a laptop vs a server) live in a
  flexible `specs` JSON field — see [[conventions]] and [[0007-flexible-asset-specs-jsonb]].
- State changes are recorded in [[asset-history]] (append-only).

## How other entities relate

- **[[user]]** is central to *access* and peripheral to *assets*: a user is an owner of N
  assets (via [[asset-assignment]]) and holds N [[access-grant]]s.
## Consequence

Designing around the asset means the schema, the UI, and the audit story all orient around
"the things we own and their lifecycle", with people and their access attached to them —
rather than a user inbox with assets bolted on.

Full decision record: [[0004-asset-centric-design]]. Conventions: [[conventions]].
