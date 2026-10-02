---
title: "ADR-0099: Purchases — scope, model, and optionality"
tags: [adr, purchases, assets, suppliers, money, currency, permissions, ai-assistant, data-model]
status: accepted
created: 2026-10-01
updated: 2026-10-01
deciders: [Joaquín Minatel]
---

# ADR-0099: Purchases — scope, model, and optionality

## Status

**accepted** — 2026-10-01 (epic #1465, issue #1466). Approved by the CEO as one package:
"dale, aprobado el paquete con la ampliación de montos" (the package is approved, including the money
widening). **Design only — nothing in this record is built yet.** Phase 1 builds it; until then every
entity, column, permission and switch named here is *planned*.

This record **reverses one sentence of [[0089-bulk-receiving-and-checkout-acknowledgement]]** (a
purchase-order entity as a non-goal) and lifts the supplier deferral of
[[0034-consumables-design]] and the PO-number deferral of [[0088-application-license-seat-tracking]].
Those records keep their other decisions and carry dated pointers here. The money-width change the
package includes is its own decision: [[0100-money-as-64-bit-minor-units]].

Research and the CEO's verbatim answers: [[purchases/_MOC|Purchases research vault]] — start with
[[purchases/decisions|the decisions note]].

## Context

IT teams buy hardware, consumables and licenses several times a month, and today lazyit only keeps the
result: six nullable purchase columns on [[asset]] (`purchaseDate`, `warrantyEnd`, `purchaseCost`,
`usefulLifeMonths`, `salvageValue`, plus the `company` label) and the seat/cost/renewal columns on
[[application]]. There is no supplier, no order number, no invoice, and no way to say "these 20 monitors
came from that order". Operators work around it with notes and ad-hoc custom fields (`proveedor`, `oc`,
`nro_oc`), so the same fact exists in several shapes. The pains, in the order the research ranks them
([[purchases/user-interview]]):

1. Finance asks "which assets are on invoice X?" and nobody can answer quickly.
2. Partial deliveries: nobody knows whether the 4th of 4 laptops arrived.
3. Warranty claims need the invoice, which sits in someone's inbox.
4. Cost recorded in the wrong currency, or with no currency at all.
5. Consumable stock goes in with no trace of the order or its cost.

Three facts constrain the answer:

- **The finance system stays the system of record.** The target team already has an ERP where finance
  issues and approves purchase orders. lazyit keeps the **IT side** of a purchase — what was bought,
  from whom, the documents, and which units came out of it — tied to the finance number.
- **The asset stays the centre** ([[0004-asset-centric-design]], [[asset-centric]]). A purchase is
  provenance attached to assets, not a new centre.
- **Every existing reader of the asset purchase fields keeps working** — depreciation, the warranty
  sweeper and dashboard tile, filters, CSV, import, clone, the AI tools and the reporting agent. The
  full inventory of readers is in [[purchases/technical-analysis]] §1.

## Considered options

**Data model**

- **Option 1 — thin purchase record: header + lines, assets point at a line** *(chosen)*. Small surface,
  no change to how assets are read, and it reuses bulk receive, attachments, permissions and the AI tool
  machinery.
- **Option 2 — Option 1 plus a receipt ledger** (`PurchaseOrderReceipt`: line, quantity, received-at,
  actor). Records "arrived but not yet registered" separately. Rejected: two counters (received vs
  registered) for operators to reconcile, which the research never asked for, and the goods-receipt
  ledger [[0089-bulk-receiving-and-checkout-acknowledgement]] declined. It can be added on top of
  Option 1 later without remodelling.
- **Option 3 — two free-text fields on the asset** (`orderNumber`, `supplier`) and a page grouping by
  them. Rejected: no lines, quantities, unit prices or shared documents, nothing for extraction to fill,
  and it does not answer pains 1, 2 or 5.

**How asset purchase fields coexist with a linked purchase**

- **Copy on explicit confirmation; asset fields stay authoritative** *(chosen)*. Same pattern as copying
  model specs onto a new asset.
- **Read-through** (asset fields derived from the line while linked). Rejected: touches every reader
  listed above, creates two sources of truth decided per row, and unlinking must re-materialise values
  — a read-path change over production data.
