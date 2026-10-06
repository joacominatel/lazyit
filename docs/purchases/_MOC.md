---
title: "Purchases — Map of Content"
tags: [purchases, moc, index, research]
status: draft
created: 2026-10-01
updated: 2026-10-04
---

# Purchases — Map of Content

> Research and decision vault for lazyit's **Purchases area** (epic #1465): a record of what
> the IT team bought, from which supplier, with which documents, and which assets came out of it — tied
> to the finance PO number. lazyit **records** purchases; it does not run procurement. Always available,
> optional at entry — no instance switch.
> **Accepted and built** (Phases 1, 1b, 2 and 3, 2026-10-02) — see [[#What was built]].
>
> **Start here:** the decision record [[0099-purchases-scope-model-and-optionality|ADR-0099]] (scope,
> model, optionality) and [[0100-money-as-64-bit-minor-units|ADR-0100]] (money as 64-bit integers), then
> [[purchases/decisions|the CEO's inputs and decisions]]. The three research notes below came **before**
> those decisions; each carries a banner listing where the ADRs overrule it.

## Decisions (binding)

- [[0099-purchases-scope-model-and-optionality|ADR-0099]] — hard limits, the entity model, copy on
  confirm, derived status, over-receipt allowed with a warning, the free-text currency label, light
  entry with no uniqueness constraints, no instance switch, `purchaseOrder:*` permissions (provenance
  included), AI extraction as a reviewed draft, phasing, the attachments-backup prerequisite, upgrade
  safety, and the dated decisions taken after acceptance.
- [[0100-money-as-64-bit-minor-units|ADR-0100]] — money columns to `bigint`, the wire kept as a bounded
  JSON number through a shared `money()` primitive, and the upgrade path.
- [[purchases/decisions|CEO inputs and decisions]] — the approved package, the four decisions after
  acceptance (D-A to D-D), the CEO's confirmations of the decisions taken while building (2026-10-02), and
  the CEO's words, verbatim, with where each item is recorded.

## What was built

ADR-0099 records what each build settled, phase by phase; the PRs are into the epic branch
`feat/issue-1465-purchases`.

| Phase | Decisions | PRs |
| --- | --- | --- |
| 0 — Decide and document | [[0099-purchases-scope-model-and-optionality#Decisions after acceptance\|Decisions after acceptance]] (D-A to D-D) | #1468 (#1466) |
| Money as 64-bit minor units | [[0100-money-as-64-bit-minor-units\|ADR-0100]] §3 *As built* and §5 | #1471 (#1469); locale-aware money input and smart entry #1479 (#1470) |
| 1 — core | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1 core, #1472)\|Phase 1 core]] | #1480 (#1472) |
| 1 — screens | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1 web, #1474)\|Phase 1 web]] | #1481 (#1474) |
| 1 — flows | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1 flows, #1473)\|Phase 1 flows]] · [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1 flows web, #1475)\|their screens]] | #1482 (#1473) · #1483 (#1475) |
| 1b — consumable lines, document labels, scanning | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1b consumable lines and document labels, #1476)\|Phase 1b]] · [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 1b web, #1476)\|Phase 1b web]] | #1484 · #1485 (#1476) |
| 2 — extraction, license lines, create from assets | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 2, #1477)\|Phase 2]] · [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 2 web, #1477)\|Phase 2 web]] | #1486 · #1487 (#1477) |
| 3 — AI assistant tools | [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 3, #1478)\|Phase 3]] · [[0099-purchases-scope-model-and-optionality#Decisions while building (Phase 3 web, #1478)\|Phase 3 web]] | #1488 · #1490 · #1492 (#1478) |
| CEO confirmations; stock receipts name the reference | [[0099-purchases-scope-model-and-optionality#CEO confirmations (2026-10-02)\|CEO confirmations (2026-10-02)]] | #1494 |
| Merge duplicate suppliers | [[0099-purchases-scope-model-and-optionality#Merge duplicate suppliers (2026-10-03, #1496)\|Merge duplicate suppliers]] | #1496 |
| Purchases and suppliers in global search | [[0035-search-architecture#Amendment (2026-10-03) — purchases and suppliers, gated per caller (issue #1499)\|ADR-0035 amendment]] | #1499 |
| Drop a document on *New purchase* or the list to start a purchase | [[purchases/decisions#6. Drop a document to start a purchase (2026-10-03, #1516)\|Decisions §6]] | #1516 |

**Planned in ADR-0099 §13 or the UX proposal §7 but not built** (tracked as #1495, with sub-issues
#1496–#1503; merging suppliers has since shipped, #1496): *Receive delivery* across lines, the dashboard *Pending deliveries* tile, the supplier history with yearly totals per currency label, *Suggest purchases*, mapping a custom
field to suppliers, the warranty replacement action, and the XLSX export. Also not built: the per-asset proposal after a line's
price is edited (§2; the asset panel shows *Differs from purchase* instead), the pending list's *Overdue only*
toggle and the link picker's *created near the order date* chip. **The attachments backup** (§12) has not
shipped either: #1467 is open, deferred by the CEO, and the purchase's documents panel says the files are not
in the backup ([[backups]]).

## Research (pre-decision)

- [[purchases/user-interview|Simulated user interview]] — one IT lead and one finance analyst at a
  150-person company: current workflow, adoption conditions, what to build and what never to build,
  the top fears, and 18 open questions for UX.
- [[purchases/technical-analysis|Technical analysis]] — what exists today (with file and line
  evidence), the ADR and invariant constraints, the reusable building blocks, the upgrade path, data
  model options, phasing and risks.
- [[purchases/ux-proposal|UX proposal]] — information architecture, the key flows (create, extract,
  chat, receive, link, pending, legacy instance, finance reader), smart entry, en/es vocabulary,
  mobile, phasing and the D1–D16 decisions.

## Domain notes

- [[supplier]] · [[purchase-order]] · [[purchase-order-line]] · [[purchase-order-event]] — the entities, as
  built.
- [[asset]] (the line link, the cost currency, copy on confirm) · [[application]] (the "Publisher"
  label) · [[attachment]] (the `PURCHASE_ORDER` parent) · [[authorization]] (the `purchaseOrder`
  domain) · [[ai-settings]] (the *Document extraction* switch) · [[consumable-movement]] (stock received
  from a line).
- Security: [[INVARIANTS]] INV-PO-1 and INV-AI-3/4 · [[ai-assistant/security]] §6.12 ·
  [[content-security-policy]] (the review's PDF tab).
- Vocabulary: [[it-terms#Purchases vocabulary|Purchases vocabulary]].

## Key referenced decisions

- [[0089-bulk-receiving-and-checkout-acknowledgement]] — bulk receive, reused to generate assets from a
  line; its PO non-goal is reversed by ADR-0099.
- [[0034-consumables-design]] · [[0088-application-license-seat-tracking]] — consumable and license
  lines.
- [[0036-int4-bounded-integers]] — the integer bound money leaves.
- [[0082-attachments-storage]] — purchase documents and the backup gap.
- [[0046-roles-permissions-v2]] · [[0048-service-accounts]] — the permission catalog and the actor model.
- [[0097-ai-assistant-mcp-and-headless-api]] — the AI pipeline extraction and chat build on.
