---
title: PurchaseOrderLine
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# PurchaseOrderLine

> 🟢 built — backend (#1472); receiving and linking pending (#1473) · Area: Purchases ·
> [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — API and contract (#1472)
> Model `PurchaseOrderLine` (`purchase_order_lines`). Lines are created inline with a purchase or through
> `POST /purchase-orders/:id/lines`, edited with `PATCH /purchase-orders/:id/lines/:lineId` and removed with
> `DELETE` on the same path — all under `purchaseOrder:write`. Receiving units and linking assets (which is
> what makes `Asset.purchaseOrderLineId` non-null) come in #1473.

## Purpose

One line of a [[purchase-order]]: what was bought, how many, at what unit price — and, for an asset
line, the units that came out of it.

## Relationships

- **belongs to** one [[purchase-order]] (`purchaseOrderId`, `onDelete: Restrict`).
- **maps to** an optional [[asset-model]] (`assetModelId`, `SetNull`). Optional on purpose: a draft line
  does not force anyone to create a model; it is mapped when units are received.
- **produced** N [[asset]]s (`Asset.purchaseOrderLineId`, nullable). At most one line per asset.
- From Phase 1b, a `CONSUMABLE` line maps to a [[consumable]] and is received as `IN`
  [[consumable-movement]]s that reference the line. From Phase 2, a `LICENSE` line links to an
  [[application]].

## Business rules

- **Entry is light** ([[0099-purchases-scope-model-and-optionality]], governing principle, CEO decision
  D-D): a **description is the only field the user must fill**. The quantity **defaults to 1** and the
  unit price is optional.
- **Kinds.** `ASSET` and `OTHER` in Phase 1; `CONSUMABLE` in Phase 1b; `LICENSE` in Phase 2. Stored as
  `TEXT` validated by the shared zod schema on write, not a Prisma enum.
  - `ASSET` — received units become assets.
  - `OTHER` — shipping, services, freebies. Recorded and counted in the total, **never pending**.
  - `CONSUMABLE` — received as an `IN` movement; the movement ledger stays the only way stock changes
    ([[0034-consumables-design]]).
  - `LICENSE` — *proposes* a seats / renewal update on the application through the confirmation diff;
    never changes `seatsPurchased` automatically ([[0088-application-license-seat-tracking]]).
- **Unit price** is integer minor units in the purchase's currency label, 64-bit
  ([[0100-money-as-64-bit-minor-units]]). `0` is valid (a freebie) and distinct from blank (unknown).
  By convention it is the price that should become each unit's cost, usually without VAT.
- **Received** is derived: the count of **live** assets linked to the line (from Phase 1b, units moved in
  for a consumable line). **Pending** = quantity − received − cancelled, never below zero. Each line read
  carries `receivedQuantity`, `pendingQuantity`, `receiptState` (`NONE | PARTIAL | RECEIVED | OVER`;
  `null` for an `OTHER` line or a kind this build does not know) and `lineTotal` (quantity × unit price,
  `null` when the price is unknown). `RECEIVED` means nothing is pending — a fully cancelled line reads
  `RECEIVED` too. The derivation lives in one place (`purchase-order-derived.ts`) for the detail, the list
  and the receipt filter.
- **Over-receipt is allowed, with a warning** (ADR-0099 §4 — the CTO's application of D-D). Receiving or
  linking beyond quantity − cancelled warns and offers "raise the line to *n*", but proceeding is fine;
  the line then shows as **over-received** ("5 of 4"). No lock is taken: received is a count of linked
  assets, never stored, so concurrent receives cannot corrupt it. Each unit is still its own transaction
  with its own asset-tag counter commit ([[0063-configurable-asset-tag-scheme]],
  [[0089-bulk-receiving-and-checkout-acknowledgement]]).
- **Cancelled quantity** is stored ("cancel remaining units"); the reason goes in the
  [[purchase-order-event]] log. It may not exceed the quantity (`400`, checked against the stored line when a
  PATCH carries only one of the two). A dedicated "cancel remaining units" action with a reason comes with
  the receiving flow; today a line update records the change before and after.
- **quantity × unitPrice must fit `MONEY_MAX`** on write (`400`), so every derived total stays exact.
- The **kind** of a line with live linked assets cannot change (`409`): its received units would silently
  stop counting.
- **A different model delivered** is received *against the line* with the model overridden and a note;
  the line is not split and keeps what was ordered.
- **Copy on confirm.** Receiving or linking copies the line's values (cost and currency, purchase date,
  warranty end from `warrantyMonths`) onto assets only through an explicit per-field confirmation: fills
  pre-checked, replacements never ([[0099-purchases-scope-model-and-optionality]] §2). A later price edit
  only *proposes* updates to linked assets.
- A line can be removed (soft delete) only while nothing is linked to it (`409` otherwise), and never when it
  is the last thing that identifies its purchase (no supplier, no reference: `400`). Registered in
  `SOFT_DELETABLE_MODELS` ([[0032-soft-delete-middleware]]).
- `manufacturerText` / `modelText` feed smart entry (`GET /suggestions/manufacturer`, `/lineModel`).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (as built)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `purchaseOrderId` | `cuid` | FK → [[purchase-order]], `Restrict`. |
| `position` | `int` | display order (`int4()`), default after the last live line. |
| `kind` | `text` | `ASSET \| OTHER` (+ `CONSUMABLE`, `LICENSE` later), default `ASSET`, validated by zod on write. |
| `description` | `string` | the only required field; as written on the document (≤ 500). |
| `manufacturerText` / `modelText` | `string?` | brand and model **as written on the document**, before (or instead of) mapping to a model. Added while building (#1472) from [[purchases/technical-analysis]] §5 — the entity design had no place for them. |
| `assetModelId` | `cuid?` | FK → [[asset-model]], `SetNull`. |
| `quantity` | `int` | ≥ 1 (`int4()`), default `1`. |
| `unitPrice` | `bigint?` | minor units, ≥ 0; `null` = unknown ([[0100-money-as-64-bit-minor-units]]). |
| `warrantyMonths` | `int?` | warranty end of a received unit = purchase date + this (0–1200). |
| `cancelledQuantity` | `int` | default `0`; ≤ `quantity`. |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[purchase-order]] · [[purchase-order-event]] · [[asset]] · [[asset-model]] · [[consumable-movement]] ·
[[application]] · [[0099-purchases-scope-model-and-optionality]] · [[purchases/_MOC]]
