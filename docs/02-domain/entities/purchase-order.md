---
title: PurchaseOrder
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# PurchaseOrder

> 🟢 built — backend (#1472); screens, receiving, linking and documents pending (Purchases Phase 1) ·
> Area: Purchases · [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — API and contract (#1472)
> Model `PurchaseOrder` (`purchase_orders`), contract `packages/shared/src/schemas/purchase-order.ts`,
> endpoints under `/purchase-orders` (`apps/api/src/purchase-orders/`): list, detail, create (lines
> inline), header update, soft delete, restore, the line endpoints ([[purchase-order-line]]) and the
> activity log ([[purchase-order-event]]). Receiving, asset linking, documents and the web screens come in
> later Phase 1 units (#1473 onwards). In the product it is called a **Purchase** (es: *Compra*).

## Purpose

The **IT side of one purchase**: what was bought, from which [[supplier]], with which documents, and
which [[asset]]s came out of it — tied to the finance PO number. lazyit **records** purchases; it does
not run purchasing. The finance system stays the system of record: no approvals, budgets, payables,
three-way match, supplier portal or exchange rates ([[0099-purchases-scope-model-and-optionality]] §1).

The area is **always available** (subject to `purchaseOrder:*` permissions) and **optional at entry**:
there is no instance switch, nobody has to record purchases, and an asset's free purchase fields keep
working exactly as before ([[0099-purchases-scope-model-and-optionality]] §7, CEO decision D-B).

## Relationships

- **from** an optional [[supplier]] (`supplierId`, nullable).
- **has** N [[purchase-order-line]]s.
- **has** N [[purchase-order-event]]s — its append-only activity log.
- **has** N [[attachment]]s (`entityType = PURCHASE_ORDER`) — quotes, the finance PO, invoices,
  delivery notes. They are **shared** with every linked asset (the same rows, listed read-only there).
- **delivers to** an optional [[location]] (`deliveryLocationId`), used as the default location when
  receiving units.
- **produced** N [[asset]]s, indirectly: each asset points at one line (`Asset.purchaseOrderLineId`).

## Business rules

- **Entry is light** ([[0099-purchases-scope-model-and-optionality]], governing principle, CEO decision
  D-D). **No single field is required**: a purchase can be saved once something identifies it — a
  supplier, a reference, or one line. A generic supplier is fine. The rule holds after creation too: a
  header update that clears the supplier and the reference of a purchase with no live line is a `400`, and
  so is removing the last line of a purchase with neither ([[purchase-order-line]]).
- The supplier and the delivery location a write names must be **live** (`400` otherwise — a soft-deleted
  row would still pass the FK).
- **Currency** is an **optional free-text label** the user types ("ARS", "USD", "u$s"), suggested by smart
  entry, one per purchase and shared by all its lines. No ISO list and no currency semantics: lazyit
  derives nothing from the label, never applies exchange rates and never sums across labels (CEO decision
  D-C, ADR-0099 §5).
- **Reference** (the finance PO number) is optional free text and **not unique**. A reference already used
  on a live purchase of the same supplier is surfaced as a non-blocking suggestion; saving anyway stays
  possible. Without a reference, the purchase displays as *Supplier · date*. No auto-numbering in v1.
- **Invoice numbers** are **one free-text field**, however many invoices the purchase lists.
- **Status.** Stored and set by the user: `DRAFT`, `ORDERED` (the default on create), `CANCELLED` —
  stored as `TEXT` and validated by the shared zod schema on write, not a Prisma enum.
  **Derived** for display: *Partially received* (some units received, some pending) and *Received*
  (every countable line received or cancelled). There is no manual *Closed*. As built, every read carries
  `receipt: { state, ordered, received, cancelled, pending }` over the countable lines (`null` when there is
  none), `state` being `NONE | PARTIAL | RECEIVED | OVER` — `OVER` when nothing is pending and some line
  received more than it expected; an over-received line next to a pending one leaves the purchase
  `PARTIAL`. A status a newer build writes reads as a plain string.
- **The list** (`GET /purchase-orders`, newest first) searches reference, invoice numbers, supplier name
  and live line descriptions (`q`), and filters by `status` (multi-value), `supplierId` and `receipt` — a
  derived state, or `PENDING`: at least one unit pending on a purchase that is not `CANCELLED`. The receipt
  filter is computed with the same functions as the detail, so the list and the shown state agree.
- **Cancel purchase** is offered only while nothing is received; afterwards the line action *Cancel
  remaining units* closes it cleanly.
- **Totals are derived, never stored**: the sum of its lines' quantity × unit price, in the purchase's
  currency label ([[0100-money-as-64-bit-minor-units]]). On the wire `totals` is a list of
  `{ currency, amount, unpricedLines }` built by the shared `groupMoneyTotals` — one entry for a purchase
  with lines (one purchase, one label), with the lines that have no price counted in `unpricedLines`.
  `amount` is `null` only if the sum would exceed `MONEY_MAX`; a line whose own total would is refused on
  write. Amounts display as entered: locale grouping,
  no forced decimals on whole amounts (ADR-0100 §5). Any total across purchases groups by label (trimmed,
  case-insensitive), with blank labels as *No currency*.
- **Soft delete** is ADMIN-only (`purchaseOrder:delete`), **keeps every asset link**, and is restorable
  (restore ADMIN-only). Registered in `SOFT_DELETABLE_MODELS` ([[0032-soft-delete-middleware]]).
- **Permissions:** `purchaseOrder:read` (ADMIN, MEMBER; VIEWER denied by default), `:write` (ADMIN,
  MEMBER), `:delete` (ADMIN) — [[authorization]].
- Every change writes a [[purchase-order-event]] in the same transaction.
- The supplier FK is `Restrict` (a supplier with purchases can never be hard-deleted) and the delivery
  location FK is `SetNull` (like `Asset.locationId`); soft deletes never fire either.
- Notes, references and invoice numbers are untrusted text, sanitized when rendered
  ([[0029-untrusted-content-sanitization]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (as built)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `supplierId` | `cuid?` | optional FK → [[supplier]], `Restrict`. |
| `reference` | `string?` | the finance PO / order number. Not unique; a repeat is a suggestion, not a refusal. |
| `status` | `text` | `DRAFT \| ORDERED \| CANCELLED`, default `ORDERED`, validated by zod on write; user-set; *Partially received* / *Received* are derived, not stored. |
| `currency` | `string?` | free-text label as typed (trimmed, ≤ 32); optional; no ISO list. |
| `orderDate` | `datetime?` | |
| `expectedDate` | `datetime?` | drives "overdue" on the pending view. |
| `deliveryLocationId` | `cuid?` | FK → [[location]], `SetNull`. |
| `company` | `string?` | free-text grouping label, flows to received assets' `company` ([[0076-asset-company-grouping-field]]). |
| `invoiceNumbers` | `string?` | one free-text field; a purchase with several invoices lists them in it. |
| `invoiceDate` | `datetime?` | the default purchase date for units received after it is known. |
| `notes` | `string?` | |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[supplier]] · [[purchase-order-line]] · [[purchase-order-event]] · [[asset]] · [[attachment]] ·
[[0099-purchases-scope-model-and-optionality]] · [[0100-money-as-64-bit-minor-units]] · [[purchases/_MOC]]
