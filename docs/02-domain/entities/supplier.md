---
title: Supplier
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-02
---

# Supplier

> 🟢 built — backend (#1472), screens (#1474), AI assistant tools (#1478) · Area: Purchases ·
> [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — API and contract (#1472)
> Model `Supplier` (`suppliers`), contract `packages/shared/src/schemas/supplier.ts`, endpoints
> `GET/POST /suppliers`, `GET/PATCH/DELETE /suppliers/:id`, `POST /suppliers/:id/restore`
> (`apps/api/src/purchase-orders/`). Screens (#1474): the *Suppliers* tab of the Purchases area
> (`/purchases/suppliers`) and the supplier page with its recent purchases; a purchase's supplier is typed and
> resolved on save, created inline when nobody has that name ([[0099-purchases-scope-model-and-optionality]],
> decisions while building Phase 1 web). The AI assistant reads and proposes suppliers through
> `supplier_search`, `supplier_get`, `supplier_create` and `supplier_update` (#1478).

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
- **Only the name is required.** Everything else, the tax ID included, is optional — entry stays light
  ([[0099-purchases-scope-model-and-optionality]], governing principle, CEO decision D-D).
- **No uniqueness constraints.** Neither `name` nor `taxId` is unique, among live rows or otherwise.
  Duplicates are reduced by suggestion, never by refusal: typing a name suggests existing suppliers by a
  normalized key (case, accents, punctuation and legal suffixes such as *S.A.*, *SRL*, *Inc.* removed),
  and an existing tax ID is flagged immediately ("is this the same supplier?"). Creating anyway stays
  possible ([[purchases/ux-proposal]] §4.3).
- **Permissions** follow the purchase domain: `purchaseOrder:read` to see suppliers, `:write` to create
  and edit, `:delete` (ADMIN) to soft-delete ([[authorization]]).
- Supplier text is untrusted content: stored as written, sanitized when rendered
  ([[0029-untrusted-content-sanitization]]). On write the `website` must be a scheme-less host or
  http(s) (the `Application.url` rule — `javascript:`/`data:` refused) and the two contact emails must be
  well-formed; nothing else is validated beyond length.
- The list (`GET /suppliers`) searches name, tax ID and the sales / support contact names and emails;
  `deleted=only` (ADMIN) lists archived suppliers. Soft-deleting a supplier leaves its purchases pointing at
  it — they show it, flagged as archived. The FK from a purchase is `Restrict`, so a supplier with purchases
  can never be hard-deleted.
- Supplier names feed smart entry: `GET /suggestions/supplierName` (ADR-0099 §7).
- Merging duplicate suppliers (planned for Phase 2 in ADR-0099 §13) is **not built**: the Phase 2 unit left
  it out (ADR-0099, decisions while building Phase 2). Duplicates are reduced only by the suggestions above.

## Conventions

- **ID:** `cuid()` ([[0005-id-strategy]]).
- **Timestamps / soft delete:** `createdAt`, `updatedAt`, `deletedAt`.

## Fields (as built)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `cuid` | |
| `name` | `string` | the only required field; the name the team uses ("Compumundo"). Not unique. |
| `taxId` | `string?` | optional; the legal tax ID (e.g. a CUIT). Not unique — the strongest near-duplicate hint and the first key document extraction matches on. |
| `website` | `string?` | host or http(s) URL, ≤ 500. |
| `salesContactName` / `salesContactEmail` / `salesContactPhone` | `string?` | the sales contact; the email is validated on write. |
| `supportContactName` / `supportContactEmail` / `supportContactPhone` | `string?` | the **support / RMA** contact — separate from sales, and the one shown one click from a linked asset. |
| `notes` | `string?` | e.g. "RMA via web form, 15 business days". |
| `createdAt` / `updatedAt` / `deletedAt` | `datetime` | |

Related: [[purchase-order]] · [[purchase-order-line]] · [[asset-model]] · [[application]] ·
[[0099-purchases-scope-model-and-optionality]] · [[purchases/_MOC]]