- **Write-through** (editing a line price rewrites every linked asset). Rejected: silently mutates
  asset data and writes N history events per edit; it breaks "never overwrite without the human".

**Scope**

- **Keep purchase orders a non-goal** and leave the purchase fields on the asset. Rejected by the CEO:
  pains 1–5 stay unanswered.
- **A procurement module** (approvals, budgets, payables). Rejected: it competes with the finance system
  the customer already has and contradicts the IT-native positioning in [[vision]].

## Decision

### 1. Scope and hard limits

lazyit **records purchases**. It does **not** run purchasing. The CEO's hard limits — out of scope
unless a new ADR says otherwise:

- approval workflows or approval chains;
- budgets;
- invoices as payables: payment status, due dates, payment terms, bank details;
- three-way match (order ↔ delivery note ↔ invoice);
- a supplier portal;
- exchange rates of any kind, and conversion between currencies (§5).

Also out of v1, from the research and the UX defaults accepted with the package
([[purchases/ux-proposal]] §1 and §8): sending or printing purchase orders to suppliers; a tax engine or
a net/gross toggle; spreading shipping or overhead onto asset cost; creating assets at order time; and
leases, which are a different acquisition type and get their own ADR if they come.

The area is named **Purchases** (en) / **Compras** (es), not "Purchase Orders": lazyit does not issue
orders. It lives in the sidebar under **Inventory**, next to Assets and Consumables, with the tabs
*Purchases*, *Pending units* and *Suppliers*.

### 2. Entity model

Four new entities, all planned for Phase 1 (details in the entity notes):

- **[[supplier]]** — who the team buys from and pays. Soft-deletable. Name, optional tax ID (the real
  near-duplicate key), website, a sales contact, a **separate support/RMA contact**, notes. A supplier
  is **not** a manufacturer (who makes hardware, [[asset-model]]`.manufacturer`) and **not** a publisher
  (who makes software, [[application]]`.vendor`); those fields stay as they are.
- **[[purchase-order]]** — one purchase. Soft-deletable. Required supplier and currency; optional
  reference (the finance PO number), order date, expected date, delivery location, company, invoice
  number(s), invoice date, notes; a user-set status.
- **[[purchase-order-line]]** — one line on a purchase. Soft-deletable. A `kind`, description, quantity,
  unit price, optional model mapping and warranty months, and a stored **cancelled quantity**.
- **[[purchase-order-event]]** — the purchase's **append-only** activity log (`createdAt` only, never
  updated or deleted, [[0006-soft-delete-and-auditing]]). It carries the actor in exactly one of two
  columns — a human `performedById` or a `serviceAccountId` — enforced by a DB **CHECK** constraint, plus
  an optional `aiInvocationId` for provenance. This is the pattern every audit-bearing table already
  follows ([[INVARIANTS]] INV-SA-4, [[authorization]] §7).

The three soft-deletable models join `SOFT_DELETABLE_MODELS` ([[0032-soft-delete-middleware]]) so reads
never leak deleted rows.

**Line kinds.** `ASSET` and `OTHER` (shipping, services, freebies) in Phase 1; `CONSUMABLE` in Phase 1b;
`LICENSE` in Phase 2. `OTHER` lines are never "pending". A consumable line takes effect only as an `IN`
[[consumable-movement]] that carries the line id — the movement ledger stays the only place stock
changes ([[0034-consumables-design]]). A license line links to an [[application]] and **proposes** a
seats/renewal update through the same confirmation diff; it never changes `seatsPurchased`
automatically.

**Asset linkage.** [[asset]] gains a nullable **`purchaseOrderLineId`** (FK, `onDelete: Restrict`; soft
delete never triggers it). N assets per line, at most one line per asset (an asset is bought once).
Linking and unlinking are discrete, audited state changes: they write new [[asset-history]] event types
(appended at the tail of the enum, [[0033-asset-history-event-model]]) and a [[purchase-order-event]] on
the purchase side, in the same transaction.

