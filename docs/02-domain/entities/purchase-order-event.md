---
title: PurchaseOrderEvent
tags: [domain, entity, purchases, audit]
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# PurchaseOrderEvent

> 🟢 built (#1472; receiving, linking and document events #1473; stock receipts and document labels #1476;
> license applies, extraction runs and creation from assets #1477) · Area: Purchases ·
> [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — model, writer and read (#1472)
> Model `PurchaseOrderEvent` (`purchase_order_events`), written through the one shared writer
> `recordPurchaseOrderEvent` (`purchase-order-events.ts`) in the same transaction as each change, read through `GET /purchase-orders/:id/events` (`Page<T>`, newest first,
> `purchaseOrder:read`). The DB CHECK `purchase_order_events_one_actor` is in the migration.

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
- **`eventType` is `TEXT`, not an enum** (CTO decision under D-D, recorded in
  [[0099-purchases-scope-model-and-optionality]]): the writer only emits the values of the shared
  `PURCHASE_ORDER_EVENT_TYPES`, and the read is a plain string, so a type a newer build appends needs no
  migration and an older reader shows it generically.

### Vocabulary and payloads (as built)

| Event | Written by | Payload |
| --- | --- | --- |
| `CREATED` | create | `{ lineCount }` |
| `STATUS_CHANGED` | header update that changes `status` | `{ from, to }` |
| `UPDATED` | header update of any other field | `{ fields, changes: { field: { from, to } } }` — `notes` is recorded as `{ changed: true }` only |
| `LINE_ADDED` | add a line | `{ lineId, description, quantity, unitPrice }` |
| `LINE_UPDATED` | update a line | `{ lineId, changes: { field: { from, to } } }` — prices and quantities before and after |
| `LINE_REMOVED` | remove a line | `{ lineId, description }` |
| `DELETED` / `RESTORED` | soft delete / restore (restore of a live purchase writes nothing) | — |
| `UNITS_RECEIVED` | a receive against a line (#1473) — ONE row per receive, after the per-unit loop | `{ lineId, quantity, assetIds, failed, overReceived }` |
| `UNITS_CANCELLED` | cancel remaining units | `{ lineId, quantity, cancelledQuantity: { from, to }, reason }` |
| `ASSET_LINKED` | link existing assets — one row per request | `{ lineId, assetIds, applied: { assetId: field[] }, moved: [{ assetId, purchaseOrderId, lineId }], overReceived }` |
| `ASSET_UNLINKED` | unlink; or, on the purchase an asset was **moved** away from | `{ lineId, assetIds }`, plus `{ movedToPurchaseOrderId, movedToLineId }` on a move |
| `DOCUMENT_ADDED` / `DOCUMENT_REMOVED` | upload / delete a purchase document | `{ attachmentId, originalName, label }` — `label` (the document type label, `null` when none) since #1476 |
| `STOCK_RECEIVED` | receive a `CONSUMABLE` line into stock (#1476) — one row per receipt, in the movement's transaction | `{ lineId, consumableId, movementId, quantity, overReceived }` |
| `DOCUMENT_UPDATED` | edit a purchase document's type label (#1476); an unchanged label writes nothing | `{ attachmentId, originalName, label: { from, to } }` |
| `LICENSE_APPLIED` | apply a `LICENSE` line to its application (#1477), in the same transaction as the application write | `{ lineId, applicationId, seatsAdded, seatsPurchased: { from, to } \| null, renewalDate: { from, to } \| null, appliedSeats: { from, to }, overApplied }` |
| `EXTRACTION_RUN` | a document of the purchase was sent to the AI provider to draft it (#1477) — on success and on a failure after the request; not when the call failed before any I/O (the document never left) | `{ extractionId, attachmentId, outcome: SUCCEEDED \| FAILED, errorCode, provider, model, inputTokens, outputTokens, lineCount, warningCount }` — **metadata only**: never a value read from the document |
| `CREATED_FROM_ASSETS` | create a purchase from selected assets (#1477), right after its `CREATED`; each line's links follow as `ASSET_LINKED` | `{ lineCount, linkedAssetIds, failed }` (`failed` is a count) |

Money in a payload is a JSON number of minor units. A receive's units are separate transactions (the
asset-tag counter, [[0089-bulk-receiving-and-checkout-acknowledgement]]), so `UNITS_RECEIVED` is appended
after them rather than with each; every unit's own `CREATED` [[asset-history]] event names the line.

## Conventions

- **ID:** `autoincrement()` — a log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only ([[0006-soft-delete-and-auditing]]).

## Fields (as built)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `autoincrement()`. |
| `purchaseOrderId` | `cuid` | FK → [[purchase-order]], `Restrict`. |
| `eventType` | `text` | see the vocabulary above; validated against the shared list by the writer, read as a plain string. New values are appended and degrade gracefully on an older build. |
| `payload` | `jsonb?` | context: line id, before/after values, quantities, cancel reason, asset ids. |
| `performedById` | `uuid?` | FK → [[user]], `SetNull`. |
| `serviceAccountId` | `cuid?` | FK → [[service-account]], `SetNull`. CHECK: not both set. |
| `aiInvocationId` | `string?` | provenance only. |
| `createdAt` | `datetime` | `@default(now())`. |

Related: [[purchase-order]] · [[purchase-order-line]] · [[asset-history]] · [[service-account]] ·
[[0099-purchases-scope-model-and-optionality]] · [[0006-soft-delete-and-auditing]] · [[INVARIANTS]]
