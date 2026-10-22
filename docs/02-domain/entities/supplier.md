---
title: Supplier
tags: [domain, entity, purchases]
status: accepted
created: 2026-10-01
updated: 2026-10-21
---

# Supplier

> 🟢 built — backend (#1472), screens (#1474), AI assistant tools (#1478), merge (#1496), yearly totals API (#1500)
> · Area: Purchases ·
> [[0099-purchases-scope-model-and-optionality]]

> [!note] Built — API and contract (#1472)
> Model `Supplier` (`suppliers`), contract `packages/shared/src/schemas/supplier.ts`, endpoints
> `GET/POST /suppliers`, `GET/PATCH/DELETE /suppliers/:id`, `POST /suppliers/:id/restore`
> (`apps/api/src/purchase-orders/`). Screens (#1474): the *Suppliers* tab of the Purchases area
> (`/purchases/suppliers`) and the supplier page with its recent purchases; a purchase's supplier is typed and
> resolved on save, created inline when nobody has that name ([[0099-purchases-scope-model-and-optionality]],
> decisions while building Phase 1 web). The AI assistant reads and proposes suppliers through
> `supplier_search`, `supplier_get`, `supplier_create` and `supplier_update` (#1478). Merging a duplicate
> (#1496): `POST /suppliers/:id/merge` and `GET /suppliers/:id/merge-preview`, **Merge into…** on the supplier
> page. Yearly totals (#1500, API): `GET /suppliers/:id` carries `yearlyTotals`; the supplier page shows them in a
> follow-up web change.

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
- **Export** (`GET /suppliers/export?q=&deleted=`, #1597, [[0103-data-export-streaming-path]]): a CSV of every
  supplier the list would return for the same filters, under the same `purchaseOrder:read` (VIEWER denied by
  default) and the same ADMIN-only `deleted=only`. Columns: `id, name, taxId, website, salesContactName,
  salesContactEmail, salesContactPhone, supportContactName, supportContactEmail, supportContactPhone, notes,
  createdAt, updatedAt, deletedAt` — the list row, field for field. Every export is audited
  ([[data-export-log]]).
- **Yearly totals** (#1500; CEO decision 2026-10-21 on #1495; [[0099-purchases-scope-model-and-optionality]] §5,
  D-C). `GET /suppliers/:id` answers the supplier plus `yearlyTotals` — what the team spent with it per year,
  per currency label. Derived on every read, never stored:
  - **year** — the calendar year (UTC) of the purchase's order date, else of when the purchase was recorded
    (`createdAt`). The web stores a date-only order date at UTC midnight, so it lands in its own year; the
    recorded-date fallback can shift a purchase recorded around midnight on 31 December by a few hours;
  - **counted** — the supplier's live purchases whose status is neither `DRAFT` nor `CANCELLED` (a status a
    newer build adds counts), and their live lines, each as **(quantity − cancelled) × unit price**. This
    differs on purpose from a purchase's own total (quantity × unit price): cancelled units were not bought;
  - **per currency label**, through the shared grouping rule (`groupMoneyTotals`): trimmed and
    case-insensitive, the first spelling of the year shown, a separate *No currency* group (`currency: null`),
    never converted and never summed across labels. A sum above `MONEY_MAX` reads `amount: null`;
  - a line with units left and no price adds nothing and is counted in `unpricedLines` (a fully cancelled line
    is not — it would add nothing either way); `purchaseCount` counts the purchases in that year and label, a
    purchase with no lines included;
  - purchases a merge moved here count here; an archived supplier is a `404`, as before.

  Order: newest year first; within a year, one entry per label in the order its earliest purchase that year
  was dated. One aggregate query over the supplier's purchases (`@@index([supplierId])`) and their lines, one
  row per year and stored spelling. The field is optional in the contract (`SupplierDetailSchema`), so an older
  client still parses the row. The AI tool `supplier_get` reads the same route and keeps its projection: it does
  not return the totals.
- Supplier names feed smart entry: `GET /suggestions/supplierName` (ADR-0099 §7).
- **Global search** (#1499, [[0035-search-architecture]]): the `suppliers` index carries the name, tax ID and
  the two contact names (the names searchable, not returned) — never emails, phones, website or notes. Searched
  only with `purchaseOrder:read`; an archived supplier is removed, and a rename re-indexes its purchases.
- **Merging a duplicate** (CEO decision, 2026-10-03; [[0099-purchases-scope-model-and-optionality#Merge duplicate suppliers (2026-10-03, #1496)]]).
  An administrator (`purchaseOrder:delete`) merges the duplicate into the supplier that stays, after a preview,
  in one transaction:
  - **every purchase** of the duplicate — archived ones included — moves to the supplier that stays;
  - the supplier that stays gets the duplicate's value for each **empty** optional field (never the name);
    nothing it already holds is overwritten, and a differing value stays on the archived duplicate;
  - the duplicate is **archived**, never deleted; restoring it later brings it back with no purchases;
  - each moved purchase records `SUPPLIER_MERGED` with the actor ([[purchase-order-event]]). Suppliers have no
    activity log of their own, so a duplicate with no purchases leaves only its archived record.

  Refused: the same supplier twice (`400`), a supplier that never existed (`404`), an archived one on either
  side (`409` — also a second merge of an already merged duplicate). Both supplier rows are locked first, then
  the purchases, each in id order.

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
