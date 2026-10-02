---
title: PurchaseOrderEvent
tags: [domain, entity, purchases, audit]
status: accepted
created: 2026-10-01
updated: 2026-10-01
---

# PurchaseOrderEvent

> ⚪ planned (Purchases Phase 1) · Area: Purchases · [[0099-purchases-scope-model-and-optionality]]

> [!warning] Not built yet
> This note records the accepted design. No `PurchaseOrderEvent` model exists in the code today; the
> event vocabulary below is indicative and the Phase 1 backend unit settles it.

## Purpose

The **append-only activity log** of a [[purchase-order]]: who created it, who changed a price, who
received or cancelled units, who linked or unlinked an asset, who uploaded a document, who deleted or
restored it. It is the purchase-side counterpart of [[asset-history]] and satisfies auditability by
default ([[0006-soft-delete-and-auditing]]).

## Relationships

- **records** an event on one [[purchase-order]] (`purchaseOrderId`).
- **attributed to** at most one actor: a human [[user]] (`performedById`, `SetNull`) **or** a
  [[service-account]] (`serviceAccountId`, `SetNull`).

## Business rules

- **Append-only and immutable.** Rows are inserted, never updated or deleted. No `updatedAt`, no
  `deletedAt`.
- **Written in the same transaction** as the change it records — the explicit-emission model of
  [[0033-asset-history-event-model]].
- **Honest attribution.** A DB **CHECK** constraint allows *at most one* of (`performedById`,
  `serviceAccountId`) per row, so a service-account action is never attributed to a fake human
  ([[INVARIANTS]] INV-SA-4, [[authorization]] §7). `ActorService.resolveActor(principal)` picks the
  column.
- **AI provenance.** `aiInvocationId` (plain string, no FK) stamps the [[ai-tool-invocation]] that caused
  the event, as on [[asset-history]]; the actor columns still name the real principal.
- **Values are recorded where the trail needs them.** Unlike the asset `UPDATED` event (field names
  only), a price or quantity change records before and after, because "unit price changed from X to Y by
  Nico" is exactly what the research asks the log to answer ([[purchases/user-interview]] §3).
- Linking or unlinking an asset also writes an [[asset-history]] event on the asset side.

## Conventions

- **ID:** `autoincrement()` — a log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only ([[0006-soft-delete-and-auditing]]).

## Fields (planned)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `autoincrement()`. |
| `purchaseOrderId` | `cuid` | FK → [[purchase-order]]. |
| `eventType` | enum / text | indicative: `CREATED`, `UPDATED`, `STATUS_CHANGED`, `LINE_ADDED`, `LINE_UPDATED`, `LINE_REMOVED`, `UNITS_RECEIVED`, `UNITS_CANCELLED`, `ASSET_LINKED`, `ASSET_UNLINKED`, `DOCUMENT_ADDED`, `DOCUMENT_REMOVED`, `DELETED`, `RESTORED`. New values are appended and must degrade gracefully on an older build. |
| `payload` | `jsonb?` | context: line id, before/after values, quantities, cancel reason, asset ids. |
| `performedById` | `uuid?` | FK → [[user]], `SetNull`. |
| `serviceAccountId` | `cuid?` | FK → [[service-account]], `SetNull`. CHECK: not both set. |
| `aiInvocationId` | `string?` | provenance only. |
| `createdAt` | `datetime` | `@default(now())`. |

Related: [[purchase-order]] · [[purchase-order-line]] · [[asset-history]] · [[service-account]] ·
[[0099-purchases-scope-model-and-optionality]] · [[0006-soft-delete-and-auditing]] · [[INVARIANTS]]
