---
title: "Purchases — Map of Content"
tags: [purchases, moc, index, research]
status: draft
created: 2026-10-01
updated: 2026-10-01
---

# Purchases — Map of Content

> Research and decision vault for lazyit's **optional Purchases area** (epic #1465): a record of what
> the IT team bought, from which supplier, with which documents, and which assets came out of it — tied
> to the finance PO number. lazyit **records** purchases; it does not run procurement. Off by default.
> **Accepted, not built yet.**
>
> **Start here:** the decision record [[0099-purchases-scope-model-and-optionality|ADR-0099]] (scope,
> model, optionality) and [[0100-money-as-64-bit-minor-units|ADR-0100]] (money as 64-bit integers), then
> [[purchases/decisions|the CEO's inputs and decisions]]. The three research notes below came **before**
> those decisions; each carries a banner listing where the ADRs overrule it.

## Decisions (binding)

- [[0099-purchases-scope-model-and-optionality|ADR-0099]] — hard limits, the entity model, copy on
  confirm, derived status, over-receipt under a lock, currency per purchase, the instance switch,
  `purchaseOrder:*` permissions, AI extraction as a reviewed draft, phasing, the attachments-backup
  prerequisite, upgrade safety, and the questions still open before Phase 1.
- [[0100-money-as-64-bit-minor-units|ADR-0100]] — money columns to `bigint`, the wire kept as a bounded
  JSON number through a shared `money()` primitive, and the upgrade path.
- [[purchases/decisions|CEO inputs and decisions]] — the approved package and the CEO's words,
  verbatim, with where each item is recorded.

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

## Domain notes (planned)

- [[supplier]] · [[purchase-order]] · [[purchase-order-line]] · [[purchase-order-event]] — new entities.
- [[asset]] (the line link, the cost currency, copy on confirm) · [[application]] (the "Publisher"
  label) · [[attachment]] (the `PURCHASE_ORDER` parent) · [[authorization]] (the `purchaseOrder`
  domain).
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
