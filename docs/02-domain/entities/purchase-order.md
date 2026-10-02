---
title: PurchaseOrder
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-01
---

# PurchaseOrder

> ⚪ planned (Purchases Phase 1) · Area: Purchases · [[0099-purchases-scope-model-and-optionality]]

> [!warning] Not built yet
> This note records the accepted design. No `PurchaseOrder` model, endpoint or screen exists in the
> code today; the fields below are the planned shape, and the Phase 1 backend unit settles the final
> column names and constraints. In the product it is called a **Purchase** (es: *Compra*).

## Purpose

The **IT side of one purchase**: what was bought, from which [[supplier]], with which documents, and
which [[asset]]s came out of it — tied to the finance PO number. lazyit **records** purchases; it does
not run purchasing. The finance system stays the system of record: no approvals, budgets, payables,
three-way match, supplier portal or exchange rates ([[0099-purchases-scope-model-and-optionality]] §1).

The area is optional: an **instance switch, OFF by default**. With it OFF the Purchases area is hidden,
nothing is deleted, and linked assets keep showing their purchase read-only.

## Relationships

- **from** one [[supplier]] (`supplierId`, required).
- **has** N [[purchase-order-line]]s.
- **has** N [[purchase-order-event]]s — its append-only activity log.
- **has** N [[attachment]]s (`entityType = PURCHASE_ORDER`) — quotes, the finance PO, invoices,
  delivery notes. They are **shared** with every linked asset (the same rows, listed read-only there).
- **delivers to** an optional [[location]] (`deliveryLocationId`), used as the default location when
  receiving units.
- **produced** N [[asset]]s, indirectly: each asset points at one line (`Asset.purchaseOrderLineId`).

## Business rules

- **Required:** supplier and currency, nothing else. A generic supplier is fine.
- **Currency** is a user-chosen **ISO 4217 code**, one per purchase, shared by all its lines. lazyit never
  applies exchange rates and never sums across currencies.
- **Reference** (the finance PO number) is optional free text. When set it is **unique per supplier among
  live purchases**: a partial unique index `WHERE "deletedAt" IS NULL` in raw SQL
  ([[0041-soft-delete-reuse-and-restore]]). Without one, the purchase displays as *Supplier · date*. No
  auto-numbering in v1.
- **Status.** Stored and set by the user: `DRAFT`, `ORDERED` (the default on create), `CANCELLED`.
  **Derived** for display: *Partially received* (some units received, some pending) and *Received*
  (every countable line received or cancelled). There is no manual *Closed*.
- **Cancel purchase** is offered only while nothing is received; afterwards the line action *Cancel
  remaining units* closes it cleanly.
- **Totals are derived, never stored**: the sum of its lines' quantity × unit price, in the purchase's
  currency ([[0100-money-as-64-bit-minor-units]]).
- **Soft delete** is ADMIN-only (`purchaseOrder:delete`), **keeps every asset link**, and is restorable
  (restore ADMIN-only). Registered in `SOFT_DELETABLE_MODELS` ([[0032-soft-delete-middleware]]).
- **Permissions:** `purchaseOrder:read` (ADMIN, MEMBER; VIEWER denied by default), `:write` (ADMIN,
  MEMBER), `:delete` (ADMIN) — [[authorization]].
- Every change writes a [[purchase-order-event]] in the same transaction.
- Notes, references and invoice numbers are untrusted text, sanitized when rendered
  ([[0029-untrusted-content-sanitization]]).

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (planned)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `supplierId` | `cuid` | required FK → [[supplier]]. |
| `reference` | `string?` | the finance PO / order number; unique per supplier among live rows when set. |
| `status` | `DRAFT \| ORDERED \| CANCELLED` | user-set; *Partially received* / *Received* are derived, not stored. |
| `currency` | `string` | ISO 4217 code, required. |
| `orderDate` | `datetime?` | |
| `expectedDate` | `datetime?` | drives "overdue" on the pending view. |
| `deliveryLocationId` | `cuid?` | FK → [[location]]. |
| `company` | `string?` | free-text grouping label, flows to received assets' `company` ([[0076-asset-company-grouping-field]]). |
| invoice number(s) | text | one purchase can carry several invoices; the storage shape is a Phase 1 decision. |
| `invoiceDate` | `datetime?` | the default purchase date for units received after it is known. |
| `notes` | `string?` | |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[supplier]] · [[purchase-order-line]] · [[purchase-order-event]] · [[asset]] · [[attachment]] ·
[[0099-purchases-scope-model-and-optionality]] · [[0100-money-as-64-bit-minor-units]] · [[purchases/_MOC]]
