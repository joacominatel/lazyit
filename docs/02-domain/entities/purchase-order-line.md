---
title: PurchaseOrderLine
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# PurchaseOrderLine

> 🟢 built — backend (#1472), receiving, linking and cancelling (#1473), consumable lines (#1476), license
> lines (#1477); their screens (#1474, #1475, #1476 web, #1477 web); AI assistant tools (#1478) · Area:
> Purchases · [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — API and contract (#1472)
> Model `PurchaseOrderLine` (`purchase_order_lines`). Lines are created inline with a purchase or through
> `POST /purchase-orders/:id/lines`, edited with `PATCH /purchase-orders/:id/lines/:lineId` and removed with
> `DELETE` on the same path — all under `purchaseOrder:write`. Receiving units and linking assets — what
> makes `Asset.purchaseOrderLineId` non-null — are built in #1473 (below), contract
> `packages/shared/src/schemas/purchase-receiving.ts`.

## Purpose

One line of a [[purchase-order]]: what was bought, how many, at what unit price — and, for an asset
line, the units that came out of it.

## Relationships

- **belongs to** one [[purchase-order]] (`purchaseOrderId`, `onDelete: Restrict`).
- **maps to** an optional [[asset-model]] (`assetModelId`, `SetNull`). Optional on purpose: a draft line
  does not force anyone to create a model; it is mapped when units are received.
- **produced** N [[asset]]s (`Asset.purchaseOrderLineId`, nullable). At most one line per asset.
- **maps to** an optional [[consumable]] (`consumableId`, `SetNull`) — a `CONSUMABLE` line only (#1476).
  It is received as `IN` [[consumable-movement]]s that reference the line (`ConsumableMovement.purchaseOrderLineId`).
- **maps to** an optional [[application]] (`applicationId`, `SetNull`) — a `LICENSE` line only (#1477). Its
  seats are applied to the application by a person, never automatically.

## Business rules

- **Entry is light** ([[0099-purchases-scope-model-and-optionality]], governing principle, CEO decision
  D-D): a **description is the only field the user must fill**. The quantity **defaults to 1** and the
  unit price is optional.
- **Kinds.** `ASSET` and `OTHER` in Phase 1; `CONSUMABLE` in Phase 1b (built, #1476); `LICENSE` in Phase 2 (built,
  #1477). Stored as
  `TEXT` validated by the shared zod schema on write, not a Prisma enum.
  - `ASSET` — received units become assets.
  - `OTHER` — shipping, services, freebies. Recorded and counted in the total, **never pending**.
  - `CONSUMABLE` — received as an `IN` movement; the movement ledger stays the only way stock changes
    ([[0034-consumables-design]]).
  - `LICENSE` — *proposes* a seats / renewal update on the application; a person confirms it, and the
    line counts the seats applied. Never changes `seatsPurchased` automatically
    ([[0088-application-license-seat-tracking]]).
- **Unit price** is integer minor units in the purchase's currency label, 64-bit
  ([[0100-money-as-64-bit-minor-units]]). `0` is valid (a freebie) and distinct from blank (unknown).
  By convention it is the price that should become each unit's cost, usually without VAT.
- **Received** is derived: the count of **live** assets linked to an `ASSET` line, or, for a `CONSUMABLE`
  line, the sum of the quantities of the `IN` movements posted from it (#1476), or, for a `LICENSE` line, the
  seats a person applied to its application (`appliedSeats`, #1477). **Pending** = quantity −
  received − cancelled, never below zero. Each line read
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
  PATCH carries only one of the two). `POST /purchase-orders/:id/lines/:lineId/cancel-remaining { quantity?,
  reason? }` (#1473) cancels every pending unit by default, never more than are pending (`400`), is a `409`
  when nothing is pending, locks the line row, and logs `UNITS_CANCELLED`; a plain line update still
  records the change before and after.
- **quantity × unitPrice must fit `MONEY_MAX`** on write (`400`), so every derived total stays exact.
- The **kind** of a line that received units — live linked assets, stock moved in, or seats applied —
  cannot change (`409`): its received units would silently stop counting.
- **A different model delivered** is received *against the line* with the model overridden and a note;
  the line is not split and keeps what was ordered.
- **Copy on confirm.** Receiving or linking copies the line's values (cost and currency, purchase date,
  warranty end from `warrantyMonths`) onto assets only through an explicit per-field confirmation: fills
  pre-checked, replacements never ([[0099-purchases-scope-model-and-optionality]] §2). A later price edit
  changes **no** linked asset (never write-through). As built, nothing proposes the new price to them either:
  the asset's *Purchase* panel marks the line price *Differs from purchase*, and an ordinary asset edit is how
  its cost changes (ADR-0099, decisions while building Phase 1 flows web). The per-asset proposal §2
  describes is not built.

## Receiving and linking (as built, #1473)

Only `ASSET` lines take assets (`400` otherwise, for the whole request); an archived purchase or line takes
nothing new (`404`). An asset links to at most one line.

**The apply mapping** — what the purchase offers an asset (`purchaseLineValues` in `@lazyit/shared`, used
by the API and available to the web):

| `apply` field | Asset columns written | Value |
| --- | --- | --- |
| `purchaseDate` | `purchaseDate` | the purchase's invoice date, else its order date (`purchaseDateSource`: `INVOICE` / `ORDER`) |
| `purchaseCost` | `purchaseCost` **and** `purchaseCurrency` | the line's unit price with the purchase's currency label — cost and currency move together |
| `warrantyEnd` | `warrantyEnd` | that purchase date + `warrantyMonths` (calendar months, UTC, clamped to the month's last day) |
| `company` | `company` | the purchase's company |
| `modelId` | `modelId` | the line's asset model (writes a `MODEL_CHANGED` history event too) |

A field the purchase has no value for is never applied (never a clear). The diff action per asset and field
is `FILL` (asset empty), `REPLACE` (different value; cost compares amount **and** label, trimmed and
case-insensitive), `SAME` or `UNAVAILABLE`.

- **Preview** — `POST /purchase-orders/:id/lines/:lineId/link-preview { assetIds }` (`purchaseOrder:read` +
  `asset:read`, writes nothing): the offered values, each asset's current vs purchase value per field with
  its action, its link state (`NONE | THIS_LINE | OTHER_LINE`), the ids that are not live assets
  (`missing`), and `receivedAfter` / `overReceivedAfter`.
- **Link** — `POST …/link-assets { assetIds, apply?, applyByAsset?, move? }` (`purchaseOrder:write` +
  `asset:write`): partial success `{ linked, failed[{ assetId, reason, error }], overReceived, line }`.
  `apply` lists the fields copied onto every asset; `applyByAsset` replaces that list for the assets it
  names. Reasons: `NOT_FOUND` (missing or archived), `ALREADY_LINKED`, `LINKED_ELSEWHERE` (an asset on
  another line moves only with `move: true`). One transaction over locked asset rows: the links, the
  `PURCHASE_LINKED` (and `MODEL_CHANGED`) [[asset-history]] events, one `ASSET_LINKED` on the purchase and,
  for a move, `ASSET_UNLINKED` on the purchase it left.
- **Unlink** — `POST …/unlink-assets { assetIds }` (same permissions), one or many, partial success
  (`NOT_FOUND`, `NOT_LINKED`). The asset's purchase values are **never cleared**. `PURCHASE_UNLINKED` per
  asset and one `ASSET_UNLINKED`, in one transaction.
- **Receive** — `POST …/receive` (`purchaseOrder:write` + `asset:write`) generates assets through the
  bulk-receive loop ([[0089-bulk-receiving-and-checkout-acknowledgement]]: one transaction and one asset-tag
  counter commit per unit). Everything is prefilled — model ← the line (a line without one is a `400` unless
  the body names `modelId`), status ← `IN_STORAGE`, location ← the purchase's delivery location while live,
  company ← the purchase's, purchase date ← the invoice date else **today**, warranty end ← that date +
  `warrantyMonths`, cost ← unit price with the purchase's label — and every body field only overrides it
  (`null` leaves it empty). The quantity defaults to the serials, else to every pending unit (`400` when
  none is pending and no quantity is given). Result `{ created, failed[], overReceived, line }`; each unit's
  `CREATED` history names the line and the purchase gets one `UNITS_RECEIVED`.
- **From the Assets list** — `POST /assets/batch/receive` accepts an optional `purchaseOrderLineId` (plus
  `purchaseCurrency` and `warrantyEnd`): the units are received against that line with the same checks
  (`400` for a line that is not a live `ASSET` line; `403` without `purchaseOrder:write`), and the result
  carries `overReceived`.
- **Over-receipt** is allowed everywhere and reported (`overReceived`, `overReceivedAfter`, the event
  payloads), never refused (ADR-0099 §4).
- A line can be removed (soft delete) only while nothing was received on it — no linked asset, no stock
  moved in, no seat applied (`409` otherwise) — and never when it is the last thing that identifies its purchase (no supplier, no reference: `400`). Registered in
  `SOFT_DELETABLE_MODELS` ([[0032-soft-delete-middleware]]).
- `manufacturerText` / `modelText` / `description` feed smart entry (`GET /suggestions/manufacturer`,
  `/lineModel`, `/lineDescription` — the last since #1473), from live lines of live purchases.

## Consumable lines (as built, #1476)

- **Mapping.** `consumableId` is accepted on a `CONSUMABLE` line only (`400` otherwise — at the edge on a
  create, against the stored kind on a PATCH), and stays **optional** there: a draft line need not pick its
  consumable until stock is received. The consumable must be **live** (`400` for a missing or archived one,
  on create, add and update). Changing a line away from `CONSUMABLE` clears its consumable (logged in
  `LINE_UPDATED`). The consumable of a line that already received stock may still change ("a different item
  came"): each movement keeps its own consumable, and the line keeps counting every unit it received.
- **Receive into stock** — `POST /purchase-orders/:id/lines/:lineId/receive-stock { quantity, note? }`
  (`purchaseOrder:write` + `consumable:write`). It posts **one** `IN` [[consumable-movement]] through the
  consumables service (never a direct `currentStock` write) that carries `purchaseOrderLineId`, `reason`
  *Received from purchase* and the purchase's reference (the fixed *Received from a purchase* without one —
  visible to every consumable reader, a CEO decision of 2026-10-02, #1494) and `note` as its notes. Inside
  that movement's transaction the purchase is locked `FOR KEY SHARE` first (the lock a link takes) and the
  line re-read: a kind change or a line removal — which lock the purchase `FOR UPDATE` — serializes with the
  receipt and sees it, and a line whose kind or consumable changed meanwhile is a `409` with nothing written.
  The purchase gets one `STOCK_RECEIVED` in the same transaction. Result `{ movement, overReceived, line }`.
- **Refusals.** `400` for a line that is not `CONSUMABLE`, has no consumable ("map the line to a
  consumable") or names an archived one ("restore it or map the line to another"); `404` for an archived
  purchase or line. Receiving more than is pending is allowed and flagged (`overReceived`, `OVER`).
- **Received never goes down.** Movements are append-only; a mistaken receipt is corrected on the stock
  with an ordinary movement that carries no line, and the line keeps counting the receipt (the
  [[0098-consumable-delivery-targets]] rule for returns). This is why a line that received stock can neither
  change kind nor be removed: unlike an asset link, a receipt cannot be undone.
- **Everywhere receipt is read** — the line and purchase reads, the `receipt` filter, `GET
  /purchase-orders/pending-lines` and cancel remaining units — a `CONSUMABLE` line counts its moved-in
  units, with the same derivation. A purchase's receipt counters add units across its countable lines
  whatever each consumable's unit; the state and the per-line counts are what the UI leads with.

## License lines (as built, #1477)

- **Mapping.** `applicationId` is accepted on a `LICENSE` line only (`400` otherwise — at the edge on a
  create, against the stored kind on a PATCH) and stays **optional** there until the license is applied. The
  application must be **live** (`400` for a missing or archived one, on create, add and update). Changing a
  line away from `LICENSE` clears it (logged in `LINE_UPDATED`); seats already applied stay counted on the
  line if its application changes, as stock does on a consumable line.
- **The proposal** — `GET /purchase-orders/:id/lines/:lineId/license-proposal` (`purchaseOrder:read` +
  `application:read`, writes nothing): the line, its application's current `seatsPurchased`, derived
  `seatsUsed` and `renewalDate` (an archived application is shown with `deletedAt` and `seatsUsed: null`),
  `seatsToAdd` = the line's pending seats, `seatsPurchasedAfter` (an untracked count starts at 0),
  `overAppliedAfter`, and warnings: `NO_APPLICATION`, `APPLICATION_ARCHIVED`, `SEATS_UNTRACKED`,
  `NOTHING_PENDING`, `OVER_APPLIED`. The renewal date is never proposed: the term is not on the line, so the
  operator types it.
- **The apply** — `POST /purchase-orders/:id/lines/:lineId/apply-license { seatsToAdd?, renewalDate? }`
  (`purchaseOrder:write` + `application:write`, at least one of the two). Explicit and user-triggered: it
  adds `seatsToAdd` to the application's `seatsPurchased` (an untracked `null` count becomes `seatsToAdd`,
  flagged `SEATS_UNTRACKED`) and/or sets its `renewalDate`, **through `ApplicationsService.update`** — the
  application's own write path — and raises the line's `appliedSeats` by `seatsToAdd`. One transaction,
  locks in order: the purchase `FOR KEY SHARE`, the line `FOR UPDATE`, the application `FOR UPDATE`. The
  purchase gets `LICENSE_APPLIED { lineId, applicationId, seatsAdded, seatsPurchased: { from, to },
  renewalDate: { from, to }, appliedSeats: { from, to }, overApplied }`. Result `{ application, line,
  overApplied, warnings }`.
- **Over-application** (more seats applied than the line bought) is allowed and flagged (`overApplied`,
  `OVER`), like an over-received line (ADR-0099 §4).
- **Refusals.** `400` for a line that is not `LICENSE`, has no application, names an archived one, or would
  push a count past int4; `404` for an archived purchase or line.
- **Applied seats only grow.** `seatsPurchased` is one mutable number, not a ledger
  ([[0088-application-license-seat-tracking]]): lazyit never recomputes it from lines. A mistaken apply is
  corrected on the application itself; the line keeps counting what was applied. So a line with applied
  seats can neither change kind nor be removed.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (as built)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `purchaseOrderId` | `cuid` | FK → [[purchase-order]], `Restrict`. |
| `position` | `int` | display order (`int4()`), default after the last live line. |
| `kind` | `text` | `ASSET \| OTHER \| CONSUMABLE \| LICENSE`, default `ASSET`, validated by zod on write. |
| `description` | `string` | the only required field; as written on the document (≤ 500). |
| `manufacturerText` / `modelText` | `string?` | brand and model **as written on the document**, before (or instead of) mapping to a model. Added while building (#1472) from [[purchases/technical-analysis]] §5 — the entity design had no place for them. |
| `assetModelId` | `cuid?` | FK → [[asset-model]], `SetNull`. |
| `consumableId` | `cuid?` | FK → [[consumable]], `SetNull` (#1476); a `CONSUMABLE` line only. |
| `applicationId` | `cuid?` | FK → [[application]], `SetNull` (#1477); a `LICENSE` line only. |
| `appliedSeats` | `int` | default `0` (#1477): the seats a person applied from this `LICENSE` line — its received units. Raised only by the apply route. Not on the wire; read as `receivedQuantity`. |
| `quantity` | `int` | ≥ 1 (`int4()`), default `1`. |
| `unitPrice` | `bigint?` | minor units, ≥ 0; `null` = unknown ([[0100-money-as-64-bit-minor-units]]). |
| `warrantyMonths` | `int?` | warranty end of a received unit = purchase date + this (0–1200). |
| `cancelledQuantity` | `int` | default `0`; ≤ `quantity`. |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[purchase-order]] · [[purchase-order-event]] · [[asset]] · [[asset-model]] · [[consumable-movement]] ·
[[application]] · [[0099-purchases-scope-model-and-optionality]] · [[purchases/_MOC]]
