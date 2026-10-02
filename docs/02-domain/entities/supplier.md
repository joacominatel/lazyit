---
title: Supplier
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-01
---

# Supplier

> ⚪ planned (Purchases Phase 1) · Area: Purchases · [[0099-purchases-scope-model-and-optionality]]

> [!warning] Not built yet
> This note records the accepted design. No `Supplier` model, endpoint or screen exists in the code
> today; the fields below are the planned shape, and the Phase 1 backend unit settles the final column
> names and constraints.

## Purpose

**Who the team buys from and pays** — a reseller, a wholesaler, a carrier, a CSP, or a generic
"Mercado Libre" / "Online / other" bucket for one-off sellers. Suppliers live inside the Purchases area
(a tab next to the purchase list) because they carry contacts and history, not because they are a
picklist.

A supplier is **not**:

- a **manufacturer** — who makes the hardware ([[asset-model]]`.manufacturer`, e.g. Dell);
- a **publisher** — who makes the software ([[application]]`.vendor`, shown as "Publisher", e.g.
  Microsoft).

Dell is the manufacturer; the wholesaler you pay for the Dell laptop is the supplier. Those existing
fields stay as they are.

## Relationships

- **supplies** N [[purchase-order]]s (`PurchaseOrder.supplierId`).

## Business rules

- **Soft delete only** ([[0006-soft-delete-and-auditing]]); registered in `SOFT_DELETABLE_MODELS`
  ([[0032-soft-delete-middleware]]). Restore is ADMIN-only.
- **Duplicates are prevented by suggestion, not by refusal.** Typing a name suggests existing suppliers
  by a normalized key (case, accents, punctuation and legal suffixes such as *S.A.*, *SRL*, *Inc.*
  removed); an existing tax ID is flagged immediately. Creating anyway stays possible
  ([[purchases/ux-proposal]] §4.3). Whether `name` and `taxId` are also unique among live rows is left to
  the Phase 1 design ([[0099-purchases-scope-model-and-optionality]], follow-ups).
- **Permissions** follow the purchase domain: `purchaseOrder:read` to see suppliers, `:write` to create
  and edit, `:delete` (ADMIN) to soft-delete ([[authorization]]).
- Supplier text is untrusted content: stored as written, sanitized when rendered
  ([[0029-untrusted-content-sanitization]]).
- Merging duplicate suppliers is a Phase 2 action.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (planned)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `name` | `string` | required; the name the team uses ("Compumundo"). |
| `taxId` | `string?` | the legal tax ID (e.g. a CUIT); the strongest near-duplicate key and the first key document extraction matches on. |
| `website` | `string?` | |
| `salesContactName` / `salesContactEmail` / `salesContactPhone` | `string?` | the sales contact. |
| `supportContactName` / `supportContactEmail` / `supportContactPhone` | `string?` | the **support / RMA** contact — separate from sales, and the one shown one click from a linked asset. |
| `notes` | `string?` | e.g. "RMA via web form, 15 business days". |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[purchase-order]] · [[purchase-order-line]] · [[asset-model]] · [[application]] ·
[[0099-purchases-scope-model-and-optionality]] · [[purchases/_MOC]]