**Copy on confirm.** Asset purchase fields stay authoritative. Values from a purchase reach an asset only
through an explicit, per-field confirmation — when receiving units from a line, and when linking existing
assets:

- a field that is **empty** on the asset and set on the purchase is a *fill*, **pre-checked**;
- a field that would **replace** a different value is **never pre-checked**; one "apply every purchase
  value" switch checks them all;
- cost and its currency always move together;
- **unlinking never clears values**, and editing a line price afterwards only *proposes* updates to linked
  assets (pre-checked only where the asset still holds the old purchase value).

A divergence between an asset's cost and its line is shown ("differs from purchase"); it is never
corrected silently.

### 3. Derived values: totals and received status

- **Totals are derived, never stored.** A line total is quantity × unit price; a purchase total is the
  sum of its lines, **per currency** (a purchase has one currency, so one total).
- **Status.** The user sets `DRAFT`, `ORDERED` (the default on create) or `CANCELLED`. **Partially
  received** and **Received** are **derived**: per countable line, received = live linked assets (and
  from Phase 1b, units moved in by consumable movements); a purchase is *Received* when every countable
  line is received or cancelled. There is no manual *Closed* and no receipt ledger.
- **Cancelling.** "Cancel remaining units" stores a cancelled quantity on the line (the reason goes in
  the event log). "Cancel purchase" is offered only while nothing is received.

### 4. Over-receipt is blocked, under a lock

Receiving or linking more units than a line's quantity (minus cancelled) is **rejected on write**. The
check runs **inside each unit's create transaction, under a row lock on the line** (`SELECT … FOR
UPDATE`), so two users receiving the same line at once cannot overshoot it. Generating assets from a line
reuses the bulk-receive loop of [[0089-bulk-receiving-and-checkout-acknowledgement]] — each unit its own
transaction with its own asset-tag counter commit — so the [[0063-configurable-asset-tag-scheme]]
invariant holds and partial success stays the correct outcome. The UI offers a one-click "raise the line
to *n*" that edits the line (logged) and continues.

### 5. Currency

- Each purchase carries a **user-chosen ISO 4217 currency code**, required on the purchase and shared by
  all its lines. The CEO, verbatim: "Si moneda configurable por usuario en cada ordne [sic] diria yo, sin
  cotizaciones, no es un ERP, pero si sirve para especificar una moneda" (the user picks the currency on
  each order; no exchange rates; it is not an ERP; the currency only states what the amounts are in).
- The asset's purchase cost gains an **optional currency code** (planned column on [[asset]]). Existing
  assets read as **"No currency"** — its own visible state, never defaulted to a "usual" currency.
  Copying cost from a purchase sets the currency with it.
- lazyit **never** fetches, stores or applies exchange rates, and **never sums or converts across
  currencies**. Any aggregate of money groups by currency, with a separate *No currency* group.
- [[application]]`.costPerSeat` is unchanged by this record: it stays currency-less.

### 6. Reference (the finance PO number)

Optional free text. When set, it is **unique per supplier among live purchases** — a partial unique index
`WHERE "deletedAt" IS NULL` in raw SQL, the [[0041-soft-delete-reuse-and-restore]] pattern, so a
soft-deleted purchase frees its number. **No auto-numbering in v1**; without a reference the purchase is
displayed as *Supplier · date*.

### 7. Optional: an instance switch, OFF by default

Purchases is an **instance switch, OFF by default**, on a singleton settings row (a missing row reads as
OFF, as with [[ai-settings]] and [[asset-tag-scheme]]), toggled with `settings:manage`. Every existing
instance upgrades with the switch OFF and sees no change.

- **OFF** hides the Purchases area and the purchase pickers. It **deletes nothing**, and assets keep
  showing their purchase read-only (provenance and purchase documents).
- No asset ever requires a purchase. The free purchase fields on the asset stay editable in every mode.
- **Smart entry applies with the switch ON or OFF**: every typed purchase field (supplier, manufacturer,
  company, reference, invoice number, currency, line description, spec values) suggests recent, most-used
  and closest-match values, with a near-duplicate hint that never auto-replaces what was typed
  ([[purchases/ux-proposal]] §4). The CEO asked for it verbatim: "seria comodo que se filtren tambien por
  el ultimo usado o el ultimo parecido … Sugerir digamos".

### 8. Permissions

A new permission domain, `purchaseOrder`, in the catalog-as-code ([[0046-roles-permissions-v2]],
[[authorization]]), covering purchases, their lines, their documents and suppliers:

| Permission | Seeded to | Notes |
| --- | --- | --- |
| `purchaseOrder:read` | ADMIN, MEMBER | **VIEWER denied by default** (joins `VIEWER_DENIED_READS`); grantable to VIEWER from the role matrix. |
| `purchaseOrder:write` | ADMIN, MEMBER | Create, edit, receive, link/unlink, cancel, upload documents. |
| `purchaseOrder:delete` | ADMIN | Soft delete. **Restore is ADMIN-only**, as for every other entity. |

All three are grantable to service accounts (fail-closed, [[0048-service-accounts]]). The seed-once
ledger delivers the defaults to existing instances on deploy, with no data migration. Permissions are per
role, not per person: granting read to VIEWER grants it to every viewer, and the Manual must say so.
Copied asset costs stay visible to anyone with `asset:read`, as today — hiding them would take away what
viewers already see.

### 9. Delete, cancel and clone

- Business cancellation is the `CANCELLED` status. **Soft delete** is ADMIN-only, **keeps every asset
  link**, and is restorable ([[0041-soft-delete-reuse-and-restore]]). Nothing is ever hard-deleted.
- A line can be removed only while nothing is linked to it.
- **Asset Clone must not copy `purchaseOrderLineId`**: a clone would otherwise count against the line.
  Where clone copies the cost it copies its currency with it.

### 10. Documents

[[attachment]] gains the parent type `PURCHASE_ORDER`, reusing the asset documents allowlist and size cap,
gated by `purchaseOrder:read` / `:write` ([[0082-attachments-storage]]). A purchase's documents are
**shared, not copied**: the same rows are listed read-only on every linked asset.

### 11. AI: extraction is a human-reviewed draft

- **Document extraction** is a **separate switch under AI settings, OFF by default**, with a disclosure of
  what is sent to the configured provider. It needs the AI assistant enabled and a provider/model that
  accepts files ([[0097-ai-assistant-mcp-and-headless-api]]).
- Extraction reads **a document already attached to the purchase** — there is no file upload in the chat.
  It is a structured-output call **with no tools**, and it **never saves anything**: it returns a draft
  (with the verbatim source text and page per field, blanks over guesses) that a human reviews and saves
  through the normal write path. A later document *proposes* changes field by field; it never overwrites.
- A supplier document is **untrusted content** (INV-AI-4): reading it marks the conversation, and
  **purchase changes are never auto-approved** in the chat. The UX proposal also excludes pages that
  create assets or change money from "Approve all" (D11); the Phase 3 design confirms it.

### 12. Prerequisite: back up the attachments volume

Purchase documents are financial evidence, and the attachments volume is outside every backup today
([[0082-attachments-storage]], [[backups]]). **The attachments backup ships before or alongside Phase 1.**
Until it does, the purchase's documents panel says plainly that files are not in the backup.

### 13. Phasing

| Phase | Scope |
| --- | --- |
| **0 — Decide and document** | This ADR, [[0100-money-as-64-bit-minor-units]], the amendments, the entity notes, the research vault (#1466). |
| **1 — Manual MVP** | Money widening; the switch; suppliers; purchases with `ASSET` and `OTHER` lines; shared documents; receive from a line (the "Receive stock" dialog in a purchase mode); link existing assets (single and bulk) with the confirmation diff; the asset's *Purchase* panel; the *Open* list with pending counts; cancel remaining / cancel purchase; the event log; `purchaseOrder:*`; locale-aware money input and CSV; smart entry; the Application "Vendor" label renamed **"Publisher"** (en) / **"Fabricante"** (es) — label only, no data change; assets CSV gains cost, currency, supplier, purchase and invoice numbers; Manual pages (en + es). |
| **1b — At the door** | *Pending units* tab; *Receive delivery* across lines; barcode scanning into serials; `CONSUMABLE` lines; a dashboard *Pending deliveries* tile; global search for purchases; supplier history with yearly totals per currency. |
| **2 — Extraction** | Fill a purchase from a document; propose changes from a later document; `LICENSE` lines; "create purchase from selected assets" and other back-linking helpers; merge suppliers. |
| **3 — AI chat** | Purchase tools, page context, the batched question form and the approval rules above. |

Every new API handler is decided in the AI toolsets in the phase that adds it (exposed, deferred or
excluded), so the tool-coverage test stays green.

### 14. Upgrade safety

- **Migrations are additive.** New tables; a nullable `purchaseOrderLineId` and a nullable currency on
  `assets`; new enum values appended at the tail. The money widening is a type change that keeps every
  value ([[0100-money-as-64-bit-minor-units]]).
- **No backfill and nothing overwritten.** Existing assets get `purchaseOrderLineId = NULL` ("no
  purchase") and currency `NULL` ("No currency"). No migration or background job creates suppliers or
  purchases, links assets, or moves or deletes custom `specs` keys. Back-linking is a manual, reviewable
  action.
- **Permissions** arrive through the seed-once ledger; **the switch** is a missing row that reads OFF.
- **Reads stay tolerant**: status and kind values a newer build adds must degrade gracefully on an older
  one.

## Consequences

- **Positive:**
  - Answers the top pains with a small surface: one invoice shared by 20 assets, asset → purchase →
    invoice in one click, "3 of 4 received", and the back-linking of an existing estate.
  - Nothing that reads asset purchase fields today has to change; an instance that never turns the
    switch on sees only the smart-entry upgrade.
  - Reuses existing machinery: bulk receive, attachments, the permission catalog, the actor CHECK
    pattern, the AI approval pipeline.
- **Negative / trade-offs:**
  - A purchase and its assets can drift apart (by design: copies, not live values). The drift is shown,
    never fixed silently.
  - No record of "goods arrived but not yet registered as assets" beyond the derived status.
  - Over-receipt checking moves into the shared asset-create path, under a lock, and must be tested for
    concurrency.
  - Viewers keep seeing asset cost while purchases are hidden from them; there is no field-level
    authorization.
  - Purchase documents raise the stakes of the attachments backup gap until §12 ships.
  - A supplier's PDF goes to the configured AI provider when extraction is on; the disclosure and the
    separate OFF-by-default switch are the mitigation.
- **Follow-ups:**
  - Phase 1 backend and frontend units under epic #1465, starting with [[0100-money-as-64-bit-minor-units]].
  - The attachments backup sidecar (§12).
  - **Open before Phase 1 — not decided here:**
    1. Whether a user **without** `purchaseOrder:read` sees a linked asset's purchase provenance
       (supplier, reference) and purchase documents on the asset page, or only the asset's own fields.
       This is an authorization question and needs a CEO call.
    2. Whether the API refuses purchase writes while the switch is OFF, or only the UI hides them.
    3. How amounts are displayed for currencies whose ISO 4217 minor unit is not two decimals (JPY, CLP,
       KWD). Storage keeps today's fixed hundredths ([[0100-money-as-64-bit-minor-units]]).
    4. Field-level constraints left to the Phase 1 design: supplier name and tax-ID uniqueness, how
       invoice numbers and a document-type label are stored, and whether status and kind are Prisma
       enums or zod-validated text.

## Related

[[purchases/_MOC]] · [[purchases/decisions]] · [[supplier]] · [[purchase-order]] ·
[[purchase-order-line]] · [[purchase-order-event]] · [[asset]] · [[attachment]] · [[application]] ·
[[authorization]] · [[0100-money-as-64-bit-minor-units]] · [[0089-bulk-receiving-and-checkout-acknowledgement]] ·
[[0088-application-license-seat-tracking]] · [[0034-consumables-design]] · [[0036-int4-bounded-integers]] ·
[[0082-attachments-storage]] · [[0004-asset-centric-design]] · [[0006-soft-delete-and-auditing]] ·
[[0032-soft-delete-middleware]] · [[0033-asset-history-event-model]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[vision]] · #1465 · #1466
