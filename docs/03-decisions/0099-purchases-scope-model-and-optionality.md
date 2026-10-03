---
title: "ADR-0099: Purchases — scope, model, and optionality"
tags: [adr, purchases, assets, suppliers, money, currency, permissions, ai-assistant, data-model]
status: accepted
created: 2026-10-01
updated: 2026-10-03
deciders: [Joaquín Minatel]
---

# ADR-0099: Purchases — scope, model, and optionality

## Status

**accepted** — 2026-10-01 (epic #1465, issue #1466). Approved by the CEO as one package:
"dale, aprobado el paquete con la ampliación de montos" (the package is approved, including the money
widening). **Phase 1 backend core built** (#1472, 2026-10-02): the four entities, the two asset columns,
the `purchaseOrder:*` permissions, the purchase and supplier endpoints, the activity log and smart-entry
suggestions. **Phase 1 screens built** (#1474, 2026-10-02): the Purchases area (list, detail, create
and edit, suppliers, activity log), the asset's currency label, the smart-entry sources and the
Application *Publisher* label. **Phase 1 backend flows built** (#1473, 2026-10-02): receiving from a line,
linking and unlinking assets with the apply-values diff, cancelling remaining units, purchase documents,
the asset's provenance read, the pending-units list and the gated CSV columns. **Their screens built**
(#1475, 2026-10-02): receiving from a line, linking with the diff, cancelling remaining units, the purchase's
documents, the *Pending units* tab and the asset's *Purchase* panel. **Phase 1b backend: consumable lines and
the document type label built** (#1476, 2026-10-02): `CONSUMABLE` lines received into stock through the
consumables ledger, the optional label on asset and purchase documents, and the asset list's purchase
filters. **Their screens built** (#1476, 2026-10-02): consumable lines and *Receive into stock*, document
type labels, linked assets per line with unlink, the link picker's *Not linked* filter and camera scanning
of serials. **Phase 2 backend built** (#1477, 2026-10-02): document extraction behind its own AI switch (a
reviewed draft, never saved), `LICENSE` lines applied to their application on confirmation, and creating a
purchase from selected assets. **Their screens built** (#1477 web, 2026-10-02): the *Document extraction*
switch in Settings → AI, the side-by-side review of a read document as proposed changes, *New purchase from a
document*, license lines with *Apply license*, and *Create purchase* from selected assets. **Phase 3 backend
built** (#1478, 2026-10-02): the purchase tools of the AI assistant — reads, reading an attached document as
untrusted data, and every purchase change as a card that is never auto-approved. **Its chat surfaces
built** (#1478 web, 2026-10-02): the purchase labels and sentences, purchase cards with money, lines and
linked assets, the "Approve all" exclusion and *Ask AI to fill* on a document. What the builds
settled is in
[[#Decisions while building (Phase 1 core, #1472)]], [[#Decisions while building (Phase 1 web, #1474)]],
[[#Decisions while building (Phase 1 flows, #1473)]],
[[#Decisions while building (Phase 1 flows web, #1475)]],
[[#Decisions while building (Phase 1b consumable lines and document labels, #1476)]],
[[#Decisions while building (Phase 1b web, #1476)]],
[[#Decisions while building (Phase 2, #1477)]], [[#Decisions while building (Phase 2 web, #1477)]],
[[#Decisions while building (Phase 3, #1478)]] and [[#Decisions while building (Phase 3 web, #1478)]].

**Amended 2026-10-01 and 2026-10-02** by four CEO decisions taken after acceptance, before anything was
built: purchase provenance follows `purchaseOrder:read`, there is **no instance switch**, currency is a
**free-text label**, and entry is **flexible over strict**. The body below already reads accordingly; the
questions, the CEO's words and what each decision replaced are in
[[#Decisions after acceptance]].

This record **reverses one sentence of [[0089-bulk-receiving-and-checkout-acknowledgement]]** (a
purchase-order entity as a non-goal) and lifts the supplier deferral of
[[0034-consumables-design]] and the PO-number deferral of [[0088-application-license-seat-tracking]].
Those records keep their other decisions and carry dated pointers here. The money-width change the
package includes is its own decision: [[0100-money-as-64-bit-minor-units]].

**Confirmed and amended 2026-10-02** (#1494): the CEO confirmed the provisional decisions taken while
building, and decided that a stock receipt's movement reason names the purchase reference — see
[[#CEO confirmations (2026-10-02)]].

**Amended 2026-10-03** (#1507): after testing the build locally, the CEO decided the purchases list opens
on every purchase, newest first, instead of on the purchases waiting for units — see
[[#After local testing (2026-10-03)]].

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

**Governing principle — entry is light and never in the way** (CEO decision D-D, 2026-10-02). Recording a
purchase must not be a chore, or operators will not do it. Every rule below follows from that: a purchase
asks only for what identifies it, a line only for a description; nothing is unique, so a likely
duplicate is a **non-blocking suggestion** ("is this the same supplier?"), never a refusal; labels are
free text that smart entry helps type, not closed lists; and robustness the user should not feel —
status and kind validated as text — stays internal.

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

Four new entities, all built in Phase 1 (#1472; details in the entity notes):

- **[[supplier]]** — who the team buys from and pays. Soft-deletable. A name (its only required field),
  an optional tax ID (the strongest near-duplicate hint), website, a sales contact, a **separate
  support/RMA contact**, notes. **Neither the name nor the tax ID is unique**: a likely duplicate is
  suggested while typing, and creating anyway stays possible. A supplier is **not** a manufacturer (who
  makes hardware, [[asset-model]]`.manufacturer`) and **not** a publisher (who makes software,
  [[application]]`.vendor`); those fields stay as they are.
- **[[purchase-order]]** — one purchase. Soft-deletable. **No single field is required**: a purchase can
  be saved once something identifies it — a supplier, a reference, or one line. Everything else is
  optional: supplier, reference (the finance PO number), a currency label (§5), order date, expected
  date, delivery location, company, invoice numbers (**one free-text field**, however many invoices it
  lists), invoice date, notes; and a user-set status.
- **[[purchase-order-line]]** — one line on a purchase. Soft-deletable. A **description is the only
  field the user must fill**; the quantity **defaults to 1** and the unit price is optional (blank =
  unknown). Also a `kind`, optional model mapping and warranty months, and a stored **cancelled
  quantity**.

**Status and kind are text, validated by zod.** The purchase `status` and the line `kind` are stored as
`TEXT` and validated against their allowed values by the shared zod schemas on write, not as Prisma
enums. That is internal robustness, invisible to the user: a value a newer build adds needs no enum
migration and reads tolerantly on an older build (§14).
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
  assets (pre-checked only where the asset still holds the old purchase value). *Not built — deferred
  (2026-10-02, #1489):* a price edit changes no linked asset and proposes nothing; the asset's *Purchase*
  panel marks the line price *Differs from purchase*, and an ordinary asset edit changes the cost
  ([[#Decisions while building (Phase 1 flows web, #1475)]]). The rule that nothing is ever overwritten
  silently holds either way.

A divergence between an asset's cost and its line is shown ("differs from purchase"); it is never
corrected silently.

### 3. Derived values: totals and received status

- **Totals are derived, never stored.** A line total is quantity × unit price (lines with no price add
  nothing and the total says so); a purchase total is the sum of its lines, in the purchase's currency
  label — one purchase, one label, so one total (§5).
- **Status.** The user sets `DRAFT`, `ORDERED` (the default on create) or `CANCELLED`. **Partially
  received** and **Received** are **derived**: per countable line, received = live linked assets (and
  from Phase 1b, units moved in by consumable movements); a line is received once received + cancelled
  reaches its quantity, and a purchase is *Received* when every countable line is. A line that received
  **more** than its quantity is shown as **over-received** (§4). There is no manual *Closed* and no
  receipt ledger.
- **Cancelling.** "Cancel remaining units" stores a cancelled quantity on the line (the reason goes in
  the event log). "Cancel purchase" is offered only while nothing is received.

### 4. Over-receipt is allowed, with a warning

Receiving or linking more units than a line's open quantity (quantity − cancelled − received) is
**allowed with a warning**, and the line is then shown as **over-received** ("5 of 4 received"). The
warning offers a one-click "raise the line to *n*" that edits the line (logged); continuing without it
is fine. This is the **CTO's application of the light-entry principle** (D-D, 2026-10-02), not a CEO
quote, **confirmed by the CEO on 2026-10-02** ([[#CEO confirmations (2026-10-02)]]); it replaces the
"blocked on write, under a lock" rule accepted on 2026-10-01 and matches what the research persona asked
for: "warn me, don't block me" ([[purchases/user-interview]]).

**The count stays right under concurrency** because it is derived, never stored: received = the count of
live assets linked to the line, read when it is shown. Two users receiving the same line at once both
succeed and the count reflects both — there is no counter to race and no lock to take. The warning is
computed before the write and is advisory, so a concurrent receive can still cross the quantity; the
over-received state then shows it.

Generating assets from a line reuses the bulk-receive loop of
[[0089-bulk-receiving-and-checkout-acknowledgement]] — each unit its own transaction with its own
asset-tag counter commit — so the [[0063-configurable-asset-tag-scheme]] invariant holds and partial
success stays the correct outcome.

### 5. Currency

- **Currency is an optional free-text label** the user types on a purchase ("ARS", "USD", "u$s",
  "pesos" — whatever the team writes), shared by all its lines. Smart entry suggests labels used
  before. The user does not pick from a list: there is **no ISO 4217 list and no currency semantics** —
  lazyit derives no symbol, no decimal places and no meaning from the label. It states what the user says
  the amounts are in, nothing more. The CEO, verbatim, on 2026-10-01: "Si moneda configurable por usuario
  en cada ordne [sic] diria yo, sin cotizaciones, no es un ERP, pero si sirve para especificar una
  moneda"; and on 2026-10-02 (D-C): "Las monedas son texto libre del usuario, no elige una moneda, no
  hacemos cotizaciones, guardamos valores nada mas. Depende como los cargue el usuario".
- **Amounts are stored and shown as entered.** Storage is ADR-0100's, unchanged: 64-bit integer minor
  units. Display uses the viewer's locale grouping and shows decimals only as the user entered them — a
  whole amount is never padded with ",00" ([[0100-money-as-64-bit-minor-units]] §5).
- The asset's purchase cost gains an **optional currency label** of the same kind (built as
  `Asset.purchaseCurrency`, #1472, on [[asset]]). Existing assets read as **"No currency"** — its own visible state, never defaulted to a
  "usual" currency. Copying cost from a purchase copies the label with it.
- lazyit **never** fetches, stores or applies exchange rates, and **never sums or converts across
  labels**. Any aggregate of money **groups by label**, compared trimmed and case-insensitively ("usd" and
  "USD " are one group), with a separate *No currency* group for blank labels.
- [[application]]`.costPerSeat` is unchanged by this record: it stays currency-less.

### 6. Reference (the finance PO number)

Optional free text, and **not unique** — no uniqueness constraint on the reference, as on the supplier's
name and tax ID (§2). A reference already used on a live purchase of the same supplier is surfaced as a
**non-blocking suggestion** while typing ("a purchase with this reference already exists — open it?");
saving anyway stays possible. **No auto-numbering in v1**; without a reference the purchase is displayed
as *Supplier · date*, and the Phase 1 design settles the fallback for a purchase identified only by a
line.

### 7. Optional at entry, always available — no instance switch

Purchases has **no instance on/off switch**. The area is always available, subject only to the
`purchaseOrder:*` permissions (§8); its optionality is **at data entry**. The CEO, verbatim (D-B,
2026-10-02): "Pero porque desactivado? para mi que funciones por defecto pero que a nivel de carga sea
opcional."

- **Nobody has to use it.** No asset ever requires a purchase, and the free purchase fields on the asset
  keep working exactly as today — editable whether or not a purchase is linked.
- An instance that never records a purchase sees an empty Purchases area (for roles holding
  `purchaseOrder:read`) and the smart-entry upgrade; nothing else changes.
- This replaces the "instance switch, OFF by default" of the package approved on 2026-10-01. The
  separate AI **Document extraction** switch (§11) **stays**: it governs sending financial documents to an
  external AI provider, not the Purchases feature.
- **Smart entry applies everywhere a purchase field is typed** — on purchases and on the asset's free
  purchase fields: supplier, manufacturer, company, reference, invoice numbers, currency label, line
  description, document type, spec values. Each suggests recent, most-used and closest-match values, with
  a near-duplicate hint that never auto-replaces what was typed ([[purchases/ux-proposal]] §4). It is also
  where likely duplicates surface — a similar supplier name, a known tax ID, a reference already used —
  as suggestions, never refusals (D-D). The CEO asked for it verbatim: "seria comodo que se filtren
  tambien por el ultimo usado o el ultimo parecido … Sugerir digamos".

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

**An asset's purchase provenance follows `purchaseOrder:read`** (D-A, 2026-10-01). The asset page's
*Purchase* panel — supplier, reference, dates and the purchase documents — is shown only to a principal
holding `purchaseOrder:read` and hidden otherwise. The API enforces it, not only the UI: provenance and
the shared purchase documents are not served on an asset to a principal without the permission. The
asset's **own** purchase fields (cost, currency, dates) stay visible under `asset:read`, as today —
hiding them would take away what viewers already see.

### 9. Delete, cancel and clone

- Business cancellation is the `CANCELLED` status. **Soft delete** is ADMIN-only, **keeps every asset
  link**, and is restorable ([[0041-soft-delete-reuse-and-restore]]). Nothing is ever hard-deleted.
- A line can be removed only while nothing is linked to it.
- **Asset Clone must not copy `purchaseOrderLineId`**: a clone would otherwise count against the line.
  Where clone copies the cost it copies its currency with it.

### 10. Documents

[[attachment]] gains the parent type `PURCHASE_ORDER`, reusing the asset documents allowlist and size cap,
gated by `purchaseOrder:read` / `:write` ([[0082-attachments-storage]]). A purchase's documents are
**shared, not copied**: the same rows are listed read-only on every linked asset, to principals holding
`purchaseOrder:read` (§8). A document may carry an **optional free-text type label** (quote, order,
invoice, delivery note — suggested by smart entry, never a closed or required list).

### 11. AI: extraction is a human-reviewed draft

- **Document extraction** is a **switch under AI settings, OFF by default**, with a disclosure of what is
  sent to the configured provider. It is the only switch Purchases involves (§7), and it governs sending
  financial documents to an external AI provider, not the Purchases feature. It needs the AI assistant
  enabled and a provider/model that accepts files ([[0097-ai-assistant-mcp-and-headless-api]]).
- Extraction reads **a document already attached to the purchase** — there is no file upload in the chat.
  It is a structured-output call **with no tools**, and it **never saves anything**: it returns a draft
  (with the verbatim source text and page per field, blanks over guesses) that a human reviews and saves
  through the normal write path. A later document *proposes* changes field by field; it never overwrites.
- A supplier document is **untrusted content** (INV-AI-4): reading it marks the conversation, and
  **purchase changes are never auto-approved** in the chat. The UX proposal also excludes pages that
  create assets or change money from "Approve all" (D11); the Phase 3 design confirms it — see
  [[#Decisions while building (Phase 3, #1478)]] for how each rule is enforced.

### 12. Prerequisite: back up the attachments volume

Purchase documents are financial evidence, and the attachments volume is outside every backup today
([[0082-attachments-storage]], [[backups]]). **The attachments backup ships before or alongside Phase 1.**
Until it does, the purchase's documents panel says plainly that files are not in the backup.

*Not delivered (2026-10-02, #1489):* the epic shipped without the attachments backup. #1467 is open and
deferred by the CEO; the purchase's documents panel warns that the files are not in the backup, and
[[backups]] item 7 carries the manual workaround.

### 13. Phasing

| Phase | Scope |
| --- | --- |
| **0 — Decide and document** | This ADR, [[0100-money-as-64-bit-minor-units]], the amendments, the entity notes, the research vault (#1466). |
| **1 — Manual MVP** | Money widening; suppliers; purchases with `ASSET` and `OTHER` lines; shared documents; receive from a line (the "Receive stock" dialog in a purchase mode); link existing assets (single and bulk) with the confirmation diff; the asset's *Purchase* panel; the *Open* list with pending counts; cancel remaining / cancel purchase; the event log; `purchaseOrder:*`; locale-aware money input and CSV; smart entry; the Application "Vendor" label renamed **"Publisher"** (en) / **"Fabricante"** (es) — label only, no data change; assets CSV gains cost, currency, supplier, purchase and invoice numbers; Manual pages (en + es). |
| **1b — At the door** | *Pending units* tab; *Receive delivery* across lines; barcode scanning into serials; `CONSUMABLE` lines; a dashboard *Pending deliveries* tile; global search for purchases; supplier history with yearly totals per currency. |
| **2 — Extraction** | Fill a purchase from a document; propose changes from a later document; `LICENSE` lines; "create purchase from selected assets" and other back-linking helpers; merge suppliers. |
| **3 — AI chat** | Purchase tools, page context, the batched question form and the approval rules above. |

Every new API handler is decided in the AI toolsets in the phase that adds it (exposed, deferred or
excluded), so the tool-coverage test stays green.

*As built (2026-10-02, #1489):* Phases 1, 1b, 2 and 3 shipped on the epic branch, except: *Receive delivery*
across lines, the dashboard *Pending deliveries* tile, global search for purchases and the supplier history
with yearly totals (1b); merging suppliers and the other back-linking helpers beyond "create purchase from
selected assets" (2). They are **not built**; they are tracked as #1495 (sub-issues #1496–#1503) — the full
list, with the UX proposal's items, is in [[purchases/_MOC#What was built]].

*Built since (2026-10-03, #1499):* **global search for purchases and suppliers**. Both are found in the ⌘K
palette (a purchase also by its line descriptions) only by a principal holding `purchaseOrder:read` — D-A
applies to search: the API never queries the two indexes for anyone else, so neither hits nor counts leak.
The design, the projections and the upgrade path are in [[0035-search-architecture]]'s 2026-10-03
amendment.

### 14. Upgrade safety

- **Migrations are additive.** New tables; a nullable `purchaseOrderLineId` and a nullable currency
  label (text) on `assets`; new enum values (asset-history event types, the attachment parent type)
  appended at the tail. Purchase status and line kind are text, not enums (§2). No uniqueness index is
  added. The money widening is a type change that keeps every value
  ([[0100-money-as-64-bit-minor-units]]).
- **No backfill and nothing overwritten.** Existing assets get `purchaseOrderLineId = NULL` ("no
  purchase") and currency `NULL` ("No currency"). No migration or background job creates suppliers or
  purchases, links assets, or moves or deletes custom `specs` keys. Back-linking is a manual, reviewable
  action.
- **Permissions** arrive through the seed-once ledger. There is no settings row to seed: with no switch,
  an upgraded instance shows a new, empty Purchases area to ADMIN and MEMBER (the roles seeded with
  `purchaseOrder:read`), and the asset page shows a *Purchase* panel only once an asset is linked. Every
  existing asset, cost and free purchase field reads and edits exactly as before.
- **Reads stay tolerant**: status and kind values a newer build adds are validated on write only and must
  degrade gracefully on an older one; free-text currency labels need no validation beyond length.

## Consequences

- **Positive:**
  - Answers the top pains with a small surface: one invoice shared by 20 assets, asset → purchase →
    invoice in one click, "3 of 4 received", and the back-linking of an existing estate.
  - Nothing that reads asset purchase fields today has to change; an instance that never records a
    purchase sees only an empty Purchases area and the smart-entry upgrade.
  - Entry stays light: few required fields, no uniqueness refusals, free-text labels.
  - Reuses existing machinery: bulk receive, attachments, the permission catalog, the actor CHECK
    pattern, the AI approval pipeline.
- **Negative / trade-offs:**
  - A purchase and its assets can drift apart (by design: copies, not live values). The drift is shown,
    never fixed silently.
  - No record of "goods arrived but not yet registered as assets" beyond the derived status.
  - A line can end up over-received; the warning is advisory, so the data can say "5 of 4". Concurrent
    receives must still be tested to show the derived count is right.
  - With no uniqueness constraints, duplicate suppliers and repeated references can exist. Suggestions
    reduce them; merging suppliers was meant to clean them up, but it is not built (§13).
  - Currency labels are not normalised beyond trimming and case: "USD" and "u$s" are two groups in any
    total. Smart-entry suggestions are the mitigation; lazyit never interprets a label.
  - With no switch, every upgraded instance gains a visible (empty) Purchases area for ADMIN and MEMBER.
  - Viewers keep seeing asset cost while purchases and an asset's purchase provenance are hidden from
    them; there is no field-level authorization.
  - Purchase documents raise the stakes of the attachments backup gap until §12 ships (#1467, deferred).
  - A supplier's PDF goes to the configured AI provider when extraction is on; the disclosure and the
    separate OFF-by-default switch are the mitigation.
- **Follow-ups:**
  - The attachments backup sidecar (§12, #1467 — deferred by the CEO).
  - The items §13 lists as not built (#1495).
  - The four questions left open at acceptance are settled below; none remains open before Phase 1.

## Decisions after acceptance

The package was accepted on 2026-10-01 with four questions open. The CEO settled them on 2026-10-01 and
2026-10-02, before anything was built, and the body above was amended directly. This section is the
trail: each question as it was asked, the CEO's words verbatim, and what the decision replaced.

### D-A — Purchase provenance follows `purchaseOrder:read` (2026-10-01)

**Asked:** does a principal without `purchaseOrder:read` (a Viewer, by default) see a linked asset's
purchase provenance and documents? **Recommended:** no — the asset's *Purchase* panel (supplier,
reference, dates, purchase documents) is shown only with `purchaseOrder:read` and hidden otherwise, while
the asset's own purchase fields (cost, currency, dates) stay visible under `asset:read` as today.

CEO, verbatim: "dale, seguí con tu recomendación." (go ahead, follow your recommendation).

**Applied in** §8 and §10.

### D-B — No instance switch (2026-10-02)

**Asked:** should the API refuse purchase writes while the instance switch is OFF, or only the UI hide
them?

CEO, verbatim: "Pero porque desactivado? para mi que funciones por defecto pero que a nivel de carga sea
opcional." (But why switched off? To me it should work by default, and be optional at data entry.)

**Decision:** the instance on/off switch is removed entirely. Purchases is always available, subject to
permissions; nobody has to use it, and the asset's free purchase fields keep working exactly as today.
**Replaces** the "instance switch, OFF by default" of the approved package (decision 8 in
[[purchases/decisions]]) and makes the original question moot. The AI *Document extraction* switch, OFF
by default, **stays**: it governs sending financial documents to an external AI provider. **Applied in**
§7, §11, §13 and §14.

### D-C — Currency is a free-text label (2026-10-02)

**Asked:** how should amounts be displayed for currencies whose minor unit is not two decimals?

CEO, verbatim: "Las monedas son texto libre del usuario, no elige una moneda, no hacemos cotizaciones,
guardamos valores nada mas. Depende como los cargue el usuario" (Currencies are the user's free text; the
user does not pick a currency; we do no exchange rates; we only store values. It depends on how the user
enters them.)

**Decision:** currency is an optional free-text label the user types, suggested by smart entry. No ISO
4217 list, no currency semantics, no exchange rates, no conversion. Amounts are stored as entered (64-bit
minor units, [[0100-money-as-64-bit-minor-units]], unchanged) and displayed as entered — locale
grouping, decimals only as the user entered them, no forced ",00" on whole amounts. Totals group by label
(trimmed, case-insensitive) and are never summed across labels. The asset's optional cost currency is the
same kind of label. **Replaces** the "user-chosen ISO 4217 code, required on the purchase" accepted on
2026-10-01. **Applied in** §2, §3, §5 and ADR-0100 §5.

### D-D — Flexibility over strictness (2026-10-02)

**Asked:** approve strict field rules for Phase 1 — supplier name unique, tax ID unique, and similar.

CEO, verbatim: "Yo lo haria bastane [sic] mas flexible la verdad, la idea de la features es que no sea
moleste y no sea denso cargar." (Honestly I would make it a lot more flexible; the idea of the feature is
that it is not a nuisance and not heavy to fill in.)

**Decision:** a governing principle — entry is light and never in the way — and, concretely:

- minimal required fields: a purchase needs only what makes it identifiable (a supplier, a reference, or
  one line); a line needs only a description, its quantity defaults to 1 and its price is optional;
- **no uniqueness constraints** on supplier name, tax ID or purchase reference; likely duplicates are
  non-blocking suggestions through smart entry ("is this the same supplier?");
- the tax ID is optional; invoice numbers are one free-text field; the document type is an optional
  free-text label;
- purchase status and line kind are stored as `TEXT` validated by zod — internal robustness, not a user
  burden.

**Replaces** the required supplier and currency, and the reference "unique per supplier among live
purchases" (decision 5 in [[purchases/decisions]]), accepted on 2026-10-01. **Applied in** the governing
principle, §2, §6, §7 and §10.

**The CTO's application of D-D** (a CTO decision under the CEO's principle, not a CEO quote): generating
or linking more assets than a line's quantity is **allowed with a warning** and shown as over-received,
replacing "blocked on write, under a lock" (§4). The per-line count is still computed correctly under
concurrency, because it is derived from linked assets and never stored.

## Decisions while building (Phase 1 core, #1472)

CTO decisions taken while building the backend core (2026-10-02), under the principles above. None
reopens a CEO decision.

- **The event type is `TEXT`, like status and kind** (under D-D). `PurchaseOrderEvent.eventType` is a
  plain text column; the writer emits only the shared `PURCHASE_ORDER_EVENT_TYPES` and readers take any
  string. A type a later unit appends (`UNITS_RECEIVED`, `ASSET_LINKED`, …) needs no enum migration and
  reads generically on an older build — the same robustness §2 gives status and kind.
- **Names as built.** The asset's currency label is `Asset.purchaseCurrency` (the design's working name
  was `purchaseCostCurrency`). A line also stores `manufacturerText` and `modelText` — brand and model as
  written on the document, before or instead of mapping to a model ([[purchases/technical-analysis]] §5);
  they feed smart entry.
- **"Identifiable" holds after creation.** A header update that clears the supplier and the reference of
  a purchase with no live line, and removing the last line of a purchase with neither, are refused (400).
  Both lock the purchase row first (`SELECT … FOR UPDATE`, the [[0098-consumable-delivery-targets]]
  pattern), so two concurrent removals, or a removal racing such an update, serialize and cannot together
  leave a purchase that identifies nothing.
- **Derived receipt, exactly.** Per countable line: pending = quantity − received − cancelled (≥ 0);
  `OVER` when received > quantity − cancelled; `RECEIVED` when nothing is pending (a fully cancelled line
  included); otherwise `NONE` or `PARTIAL`. A purchase is `RECEIVED` (or `OVER`) when nothing is pending
  on any countable line. The list's `receipt` filter derives with the same functions; `PENDING` means at
  least one pending unit on a purchase that is not `CANCELLED`.
- **Totals stay exact.** A line whose quantity × unit price exceeds `MONEY_MAX` is refused on write; a
  purchase total beyond it reads as `null` rather than an inexact number. Grouping by label is one shared
  function (`groupMoneyTotals`) so every later aggregate uses the same rule.
- **Smart-entry suggestions are one read, authorized per source.** `GET /suggestions/:field` (fields
  `supplierName`, `currency`, `company`, `manufacturer`, `lineModel`, `vendor`) returns
  `{ value, count, lastUsedAt }`, ranked by count then last use. A field may merge columns guarded by
  different permissions (currency on purchases and on assets; company on assets and purchases; manufacturer
  on models and purchase lines), so the service reads only the sources the caller may read and refuses the
  field when it may read none. Values are returned as stored and grouped by exact text — normalizing and
  near-duplicate hints are the web's job. Rejected: extending `GET /assets/companies` and each sibling
  endpoint (six contract changes, and the bare-string list the web already consumes would break). The
  route carries no single permission, so service accounts are refused it (fail-closed); suggestions are a
  typing aid for people.
- **The bare `purchaseOrderLineId` is served under `asset:read`.** The asset read carries the line id
  (read-only) to every caller who can read the asset, VIEWER included, without `purchaseOrder:read`. D-A
  hides *provenance* — supplier, reference, dates, price, documents — and an opaque cuid reveals none of
  it: following it to `/purchase-orders/**` needs `purchaseOrder:read`. What it does reveal is that the
  asset is linked to *some* purchase line, and that two assets share one. Keeping it on the asset avoids a
  per-caller asset shape (no field-level authorization exists, §8) and lets the web decide whether to
  offer the *Purchase* panel. If that fact itself must be hidden from viewers, the asset read has to drop
  the field for callers without `purchaseOrder:read` — a CEO call, flagged here; the D-A provenance read
  itself is gated in #1473. **Settled 2026-10-02:** the CEO kept the bare id as it is
  ([[#CEO confirmations (2026-10-02)]]).
- **Kind is fixed once units are linked.** Changing the kind of a line with live linked assets is a 409:
  the received units would silently stop counting.
- **Supplier FK `Restrict`, delivery location `SetNull`.** A supplier with purchases can never be
  hard-deleted (provenance), a location can (it is only a default for receiving). Soft deletes fire
  neither.
- **No AI tools yet.** Every new handler is listed as unexposed in `purchases.tools.ts` (Phase 3, #1478),
  and the suggestions read as not applicable.

## Decisions while building (Phase 1 web, #1474)

CTO decisions taken while building the screens (2026-10-02), under the principles above. None reopens a
CEO decision.

- **The title fallback (§6).** A purchase is called by its reference; without one, *Supplier · date*;
  without either — a purchase identified only by its lines — *Purchase · date*. The date is the order
  date, or the day it was recorded. Rejected: the first line's description, because the list read does
  not carry lines and the same purchase must read the same everywhere. Confirmed by the CEO on 2026-10-02,
  with the identifiability rule (a supplier, a reference or one line) ([[#CEO confirmations (2026-10-02)]]).
- **The supplier is typed, not picked.** The purchase form's supplier is a smart-entry text field over
  `GET /suggestions/supplierName`, resolved when saving: the exact trimmed name of one live supplier
  links it; a name nobody has creates the supplier inline, with no dialog; several suppliers with the
  same name ask the operator which one (names are not unique, D-D). Another spelling of an existing name
  gets the usual non-blocking hint. Rejected: an entity picker with a "create supplier" dialog — an extra
  step for the common case of a new or repeat supplier, against the light-entry principle.
- **The displayed status.** `DRAFT` and `CANCELLED` show as stored; an `ORDERED` purchase reads as
  *Partially received*, *Received* or *Over-received* (a warning tone) from its derived receipt. A
  status a newer build writes shows as its raw text. The status is changed from the purchase page
  (*Mark as draft / ordered*, *Cancel purchase* only while nothing is received), not from the edit form.
- **The list opens on every purchase, newest first** (*amended 2026-10-03 by a CEO decision, #1507*). The
  receipt filter (*Waiting for units* among its values) and the *Pending units* tab narrow it. The "optional
  feature" empty state shows when the unfiltered list is empty. *As built in #1474* the list opened on the
  purchases waiting for units (`receipt=PENDING`); that is superseded — see
  [[#After local testing (2026-10-03)]].
- **The currency label starts at the last one used** — the viewer's own (kept in the browser), else the
  instance's most recently used — on a new purchase only. The asset's currency label is never prefilled:
  an asset without one reads *No currency*.
- **Lines of a saved purchase** are added, edited and removed one at a time on the purchase page, through
  the line endpoints; the create form sends its lines inline.
- **Smart-entry sources.** The asset form and the *Receive stock* dialog read companies from
  `GET /suggestions/company`, the model forms read manufacturers from `GET /suggestions/manufacturer`,
  and the application form reads publishers from `GET /suggestions/vendor` — each value with its use
  count and last use ([[0076-asset-company-grouping-field]] amended).
- **The repeated-reference hint (§6) is built** from the list read: once the supplier resolves, the form
  asks `GET /purchase-orders?q=<reference>&supplierId=<id>` and offers an "open it" link when a purchase
  of that supplier carries the same reference (trimmed, case-insensitive). It never blocks the save.
- **Smart entry for the reference, the invoice numbers and the line description is deferred to #1475.**
  §7 lists them, but `GET /suggestions/:field` has no such fields yet; adding them is a contract change
  (a backend follow-up in #1475). Until then they are plain inputs. *The fields now exist (#1473:
  `reference`, `invoiceNumbers`, `lineDescription`); wiring them into the form stays #1475.*
- **One save at a time.** A purchase save can be two writes (the inline supplier, then the purchase), so a
  repeated Ctrl/⌘+Enter or a double click is held off by a ref-based lock, not only the disabled button.
  A save that succeeded keeps the lock (and the disabled button) until the page changes, so a submit in the
  moment before the navigation cannot create the purchase twice (#1508 review).

## Decisions while building (Phase 1 flows, #1473)

CTO decisions taken while building the backend flows (2026-10-02), under the principles above. None reopens
a CEO decision.

- **The apply mapping.** A link offers, per field: purchase date ← the invoice date, else the order date;
  cost ← the line's unit price **with** the purchase's currency label (one field, `purchaseCost`, so cost
  and currency always move together); warranty end ← that date + the line's warranty months; company ← the
  purchase's; model ← the line's. Receiving uses the same mapping except the purchase date: the invoice
  date, else **today** — never the order date ([[purchases/ux-proposal]] §3.d, the persona's rule). One pure
  function (`purchaseLineValues` in `@lazyit/shared`) computes it for the API and the web.
- **`apply` lists fields; `applyByAsset` overrides per asset.** A listed field is written where the diff is
  a *fill* or a *replace*; a field the purchase has no value for is never cleared, and an equal one is not
  rewritten. The batch list plus a per-asset override is what the dialog needs: fills pre-checked and
  replacements unchecked differ per asset in a bulk link, and the per-cell grid is the same request.
  Rejected: a mode per field (`fill` / `replace`) — it cannot express the per-cell choice.
- **A link is one transaction; a receive is one per unit.** Linking locks the asset rows (`SELECT … FOR
  UPDATE`), so two concurrent links of the same asset serialize and the second sees it linked; every
  history event and the purchase's single `ASSET_LINKED` commit with it. Receiving keeps ADR-0089's loop
  (each unit its own transaction and tag-counter commit, [[0063-configurable-asset-tag-scheme]] untouched),
  so its purchase event is ONE `UNITS_RECEIVED` appended after the loop, and each unit's own `CREATED`
  history carries `{ source: 'purchase', purchaseOrderId, purchaseOrderLineId }`. Rejected: an event per
  unit inside each transaction — twenty identical rows in the activity log for one delivery.
- **Lock order: purchase, then assets** (review of #1482). A link first takes `FOR KEY SHARE` on the
  purchase row, then locks the asset rows `FOR UPDATE` in id order. Removing a line, and changing a line's
  kind, take `FOR UPDATE` on the purchase, which conflicts with KEY SHARE: a link and a removal (or a kind
  change) serialize, so the removal's "nothing linked" check sees a link that committed first, and a link
  waiting on the removal then finds the line gone (404). KEY SHARE does not conflict with itself, so
  concurrent links — including cross moves between two purchases — never block each other on the purchase,
  and the id-ordered asset locks keep overlapping links from deadlocking. Rejected: `FOR UPDATE` on the
  purchase for a link — two cross moves would lock the two purchases in opposite orders and deadlock. A
  receive has the same window, but only until its first unit commits: it takes no purchase lock (each unit
  is its own transaction), so a line removed in that instant would still receive the units (a soft delete
  does not fire the FK). Once one unit exists, the removal's own check refuses. Accepted for a manual flow.
- **A generated unit is born linked.** It records the line on its `CREATED` event, not a separate
  `PURCHASE_LINKED`; `PURCHASE_LINKED` / `PURCHASE_UNLINKED` mark changes to an existing asset. A move
  (`move: true`) writes `PURCHASE_LINKED` with the line it came from, and `ASSET_UNLINKED` on the old
  purchase.
- **The partial-success reasons.** A link or unlink reports each refused asset with a reason —
  `NOT_FOUND` (missing or archived), `ALREADY_LINKED`, `LINKED_ELSEWHERE` (without `move`), `NOT_LINKED` —
  while the rest go through. An `OTHER` line or an archived purchase refuses the whole request (400 / 404).
- **Receiving against a line from the generic route.** `POST /assets/batch/receive` takes an optional
  `purchaseOrderLineId`, `purchaseCurrency` and `warrantyEnd`. The route stays `asset:write`; naming a line
  also requires `purchaseOrder:write`, checked in the service (403) because a decorator cannot depend on a
  body field. `POST /purchase-orders/:id/lines/:lineId/receive` requires both permissions up front and
  prefills everything; its body only overrides, and a line with no model is a 400 that says how to fix it.
- **Cancelled purchases.** The API accepts `status: CANCELLED` on a purchase with units received, and still
  lets a cancelled purchase receive and link: lazyit records what happened, and an order cancelled after a
  partial delivery is real. The web offers *Cancel purchase* only while nothing is received (§3) and warns
  otherwise. Rejected: a 409 — a refusal the operator can only work around by editing the receipt.
  Confirmed by the CEO on 2026-10-02 ([[#CEO confirmations (2026-10-02)]]).
- **Cancel remaining units** cancels the pending units by default, never more than are pending (400), and
  is a 409 on a line with nothing pending. The line row is locked so two cancels cannot take the same
  units. The reason is optional (D-D); the web may still ask for one.
- **Pending units exclude drafts.** The list holds countable lines with pending > 0 on live purchases that
  are neither `DRAFT` (not ordered yet, [[purchases/ux-proposal]] §3.f) nor `CANCELLED`, oldest order date
  first. The purchases list's `receipt=PENDING` filter keeps its #1472 meaning (drafts included).
- **Provenance and an archived purchase.** `GET /assets/:id/purchase` still answers for an asset whose
  purchase is archived — soft delete keeps the link (§9) — with `deletedAt` set, but lists its documents
  only while the purchase is live, as the purchase's own documents route does
  ([[0082-attachments-storage]]: the parent's 404 hides them).
- **The CSV columns.** Cost (major units, dot decimal, no grouping, no padding — [[0100-money-as-64-bit-minor-units]]
  §5) and its currency label are always exported: they are the asset's own fields under `asset:read`. The
  supplier, purchase reference and invoice numbers columns are **absent**, not blank, for a caller without
  `purchaseOrder:read`, so an empty cell always means "no value". New columns are appended at the end.
- **Suggestions for purchase text.** `GET /suggestions/:field` gains `reference`, `invoiceNumbers` and
  `lineDescription`, from live rows of live purchases, under `purchaseOrder:read` (§7).
- **Documents and the activity log.** Uploading or removing a purchase document appends `DOCUMENT_ADDED` /
  `DOCUMENT_REMOVED` in the same transaction as the attachment row. The optional document type label (§10)
  is **not built yet**: it needs a nullable column on `attachments` and a suggestion source — a backend
  follow-up outside #1473's scope. *Built in #1476 (below).*
- **AI tools.** Every new handler is unexposed for Phase 3 (#1478); binary upload and download stay
  file-tool exclusions. The asset AI tools gain `purchaseCurrency` next to `purchaseCost`.

## Decisions while building (Phase 1 flows web, #1475)

CTO decisions taken while building the flows' screens (2026-10-02), under the principles above — above all
D-D, "not a nuisance and not heavy to fill in". None reopens a CEO decision.

- **Receiving is the *Receive stock* dialog in a purchase mode** ([[purchases/ux-proposal]] §3.d), through
  `POST /purchase-orders/:id/lines/:lineId/receive`. The serials come first and the quantity follows them
  (the quantity field is read-only while serials are pasted, so a count mismatch cannot be sent); the
  prefilled values read as a summary with *Change*. Every value is sent explicitly, because each one is an
  override of the purchase's prefill: a field the operator cleared is `null`, never omitted — except the
  location, which is omitted while it is still the purchase's delivery location (the API applies the
  purchase's own value) and sent only when changed, `null` only when cleared. The purchase
  date is the invoice date, else the viewer's today. Plain *Receive stock* keeps its own route and its
  "serials must match the quantity" rule; the UX proposal's suggestion to make the quantity follow the
  serials there too is left for later.
- **A line without a model is not a dead end.** The dialog asks for the model inline (with the usual
  *+ New model*) and saves it **on the line** (a logged line update) before receiving. Rejected: the route's
  one-off `modelId` override — the line would stay unmapped and ask again at the next delivery.
- **"From purchase" switches the dialog, it does not decorate the plain receive.** Picking an open line (or
  the quiet "n units of this model are pending on …" suggestion under the chosen model) reads that purchase
  and puts the dialog in purchase mode. On **New asset** the same picker hands off to that dialog: an asset
  create carries no purchase line by design (linking is its own audited action), and a generated unit is
  born linked. Rejected: create, then link — two writes that can half-fail, recording `CREATED` plus
  `PURCHASE_LINKED` for a unit that was in fact received on the line.
- **The over-receipt fix is a button, not a choice to make.** Receiving or linking past the line shows the
  warning with *Raise the line to n* (n = received + cancelled + incoming), which edits the line at once;
  continuing without it is fine (§4). The UX proposal's three-way choice is reduced to that: "link only some"
  is unticking assets, "pick another line" is going back.
- **The link request from the choices.** `apply` lists the fields ticked on every asset that has something
  to apply for them; any asset whose own ticked set is not exactly that list gets its full list in
  `applyByAsset`, so what each asset receives is stated, never inferred; a field nobody ticked is in
  neither, so it is never touched. Fills start ticked, replacements never; *Apply every purchase value*
  ticks both; *Show each asset* opens the per-asset grid. Assets already on the line are left out; assets on
  another purchase need a per-asset *Move here*, and `move: true` is sent only when one is ticked; with a
  move, the comparison is re-read just before linking and the link stops if it changed meanwhile.
- **Bulk linking makes the Assets list selectable for linkers.** The row checkboxes appeared only with
  `asset:delete` (the lifecycle batch actions); they now also appear with `asset:write` +
  `purchaseOrder:write`, and the status / delete actions stay behind `asset:delete`. The selection is the
  current page — at most 200 rows, the link cap.
- **The asset's *Purchase* panel is provenance only.** It renders — and `GET /assets/:id/purchase` is
  requested — only with `purchaseOrder:read` and only for an asset that carries a line (D-A); an unlinked
  asset shows the panel only to someone who can link it. The asset's own cost and dates stay in *Details*
  under `asset:read` as before (not moved into the panel, no *Book value* relabel), so viewers lose nothing.
  *Differs from purchase* marks the line price when the asset's cost differs in amount or label (cost only,
  ux-proposal §2.3); there is no *Apply purchase value* button — the link route refuses an asset already on
  the line, and an ordinary asset edit remains the way to change the cost. An archived purchase reads as
  archived, without its documents.
- **Documents reuse the asset documents panel**, parameterised by parent, with a warning that the files are
  not in the backup until the attachments backup ships (§12, [[backups]] item 7). No document type label
  (not built, #1473). *The label is built in #1476 (below), with its screens (Phase 1b web, below).*
- **Pending units** is its own tab (`/purchases/pending`): open lines grouped by purchase, oldest order first,
  filtered by supplier, a purchase past its expected date marked *Overdue* (text, not colour alone). The
  proposal's *Overdue only* toggle is not built — the list has no such filter.
- **The purchase's activity log** now reads the flows' events (units received, linked, moved, cancelled with
  the reason; documents added and removed), still tolerant of a type it does not know.
- **Contract gaps, left to a backend follow-up.** (1) Nothing lists the assets linked to a line or purchase,
  so the purchase page has no linked-assets list and unlinking happens from the asset's *Purchase* panel only.
  (2) The provenance read carries no purchase `createdAt`, so a purchase with neither a reference nor an order
  date is titled on the asset with its line's creation date. (3) The asset list has no "not linked" or
  "created near the order date" filter, so the link picker filters by the line's model only; the preview still
  marks every asset that sits on another purchase. *All three are closed in #1476 (below): the asset list's
  `purchaseOrderLineId` / `purchaseOrderId` / `purchaseLinked` filters and the provenance `createdAt`; wiring
  them into the screens is done in Phase 1b web (below).*

## Decisions while building (Phase 1b consumable lines and document labels, #1476)

CTO decisions taken while building the backend of consumable lines and the document type label (2026-10-02),
under the principles above. None reopens a CEO decision.

- **One movement, through the consumables path.** `POST /purchase-orders/:id/lines/:lineId/receive-stock
  { quantity, note? }` posts ONE `IN` through `ConsumablesService.createMovement` — the guarded cache
  update, the int4 ceiling, the actor, the low-stock check and the search re-index stay the ledger's own
  ([[0034-consumables-design]]). The movement carries a new nullable `purchaseOrderLineId`, set at insert
  only; a DB CHECK allows it on an `IN` only, and the HTTP movement body can never set it (it is reachable
  only through an in-process `origin` argument). Rejected: a purchase-side write to `consumable_movements` —
  a second writer of the ledger, the exact thing ADR-0034 forbids.
- **The receipt and its event are one transaction, under the link lock.** The `origin` runs a check before
  the stock moves and a write after the row is inserted, both inside the movement's transaction: the purchase
  is locked `FOR KEY SHARE` (what a link takes) and the line re-read, then `STOCK_RECEIVED` is appended. A
  kind change or a line removal locks the purchase `FOR UPDATE`, so it serializes with a receipt and sees it;
  a line whose kind or consumable changed in between is a `409` with nothing written. Lock order is purchase,
  then the consumable row — nothing takes them the other way round.
- **`STOCK_RECEIVED`, not `UNITS_RECEIVED`.** A stock receipt has its own event type
  (`{ lineId, consumableId, movementId, quantity, overReceived }`). `UNITS_RECEIVED` carries asset ids and a
  per-unit failure count that a single movement does not have; a reader that knows one shape should never
  misread the other, and an older reader shows the new type generically (event types are TEXT, §2).
- **Received for a consumable line = the sum of its `IN` movements, and it never goes down.** Nothing
  subtracts: the ledger is append-only, and a mistaken receipt is corrected on the stock with an ordinary
  `OUT` or `ADJUSTMENT` that carries no line — the line keeps counting what was received, as a mistaken
  return stays on its delivery ([[0098-consumable-delivery-targets]]). Because a receipt, unlike an asset
  link, cannot be undone, a line that received stock can neither change kind nor be removed (`409`), the
  asset rule extended. Rejected: an `OUT` linked to the line that subtracts — a second receipt semantics
  (and a "return to supplier" flow) nobody asked for; it can be added later on the same column.
- **The movement's reason names the purchase reference** (*amended 2026-10-02 by a CEO decision, #1494*).
  The reason is *Received from purchase* and the reference (*Received from purchase OC-4512*) — the fixed
  *Received from a purchase* when the purchase has no reference — and the caller's note goes to `notes`.
  The consumable ledger is read under `consumable:read`, which a VIEWER holds, so **every consumable reader
  sees the reference**: a CEO-accepted exception to D-A for the reference only. The supplier, dates, prices
  and documents are never written into it. The reference is untrusted text, stored as written and rendered
  as text ([[0029-untrusted-content-sanitization]]); it is cut (with an ellipsis, never mid surrogate pair)
  to keep the reason within the movement's 500-character limit. The opaque `purchaseOrderLineId` is served on
  the movement under `consumable:read`, on the same terms as `Asset.purchaseOrderLineId` (#1472). *As built
  in #1476* the reason was the fixed *Received from a purchase* for every receipt, deviating from
  [[purchases/ux-proposal]] §7 ("posts an IN movement with the purchase as reason"); that is superseded — see
  [[#CEO confirmations (2026-10-02)]]. Movements already recorded keep the fixed reason (the ledger is
  append-only).
- **The consumable mapping is light.** `consumableId` is accepted on a `CONSUMABLE` line only and stays
  optional there; it is required when stock is received (a `400` that says how to fix the line), as an asset
  line's model is (#1473). An archived consumable is refused on write and on receipt (`400`). Changing a line
  away from `CONSUMABLE` clears it. Its consumable may still change after a receipt ("a different item
  came"): each movement keeps its own consumable, and the line counts every unit it received.
- **The quantity is required.** A stock receipt is the count that arrived, typed at the door; defaulting to
  every pending unit (as the asset receive does) would post stock nobody counted. The web may prefill it.
- **Purchase receipt counters add units across kinds.** A purchase's `ordered` / `received` / `pending` sum
  every countable line, whatever unit each consumable uses (units, boxes, metres); the state and the
  per-line counts are what the UI should lead with.
- **The document type label** (§10) is a nullable `attachments.label` (≤ 100 characters), set through the
  multipart `label` field on upload and edited with `PATCH …/attachments/:attachmentId { label | null }` (a
  blank label clears it, as on upload) on
  asset documents (`asset:write`) and purchase documents (`purchaseOrder:write`). The upload validates it
  inside the service, not a pipe, so a bad label still discards the staged file. Edits are human-only, like
  every attachment write; on a purchase a change appends `DOCUMENT_UPDATED { attachmentId, originalName,
  label: { from, to } }`, and `DOCUMENT_ADDED` / `DOCUMENT_REMOVED` carry the label. Article images take
  none. The text is untrusted ([[0029-untrusted-content-sanitization]]): stored verbatim, rendered as text.
- **`GET /suggestions/documentLabel`** merges two sources, each under the permission that already lists it:
  asset documents (`asset:read`) and purchase documents (`purchaseOrder:read`), live documents of live
  parents only. Raw SQL with a fixed pair of parent tables, because an attachment's parent is a soft
  reference with no relation to filter through ([[0082-attachments-storage]]).
- **Listing a purchase's assets is a filter on the asset list** (asked by the frontend flows unit, #1483).
  `GET /assets` gains `purchaseOrderLineId`, `purchaseOrderId` and `purchaseLinked` (`true` / `false`),
  AND-combined, list only. Any of them needs `purchaseOrder:read` on top of `asset:read` (`403`, checked in
  the service like the batch receive's line): the filter itself reveals provenance (D-A). In depth, the list
  query applies only filters minted by the authorizing method (a runtime brand), so the CSV export or any
  later caller cannot apply unauthorized ones. Rejected: `GET
  /purchase-orders/:id/assets` — a second paged asset projection to keep in step with the list's, its
  sort, its archived slice and its lean select. The provenance read gains the purchase's `createdAt`, the
  date of the title fallback (#1474).
- **Cancel remaining locks purchase, then line** (review of #1484). It now takes `FOR KEY SHARE` on the
  purchase before the line's `FOR UPDATE`. Before, it locked the line and only reached the purchase through
  the foreign key of its `UNITS_CANCELLED` insert — the reverse of a line removal or kind change (purchase
  `FOR UPDATE`, then the line), which could deadlock. Every purchase write now locks in the same order,
  purchase first.
- **Archived references refused on asset writes** (review of #1483). Creating, bulk-receiving (including a
  receive from a purchase line with an explicit location) or moving an asset to a soft-deleted location or
  model is a `400`: the row still passes the foreign key. Write-only, and only when the value changes, so an
  asset already in an archived location stays editable.
- **Upgrade.** Three nullable columns (`purchase_order_lines.consumableId`,
  `consumable_movements.purchaseOrderLineId`, `attachments.label`), two indexes, two foreign keys and one
  CHECK, all valid over populated tables because every existing row reads `NULL`. No past movement is
  attributed to a purchase and no stock moves.
- **AI tools.** `receiveStock` and the purchase document label edit are unexposed for Phase 3 (#1478); the
  asset document label edit joins the asset attachments as v1.1.

## Decisions while building (Phase 1b web, #1476)

CTO decisions taken while building the screens of consumable lines, document labels, linked assets and serial
scanning (2026-10-02), under the principles above — above all D-D, "not a nuisance and not heavy to fill in".
None reopens a CEO decision.

- **A consumable line is a third kind in the same line editor.** *Consumable* sits beside *Asset* and *Other*;
  the consumable it is received into is an optional picker (out-of-stock items offered — an empty shelf is why
  it is bought), shown only with `consumable:read`. Three kinds no longer fit beside the description, so the
  quantity and price take their own row, shared with the consumable picker. The purchase page names the line's
  consumable (linked) and counts it as "x of y received" like any countable line.
- **Receiving into stock is its own small dialog, not a mode of *Receive stock*.** That dialog creates assets;
  a stock receipt is one count and one note, posted as ONE movement — there is no partial success to show, so
  it closes with a toast. The quantity is prefilled with the units still pending (the API requires it; the web
  may prefill it), receiving more shows the usual warning with *Raise the line to n*, and a line with no
  consumable asks for one and saves it on the line first — the same rule as an asset line without a model.
  Gated by `purchaseOrder:write` + `consumable:write`, as the route. The note field says, under it, that the
  note is visible to anyone who can see the consumable's movements, Viewers included, and must not carry
  invoice or supplier details.
- **Consumable lines never reach an asset receive.** The *From purchase* picker of *Receive stock* and *New
  asset* lists `ASSET` lines only (and *New asset* shows its callout only when one is open); on *Pending units*
  a consumable line's *Receive* opens the stock dialog, and its menu has no *Link existing*. Because the
  pending-lines read cannot filter by kind, the picker reads it page after page to the end (bounded at ten
  pages of 200), so consumable lines can never push asset lines out of a single page.
- **The document type label is set before the upload or inline after it.** An optional *Type* field beside
  the upload hint applies to the files of the next upload and then clears, so a later upload never inherits it
  by mistake; a pencil on each row edits it in place, and emptying it clears it (`PATCH { label: null }`). Both
  use smart entry over `/suggestions/documentLabel` and one recent-values store. The typed type is consumed
  only when at least one file passes the client-side checks, so a refused drop keeps it; closing the editor
  returns focus to its pencil. The label shows as a badge
  (rendered as text, [[0029-untrusted-content-sanitization]]) on the asset and purchase documents and on the
  asset's *Purchase* panel. Rejected: a staging step per file before upload — a dialog for an optional field.
- **Linked assets are listed per line, on demand.** *Show assets* under a line's "x of y received" reads `GET
  /assets?purchaseOrderLineId=` — the first 50, oldest first — only when opened, so the purchase page loads no
  asset list by default. Per line rather than `purchaseOrderId=` because the lean list row carries no
  `purchaseOrderLineId`: a per-purchase list could not say which line to unlink an asset from. Each asset can
  be unlinked there (`unlink-assets`, `purchaseOrder:write` + `asset:write`), the line side of the asset
  panel's *Unlink*. A line with more than 50 assets says so; paging it is left for when a line that large
  appears.
- **Purchase filters on the asset list are built in one place.** `purchaseAssetFilter` returns nothing without
  `purchaseOrder:read`, so the web never sends a filter the API would refuse (D-A); the filters are serialized
  by the list read only, never by the CSV export.
- **The link picker starts on assets not linked to a purchase** (the UX proposal's chip), removable, beside the
  model chip; without `purchaseOrder:read` the chip does not exist. The proposal's *created within 90 days of
  the order date* chip is not built — the list has no such filter.
- **The asset panel titles the purchase by the purchase's `createdAt`**, closing #1475's fallback to the line's
  date; a read without it still falls back to the line's.
- **The activity log reads `STOCK_RECEIVED` and `DOCUMENT_UPDATED`** (set, changed, removed), and the label on
  `DOCUMENT_ADDED` / `DOCUMENT_REMOVED`; any other new type still reads generically.
- **Scanning serials reuses the `/assets/scan` camera.** Its `html5-qrcode` start/stop moved into one hook
  (`useCameraScanner`) shared by the asset lookup and a *Scan* action on the serials box of *Receive stock*, in
  both plain and purchase mode. The scanner opens inline under the box, not as a nested dialog — on a phone a
  second modal over the sheet is the heavier choice. It reads QR and the 1D/2D codes on hardware boxes (Code
  128/39/93, EAN, UPC, ITF, Data Matrix) in a wide box, continuously: each new code is appended on its own
  line with a tick and a vibration where available; a code held in front of the camera stays silent however
  long it stays (every sighting refreshes "last seen"), and is reported as a duplicate only after it was out
  of view for 2 s; a code already in the box is never added twice; a read longer than a serial is dropped.
  Focus moves to *Done* when the scanner opens and back to *Scan* when it closes. Stopping the camera never
  throws: `html5-qrcode`'s `stop()` throws synchronously when a start is pending or failed, so every stop
  goes through one guard (`stopQuietly`).
  Without a camera, permission or HTTPS it says so and the box is typed as before. **In plain mode the quantity
  follows the scanned serials** — only for scans; pasting keeps #1475's "serials must match the quantity" — so
  a scanned delivery never trips that rule. *Receive delivery* across lines (the scanner filling the focused
  line) is not part of this unit.
  *Fixed 2026-10-03 (#1506): a Mac's built-in webcam read neither a clear Code 128 serial here nor a QR label
  on `/assets/scan`.* `html5-qrcode` decodes a canvas the size of its scan box **in layout pixels**, so a
  viewfinder ~430 px wide was decoded at ~390 px from a 640×480 stream (no size was requested) — too few
  pixels per bar, and a fixed-focus laptop webcam can't make up for it by going closer. Now the camera is
  asked for HD (`ideal` 1920×1080), the viewfinder is laid out at 1280 px and only **scaled down for
  display** (`CameraViewfinder`; a portrait phone stream is capped at 60% of the screen and centred on the
  scan box; the QR box is capped at 640 px to bound main-thread work on phones), `disableFlip` drops the library's second decode of the same pixels on every missed frame, and
  both modes read one format list — QR, Data Matrix, Code 128/39/93, EAN-13/8, UPC-A/E, ITF — instead of
  the library's seventeen (the lookup keeps reading tag-sticker barcodes, which then search). The pure
  setup and feedback rules live in `lib/utils/camera-scan.ts`. Feedback: a *Scanning…* badge, a green
  check flash and a short vibration when a read is taken, and an `aria-live` tip (sharpness, light, or
  type it) after 6 s without seeing a code; no sound. `html5-qrcode` 2.3.8 is in maintenance mode, which
  is why the decode-size limit is worked around in layout rather than fixed in the library.
- **Consequences.** The per-line list is capped at 50 with no paging; the "next upload" type field is one more
  control in the Documents header (optional, cleared after each upload); the scanner depends on the device's
  camera and browser support, with typing as the fallback.

## Decisions while building (Phase 2, #1477)

CTO decisions taken while building the Phase 2 backend (2026-10-02), under the principles above and §11. None
reopens a CEO decision. Merging suppliers, the XLSX export and the other Phase 2 helpers in
[[purchases/ux-proposal]] §7 are not part of this unit.

**Document extraction** (§11; design in [[ai-assistant/provider-and-runtime]] §6.5, threat notes in
[[ai-assistant/security]] §6.12):

- **A sibling port, not a chat step.** `StructuredExtractionPort.extractStructured` is implemented by the same
  provider adapter as `ChatModelPort` (same connection read, provider definitions and egress-guarded fetch) but
  is its own interface: the agent loop never extracts, and an extraction is never a step of a conversation.
  The call is `generateText` + `Output.object` with the file inline and **no `tools` key** — no lazyit tool
  is declared (a provider may carry structured output in a synthetic JSON tool of its own, as Anthropic's
  `jsonTool` mode does; it has no executor); the SDK's URL download is refused and telemetry is off, as on a
  step. The port re-checks that the configured provider
  **and model** are the ones the capability was checked for. Rejected: a method on `ChatModelPort` — it would
  widen the chat contract (and every fake of it) for a call the chat never makes.
- **The model transcribes; lazyit reads.** The schema the model fills asks for literal text (amounts and
  quantities as printed) with the page; the server reads amounts into minor units in the document's own
  format, inferring its decimal separator from every amount it prints, and reads numeric dates in the
  document's day/month order. A literal that reads two ways with nothing to settle it (`1.150`, `10/03/2026`
  with no other date) is **blank** and flagged — blanks over guesses — and a value with no printed evidence is
  dropped — even when the model picked one reading of an ambiguous date. A trailing minus (`1.500,00-`) is a
  negative, not a label, so it does not read; the Spanish whole-amount mark (`$ 1.500.-`) is not a sign.
  Thousands grouped by spaces must be real groups of three. Cross-checks are warnings, never corrections:
  quantity × unit price against the printed line total, and — only when every line has both — the lines
  against the printed net or gross (with a line incomplete the gap is expected, and the reviewer already
  sees the blank). Rejected: trusting the model's numbers, which is where a 1,000× separator error would come
  from.
- **Gates.** `purchaseOrder:write` + `ai:use` (the AI channel gate, so revoking `ai:use` closes extraction
  too), **human-only** (a draft nobody reviews has no purpose; no headless flow sends documents out;
  confirmed by the CEO on 2026-10-02), then the
  capability: the assistant usable (enabled, configured, its key decrypting, not shim), the
  `documentExtractionEnabled` switch on, and a provider that reads the document's type. The refusals are
  typed (`code`): `409` unavailable (`AI_DISABLED`, `EXTRACTION_DISABLED`, `PROVIDER_UNSUPPORTED`), `422` the
  document, `429` `BUDGET_EXCEEDED` / `EXTRACTION_IN_PROGRESS` / `RATE_LIMITED`, `502` the provider or an
  unusable answer, `504` the deadline.
  `GET /purchase-orders/extraction/status` reports the same reasons per caller, plus `NOT_PERMITTED`, so the
  web can disable the action with its reason.
- **Which documents, per provider.** PDF, PNG, JPEG, WebP and GIF on Anthropic and OpenAI; the same but GIF on
  Gemini. The **OpenAI-compatible provider is never offered**: there is no common file API across those
  servers and most local models cannot read a PDF. Word, spreadsheets, text and CSV purchase documents are
  never sent. The file name is not sent (it is user-typed text). Size: ≤ 10 MB for any document, and less
  where the provider takes less for the type — Anthropic images ≤ 10 MB base64-encoded, so 7 864 320 bytes
  raw (`aiDocumentExtractionMaxBytes`). Every check is made before anything is sent, and the status read
  reports the effective cap per type (`maxBytesByMediaType`). Also ≤ 20 PDF pages (counted best-effort from
  the file's page objects) and a 120 s deadline.
- **Output cap and line ceiling agree.** The output is ≤ min(`maxOutputTokens`, 16 000) tokens. A transcribed
  line takes about 180 of them (evidence and pages included) and the header, totals and framing about 1 000,
  so the model is asked for at most `extractionLineLimit` lines — 80 at the 16 000 cap
  (`PURCHASE_EXTRACTION_MAX_LINES`), fewer under a lower admin cap, never under 10 — and to set `moreLines` when
  the document has more. The draft then says `LINES_TRUNCATED`, rather than a long invoice running out of
  tokens mid-answer and reading as nothing.
- **One budget.** The caller's `dailyTokenLimitPerPrincipal` is checked before the call, and the call's usage
  is an `ai_usage` row whose `runId` is the extraction id (`ext_…`) — extraction and chat spend the same
  rolling budget. An answer that does not fit the schema still counts its tokens.
- **Limiters of its own, the budget shared.** One extraction in flight per person (a second one is `429
  EXTRACTION_IN_PROGRESS`) and at most 5 started per person per minute (a token bucket, `429 RATE_LIMITED` with
  `retryAfterSec`; a refused document or a spent budget costs no attempt). Both are the extraction service's
  own, in memory per API process (one per install, the chat's posture), not `AiRunLimits`' chat buckets:
  starting a run and reading a document are different actions with different costs, and a shared bucket would
  let either starve the other. The persisted token budget is the one that is shared. Rejected: sharing the
  chat's run-creation bucket.
- **What is recorded.** Nothing on the purchase, its lines, suppliers or models — the draft is returned, never
  stored. The purchase gets `EXTRACTION_RUN` (who, which document, provider, model, token counts, outcome)
  whenever the document **may have reached the provider** — on success and on a failure after the request —
  and not when the call failed before any I/O (the configuration moved since the check: `AI_DISABLED`,
  `CONVERSATION_READ_ONLY`, or `PROVIDER_AUTH` with no HTTP status — answered as `409 AI_DISABLED`). One log
  line per run either way. Neither carries a value read from the document.
- **Suggestions only.** The supplier is matched by tax ID (digits and letters compared), else by a unique
  normalized name (case, accents, punctuation and legal suffixes such as "S.A." ignored); a line's model by
  the model an earlier line with the same description was mapped to, else by a unique brand + model text
  match. An ambiguous match is no match. Nothing is created or linked.
- **A later document proposes changes in the web.** The API returns the same draft for a document attached to
  a purchase that already has values; the field-by-field *proposed changes* table ([[purchases/ux-proposal]]
  §3.b) compares it with the purchase read on the client. Rejected: a server diff endpoint — the purchase and
  the draft are both already on the client, and the comparison writes nothing.

**`LICENSE` lines** (§2):

- **Received = applied seats.** A `LICENSE` line is countable; its received units are the seats a person
  applied from it, stored as `PurchaseOrderLine.appliedSeats` (raised only by the apply route, never computed
  from the application). `seatsPurchased` is one mutable number, not a ledger
  ([[0088-application-license-seat-tracking]]), so lazyit records what it added instead of inferring it.
  Applied seats only grow — a mistaken apply is corrected on the application — so, as with stock, a line with
  applied seats can neither change kind nor be removed (`409`). Its application may still change; the seats
  applied stay counted on the line. As a consequence, a `LICENSE` line with seats still to apply is listed by
  the *Pending units* read and counts in the purchase's receipt; the web offers *Apply license* there, never
  an asset or stock receive (its screens are the Phase 2 frontend unit).
- **Propose, then apply.** `GET …/license-proposal` (`purchaseOrder:read` + `application:read`) shows the
  application's current seats, `seatsUsed` and renewal date, the line's pending seats as the default to add,
  and the count afterwards; it writes nothing. `POST …/apply-license { seatsToAdd?, renewalDate? }`
  (`purchaseOrder:write` + `application:write`) applies what the person confirmed, through
  `ApplicationsService.update` — the application's own write path — inside the purchase write's transaction.
  The renewal date is never proposed: the term is not on the line, so the operator types it.
- **An untracked count** (`seatsPurchased` null = unlimited / not tracked) starts at the seats added, with
  the warning `SEATS_UNTRACKED`. **Over-application** is allowed and flagged (`OVER_APPLIED`; the line reads as
  over-received), as an over-received line is (§4).
- **Lock order: purchase, line, application.** The purchase `FOR KEY SHARE` (what a link takes, so a kind
  change or a line removal serializes with an apply), the line `FOR UPDATE` (two applies cannot read the same
  applied count), the application `FOR UPDATE` (the seat arithmetic reads the committed count). Nothing takes
  them the other way round.
- The event is `LICENSE_APPLIED { lineId, applicationId, seatsAdded, seatsPurchased: { from, to },
  renewalDate: { from, to }, appliedSeats: { from, to }, overApplied }`.

**Create a purchase from selected assets** (§13 Phase 2):

- `POST /purchase-orders/from-assets { assetIds, …header }` (`purchaseOrder:write` + `asset:write`) creates one
  purchase with one `ASSET` line per group: the assets of one model (mapped to it unless it is archived), or,
  without a model, of one name. The quantity is the group's assets; the unit price is their cost only when
  **every** asset of the group has the same one in the purchase's currency label, else unknown; an omitted
  currency takes the one label every priced asset shares. Rejected: an average or the first asset's cost — a
  guess presented as a price.
- **Only the link changes on an asset.** Each linkable asset gets `purchaseOrderLineId` and a
  `PURCHASE_LINKED` with nothing applied: values reach an asset only through an explicit apply (§2).
- **One transaction, purchase then assets.** The purchase row is inserted first, then the asset rows are
  locked `FOR UPDATE` in id order and re-read, as a link does. Partial success: `NOT_FOUND` (missing or
  archived) and `LINKED_ELSEWHERE` (already on a purchase line — moving it stays the link's explicit `move`)
  are reported; when none can be linked the request is a `409` and nothing is created. Events: `CREATED`,
  `CREATED_FROM_ASSETS { lineCount, linkedAssetIds, failed }`, then one `ASSET_LINKED` per line.

**Upgrade and AI tools:**

- **Upgrade.** One defaulted boolean (`ai_settings.documentExtractionEnabled`, `false`), one nullable column
  (`purchase_order_lines.applicationId`) with its index and `SET NULL` foreign key, and one defaulted integer
  (`purchase_order_lines.appliedSeats`, `0`). Extraction is **off on every upgraded instance**, so no document
  leaves the host until an admin turns it on; no line, application or seat count changes.
- **AI tools.** The new handlers are unexposed until Phase 3 (#1478): applying a license and creating from
  assets are purchase changes (never auto-approved, §11); extraction and its status are the web's reviewed
  flow, and the chat's `purchase_order_extract` tool is Phase 3. *Built in #1478 as `purchase_document_read`,
  with every handler decided — see [[#Decisions while building (Phase 3, #1478)]].*

## Decisions while building (Phase 2 web, #1477)

CTO decisions taken while building the Phase 2 screens (2026-10-02), under the principles above — above all
D-D, "not a nuisance and not heavy to fill in" — and §11. None reopens a CEO decision.

**Reading a document** ([[purchases/ux-proposal]] §3.b):

- **The review is a page, and the read runs only when asked.** `/purchases/:id/review/:attachmentId` shows the
  document beside the draft. The read is a mutation, never a query: each one sends the document out and
  spends the person's AI budget. *Read this document* on a purchase document, and *New purchase from a
  document*, land on the page with `?read=1`, which runs the read once — after the permissions, the document
  and `GET …/extraction/status` are known — and is dropped from the URL at once, so a reload shows an
  explicit *Read the document* button instead of sending the file again. The web never calls the extract
  route unless the status says `available` and the document's type and size are among those it reports.
  Rejected: a dialog on the purchase page — the side-by-side review needs the room, and *New purchase from
  a document* has to land somewhere.
- **One review for both cases: proposed changes.** The draft is compared with the purchase on the client
  (the Phase 2 backend decision): filling an empty field starts ticked, replacing never does, a value equal
  to the purchase's (and unflagged) is left out — decided once from the draft, so a row never vanishes
  while someone types in it. A new purchase is all fills, so *New purchase from a document* and *Propose
  changes* on a purchase with data are the same screen. A blank is never sent, so a review never clears a
  field. A document line with the same description (trimmed, case-insensitive) as a line of the purchase
  proposes changes to that line — quantity, unit price, warranty only, one purchase line per document line;
  every other line is a new line, ticked when it was named.
- **Blanks over guesses, in the form too.** A value not read stays blank and says *Not read*; a new line's
  quantity not read must be typed before the line is added (it is not defaulted to 1), while an unknown price
  stays unknown (§2). Each value shows the text read and its page on hover or focus — always when flagged —
  never a highlighted region. The API's warnings are written where they apply, counted in the header and
  jumped to; the totals check is recomputed from the lines as corrected, against the printed net, else the
  gross. **Deviations from the UX proposal:** saving is not blocked by a missing supplier or currency (D-D:
  nothing is required beyond what identifies the purchase), and there is no "n fields still marked check —
  save anyway?" confirmation (one step less; the counter stays visible).
- **The supplier and the models are suggestions.** The matched supplier is proposed by its own name, picked by
  id, with *Use {match}* and *Create "{name as read}"*; typing another name is *choose*. A new supplier is
  created on save by the purchase form's rule, with the tax ID read when it is the name read (and fits the
  50-character column; a longer one is left out, never cut). A line's model starts at the API's match; a match
  by name is flagged *check*.
- **New purchase from a document needs a holder purchase.** Extraction reads a document already attached to a
  purchase, and a purchase must be identifiable to exist (§2). Picking a file creates a **`DRAFT`** purchase
  whose **reference is the file name without its extension**, attaches the file and opens the review. While
  the purchase is still only that holder — no supplier, no line, the reference equal to the stand-in for the
  stored file name, **this its only document, attached within five minutes of the purchase being created**
  (review of #1487: the one request sequence that makes a holder, so a person's own purchase whose hand-typed
  reference happens to equal a file's name is never pre-ticked for replacement) — the review treats the
  reference as empty (the one read fills it, ticked, while the stand-in still shows as what it has *now*) and
  offers *Mark as ordered*, ticked. If renaming the stand-in to the stored file name fails after the upload,
  the person is told and the review still opens; the reference then reads as the purchase's own. An abandoned or failed read leaves a draft purchase holding the document, to be
  filled by hand (the UX proposal's "the document stays attached either way"); deleting it is an admin's
  archive, as for any purchase. Rejected: a placeholder line (data that is not on the document); creating
  the purchase after the review (there is no document to read before it).
- **Saving goes through the ordinary routes, in order:** the supplier (resolved or created), one header
  `PATCH`, each new line, each changed line. A failure stops there with what was written kept; those parts
  are then **locked** on screen and marked *Saved* (an edit there could no longer reach the purchase), and
  saving again writes only the rest. The toast counts the changes actually written; *Save* counts what is
  still to write, says *Fix the marked values to save* while a value cannot be sent, and is disabled with
  nothing to save.
- **Where the action is offered, and what it says when it is not.** *Read this document* appears per PDF or
  image document only while the status is available. Otherwise the documents panel says why **only to an
  admin** (`settings:manage`, who can change Settings → AI) and only for a reason Settings → AI can fix; for
  anyone else, and for `NOT_PERMITTED`, the action is simply absent. *New purchase from a document* is absent
  unless available.
- **The preview: images inline, PDFs in a new tab — never framed** (CTO decision, 2026-10-02; confirmed by
  the CEO the same day). The document
  is fetched with the Bearer token and re-typed to its stored, server-sniffed type before it gets a `blob:`
  URL, so the URL never holds markup. A raster image is shown inline beside the review (`img-src` already
  allows `blob:`). A PDF is a document card whose *Open in a new tab* opens the same `blob:` URL in the
  browser's own viewer, to put beside the review. The web Content-Security-Policy keeps **`frame-src 'none'`**
  and `object-src 'none'` ([[content-security-policy]]): lazyit still embeds nothing. Rejected: an `iframe`,
  `object` or `embed` of the PDF, which would need `frame-src blob:` — a wider policy for a convenience the
  new tab already gives.
- **The Settings card.** The switch is saved alone (`documentExtractionEnabled` in the `PUT`); every other card
  omits it, so another card's save never switches it. It is disabled with the reason while the assistant is
  off or the provider reads no documents, and stays usable while on, to turn it off. The disclosure is the
  shared reference text, localized.

**License lines and create from assets:**

- **What *Receive* means is decided in one place, per kind:** asset lines receive or link assets, consumable
  lines receive into stock, license lines *Apply license*, any other kind (`OTHER`, or one a newer build
  writes) offers nothing. *Pending units* used to treat every kind but `CONSUMABLE` as an asset line; a license
  line would have opened the asset receive.
- ***Apply license* reads the proposal first** and shows the seats now and after, the seats in use and the
  renewal date; the seats to add start at the line's pending seats and stay editable; the renewal date is
  typed, never prefilled; at least one of the two is sent. Over-application and an untracked count are
  warnings, not refusals. A line without a live application asks for one and saves it on the line first
  (the asset-model and consumable rule). Gated by `purchaseOrder:write` + `application:read` + `application:write`.
- **The line editor gains *License*** with an optional application picker (`application:read`). Four kinds no
  longer fit a fixed column beside the description, so that row wraps.
- ***Create purchase*** sits beside *Link to purchase* in the Assets list's selection bar, under the same gate
  (`asset:write` + `purchaseOrder:write`). The form asks only for the supplier, the reference and the currency
  label; a blank currency is left out so the API takes the label the assets share. Everything linked → the new
  purchase opens; assets left out are listed with their reason, the purchase one click away; a `409` says
  nothing was created.
- **The activity log reads `LICENSE_APPLIED`, `EXTRACTION_RUN` (provider and model, never a value read) and
  `CREATED_FROM_ASSETS`.**

**Consequences.** An abandoned *New purchase from a document* leaves a draft purchase named after the file
(confirmed by the CEO on 2026-10-02). The
review cannot be reloaded without reading the document again (the draft is never stored). A PDF is compared in
a second tab or window, not inside the review. Line matching by description misses a line the
document spells differently: it is offered as a new line, ticked, so the person unticks it to avoid a
duplicate.

## Decisions while building (Phase 3, #1478)

CTO decisions taken while building the backend of the AI purchase tools (2026-10-02), under §11 and the UX
proposal's chat flow ([[purchases/ux-proposal]] §3.c). None reopens a CEO decision. The tools are listed in
[[ai-assistant/tools-and-execution]] (*Purchases tools as built*).

- **"Never auto-approved" is two rules in core, not a promise of each tool** (purchase tools only; the CEO
  confirmed on 2026-10-02 that it is not extended to the asset tools). (1) Every purchase write tool is
  registered `neverAutoApprove`; core reads the flag from the registry when it decides an automatic approval,
  so neither the model, the stored row nor a later preview can lift it. (2) A preview that generates assets
  (`CREATES_ASSETS`) or sets or changes money (`CHANGES_MONEY`) is never auto-approved whatever the tool
  (`AI_NEVER_AUTO_APPROVE_WARNINGS`). Both answer `AUTO_APPROVE_NOT_ELIGIBLE`, and the user's own click on the
  card still approves without a password. Rejected: escalating the cards to `elevated` — it would hide them
  from read-write MCP tokens and put a "sensitive change" look on an ordinary purchase edit; a tool-side
  convention only — the next purchase tool would be one forgotten flag away from auto-approval.
- **"Excluded from Approve all" is the same two warnings, read by the web** (D11 confirmed). "Approve all" is
  a client action that sends one decision per card (ADR-0097 decision 3 as amended), so the server's part is
  the marker: the web leaves a page carrying `CREATES_ASSETS` or `CHANGES_MONEY` out of the bulk action and
  lists it as left out, exactly like a step-up page, while a batch that only creates a supplier or adds an
  unpriced line can still be approved at once. Which writes carry them: `CREATES_ASSETS` on receiving units as
  assets; `CHANGES_MONEY` on a create with a priced line, a unit price set or a quantity changed on a priced
  line, a priced line removed, the purchase's currency label changed, receiving units with a cost, and linking
  assets with `purchaseCost` in `apply` where it fills or replaces a value, and creating a purchase from assets
  when any selected asset has a cost (review of #1488: its lines take their unit price from those costs; the
  card lists the derived lines — model or name, quantity, and the unit price with its label when the group
  shares it). Applying a license (seats, not money), a stock receipt and cancelling units carry neither: they
  stay cards that are never auto-approved, but may be approved in bulk.
- **Reading a document is a chat-only `read` tool over the extract route.** `purchase_document_read` binds
  `POST …/attachments/:attachmentId/extract`, so every gate stays the route's: `purchaseOrder:write` + `ai:use`,
  the service's human-only check (a chat run is delegated as the user, so the service sees that person), the
  switch, the provider capability, the caps, the per-person limiters and the shared token budget. It is a
  `read` because it changes no purchase data — it appends `EXTRACTION_RUN` and a usage row, as the web flow
  does — and it is listed in the chat only, so no Service Account (headless) and no external client (MCP)
  can send a document out through it. Rejected: a `write` card before reading — the person already asked for
  that document in their own words, and the instance-wide consent is the admin's OFF-by-default switch.
- **The draft is one untrusted block, and the document marks the conversation.** The tool answers the draft
  (values, the verbatim header evidence and, per line, the printed text of a field left blank) as ONE
  `<untrusted_content>` block, next to lazyit's own warnings and matches, and names the document with an
  entity ref of the new type `purchaseDocument` (parent: the purchase). That type is a conversation-wide
  untrusted source (`AI_CONVERSATION_UNTRUSTED_SOURCE_TYPES`): the draft stays in the history replayed to the
  model on every later turn, so — as with web search (#1389) — every later turn starts with it, its proposals
  carry the "based on content written by others" banner, and nothing in that conversation is auto-approved
  again. The runtime finds it in the step records of every run; a step that read it and paused for nothing
  is re-recorded just before its tool message so the record exists. The draft can trigger nothing by itself:
  the extraction call has no tools, and every change the model proposes from it is a card.
- **The chat flow is in the tool descriptions, not the system prompt.** `purchase_document_read` tells the
  model to ask what is blank or ambiguous in ONE `request_input` form and to propose one `purchase_create` or
  `purchase_update`; `request_input` gains the `suppliers` and `consumables` option lists ("name (tax ID)",
  "name (SKU)") for the supplier and consumable questions. Rejected: a primer change — it bumps the prompt
  version, and the guidance belongs where the tool is.
- **Ids, not names.** Purchases, lines and suppliers are taken by id (none of their texts is unique, D-D),
  found with `purchase_search`, `purchase_get` and `supplier_search`; the page context names the purchase
  (`purchaseOrder` joins the AI entity types, with `supplier` for supplier refs), so "this purchase" on a
  purchase page needs no lookup.
- **Cards show what the route will do.** A receive card shows the route's own prefill (model, status,
  location, company, purchase date = the invoice date else today, warranty end, cost with its currency) and
  received before → after; a link card shows, per asset, the before → after of each applied field that fills
  or replaces; `apply` is required (`[]` links only). A card the route would refuse is not shown (a line that
  is not `ASSET` for a receive, a line without a model, removing a line with units received, nothing pending
  to cancel). A line card's precondition is the newer of the purchase's and the line's `updatedAt`, because a
  line edit does not bump the purchase: either edit makes the approval `STALE`.
- **Cards name records, not ids** (follow-up of #1488). Every id a card shows — a line's model, consumable or
  application, the delivery location, a model copied onto assets — is an entity value `{ type, id, label }`,
  labelled through the caller's own read of that record (each tool binds those reads, so each keeps its route
  permission). A read the caller may not make, or that fails, leaves `{ type, id }`: the card never carries
  a name its viewer could not read. The document read also takes the document id the user's message names.
- **Receiving weighs its units.** A Service Account's mutation cap counts changes (SEC-081): receiving counts
  its `quantity`, which the tool therefore requires (the route's "every pending unit" default would weigh an
  unknown number); linking counts its assets; a create counts the purchase and its lines; a create from assets
  the purchase and its assets.
- **On MCP and headless the writes follow the catalog's convention** (ADR-0097): the MCP client owns the
  confirmation and a Service Account acts within its grants, its AI access setting and its mutation cap. The
  never-auto-approved rule is the chat's, where a card exists to skip.
- **Unexposed, with reasons:** archive and restore of purchases and suppliers (ADMIN lifecycle actions, from the
  pages, as for consumables), unlinking assets (a correction, from the pages), the extraction status probe (the
  web's; the tool answers the same refusals), document upload and download (no file tools) and document label
  edit and delete (human-only routes).
- **Follow-up: the conversation-wide source read.** Every run reads all the step records of its conversation
  to find a `purchaseDocument` source (`conversationSources`) — one query, but it reads every step of a
  long conversation. Bounded by the conversation's size and retention today; a flag on the conversation row
  (or a dedicated record, as web search has) would make it one row read. Left for when a conversation that
  long appears.
- **Upgrade.** No migration and no stored data changes. The new entity types, warnings, option sources and
  sentence codes are additive; an older web renders an unknown warning generically and drops an unknown entity
  ref. Adding tools changes the frozen toolset of every principal who can see them (and `request_input`'s
  description changes it for everyone with the assistant), so chat conversations started before the upgrade
  become read-only (`VERSION_CHANGED`) and the user starts a new one — the usual cost of a catalog change
  ([[ai-assistant/provider-and-runtime]] §8).
- **Consequences.** A person who reads one supplier document in a conversation loses auto-approve for the rest
  of it, for unrelated writes too; starting a new conversation restores it. A long invoice's draft can reach the
  tool-result cap and be truncated for the model (the web review flow is unaffected). The chat cannot unlink,
  archive or restore — the pages can. The web must add the `purchaseOrder`, `supplier` and `purchaseDocument`
  entity labels, the two warning labels, the two option source labels, the purchase sentences and the
  "Approve all" exclusion before the chat shows these cards in the user's language (until then it shows the
  English and the generic warning).

## Decisions while building (Phase 3 web, #1478)

CTO-delegated decisions taken while building the chat side of the AI purchase tools (2026-10-02). None reopens a
CEO decision; the detail is in [[ai-assistant/frontend]] §11d.

- **"Excluded from Approve all" is a fourth reason, after step-up and sensitive.** A page carrying
  `CREATES_ASSETS` or `CHANGES_MONEY` is counted as "creates assets or changes money" among the pages to decide on
  their own, and the warning on the card says it is never approved automatically or with Approve all. The web
  reads the two codes from the shared `AI_NEVER_AUTO_APPROVE_WARNINGS`, the list core enforces; ADR-0097 decision 3
  carries the dated amendment. Rejected: folding them into "sensitive" — these cards are not elevated, and saying so
  would mislead.
- **Money is recognised by shape.** A preview value that is an object with `amount` and at most `currency` (so
  `{ amount }` alone is money without a label), the amount an integer, is money, formatted with the purchase's
  label in the user's locale; anything else renders as before. Rejected: a new
  `valueKind` — a contract change for what the shape already says.
- **A purchase line is a one-row table**, and a linked asset's values are a `before → after` list inside its row,
  so a priced line is readable before it is approved. Only the `line` field becomes a one-row table; other single
  objects keep their rendering, so no existing card changes.
- **"Ask AI to fill" only writes the message.** It opens the chat on the purchase page with a message naming the
  document; the person sends it. Sending a document to the provider stays the person's own act in their own
  words, as in the backend decision, and nothing is sent by a click. It sits on the document row, next to *Read
  this document* and shown under the same conditions plus the chat being usable — not on the header, which has no
  document to name. **It starts a new chat when the open one has messages** (the old one stays in the history) and
  reuses an empty one, so a document's turn — which ends auto-approve for its conversation — never lands in an
  unrelated chat (CTO decision in review). A draft in the box is kept, after the message. The message carries the
  document's id, which the read tool uses as given, and its file name, sanitized — control characters, line
  breaks and quote marks removed, at most 80 characters — because whoever uploaded the file chose it and the
  message reaches the model as the person's words.
- **Consequences.** Every *Ask AI to fill* from a chat in progress opens a new chat, so a person who wanted the
  document read inside the conversation they were having types the request there instead. A message not yet taken
  is dropped when the panel closes or the page changes. Line kinds and link states have their own copy in the
  chat's catalog, apart from the Purchases screens'.

## CEO confirmations (2026-10-02)

After the build, the CEO answered direct questions on the decisions the builds had taken provisionally
(#1494). Each answer is quoted verbatim; the recommended option is the one marked *(Recomendado)*. Every item
below is **confirmed** and binding as written in the section that records it; one item is a new decision
that amends Phase 1b.

### The stock receipt names the purchase reference (amends Phase 1b)

Asked whether a consumable stock receipt keeps the fixed reason *Received from a purchase* — no supplier, no
reference, because Viewers read the stock ledger — the CEO answered:

CEO, verbatim: "Incluir el número de orden" (include the order number).

A receipt's `IN` movement now reads *Received from purchase OC-4512*: the purchase's reference, cut to keep
the reason within the movement's 500-character limit, and the fixed *Received from a purchase* when the
purchase has no reference. The consumable ledger is read under `consumable:read`, which a VIEWER holds, so
**everyone who can see a consumable's movements sees the purchase reference**. This is an accepted,
CEO-decided **exception to D-A for the reference only**: the supplier, the dates, the prices, the invoice
numbers and the documents still follow `purchaseOrder:read`. The reference is untrusted text, stored as written
and rendered as text ([[0029-untrusted-content-sanitization]]). Movements recorded before the change keep the
fixed reason — the ledger is append-only. Recorded in
[[#Decisions while building (Phase 1b consumable lines and document labels, #1476)|Phase 1b]],
[[consumable-movement]], [[purchase-order-line]] and [[INVARIANTS]] INV-PO-1.

### The provisional decisions, confirmed

| Decision | CEO, verbatim | Recorded in |
| --- | --- | --- |
| Document extraction needs `purchaseOrder:write` + `ai:use` and is human-only | "Compras + uso de IA (Recomendado)" | [[#Decisions while building (Phase 2, #1477)\|Phase 2]] (*Gates*) |
| "Never auto-approved" and the "Approve all" exclusion stay purchase-only — not extended to the asset tools | "Solo Compras, como está (Recomendado)" | [[#Decisions while building (Phase 3, #1478)\|Phase 3]] · [[#Decisions while building (Phase 3 web, #1478)\|Phase 3 web]] |
| The bare `purchaseOrderLineId` stays visible under `asset:read` | "Dejarlo como está" | [[#Decisions while building (Phase 1 core, #1472)\|Phase 1 core]] · [[INVARIANTS]] INV-PO-1 |
| The *Inventory operator* preset carries `purchaseOrder:read` and `:write` | "Sí, ver y editar (Recomendado)" | [[authorization]] (role presets) |
| Over-receipt is allowed with a warning, never blocked | "Avisar sin bloquear (Recomendado)" | §4 |
| A cancelled purchase can still receive and link | "Sí, sin trabas (Recomendado)" | [[#Decisions while building (Phase 1 flows, #1473)\|Phase 1 flows]] (*Cancelled purchases*) |
| A purchase needs a supplier, a reference or one line, and is called *Purchase · date* without the first two | "Sí, como está (Recomendado)" | Governing principle (D-D) · [[#Decisions while building (Phase 1 web, #1474)\|Phase 1 web]] (*The title fallback*) |
| An abandoned *New purchase from a document* leaves its draft purchase | "Sí, que quede (Recomendado)" | [[#Decisions while building (Phase 2 web, #1477)\|Phase 2 web]] (*Consequences*) |
| Money displayed as entered (`costPerSeat` included), a third decimal refused on input, the "Read as" echo | "Sí, como está (Recomendado)" | [[0100-money-as-64-bit-minor-units\|ADR-0100]] §5 |
| Extraction providers and document types, its size, page and time limits, PDFs opened in a new tab | "Sí, como está (Recomendado)" | [[#Decisions while building (Phase 2, #1477)\|Phase 2]] · [[#Decisions while building (Phase 2 web, #1477)\|Phase 2 web]] |
| The Spanish register: the Manual's AI pages in *voseo*, the rest in *tú* | "Dejarlo como está" | [[ai-assistant/frontend]] |
| The items planned but not built | "Un unico issues y sub-issues de ese" (one issue, with sub-issues of it) | §13 — tracked as #1495 (sub-issues #1496–#1503) |

## After local testing (2026-10-03)

The CEO tested the whole build on a local instance and reported what did not work or did not read right
(#1505–#1508). One report changes a decision recorded above; another settles how two keyboard models meet.

### The purchases list opens on every purchase, newest first (amends Phase 1 web)

CEO, verbatim: "en esta pantalla mostraria por defecto TODO pero ordenado por lo que esperan unidades (o
mejor, por fecha de mas nuevo a mas viejo)" (on this screen I would show EVERYTHING by default, but sorted
by what is waiting for units — or better, by date from newest to oldest).

The list opens with no receipt filter, sorted by the day each purchase was recorded, newest first
(`sort=createdAt&dir=desc`, the order `GET /purchase-orders` already defaults to). The purchases still
waiting for units stay one step away: the receipt filter's *Waiting for units*, and the *Pending units* tab.
**Rejected: sorting by order date, falling back to the recorded date.** The API sorts by `orderDate` with
the database's default null placement — under `desc`, every purchase without an order date first — and has
no fallback to `createdAt`. The order date is optional (D-D) and often blank — a draft, a purchase made
from existing assets — so that order would open on the purchases with the least information. The fallback
would be a backend change (#1507 is web-only); it can be added later on the same allowlist. Ordering by
order date stays a column the operator can choose. Existing bookmarks with `?receipt=PENDING` keep opening
the filtered view.

### Ctrl/⌘+Enter saves from anywhere on the purchase form (#1508)

CEO, verbatim: "El cmd+enter no me funciono tampoco, no hace nada" (Cmd+Enter did not work for me either,
it does nothing).

The form heard the shortcut only from inside itself. Driven key by key in Chrome, ⌘+Enter and Ctrl+Enter
saved from every kind of field — plain inputs, money and date fields, the notes, smart-entry fields with
their list open, a combobox list — but with focus on nothing (after a click on blank space, or once the
focused control is gone, as with a removed line) the key reached the page and nothing else. The form keeps
listening for its own fields and the lists its comboboxes open, and the page now passes it a Ctrl/⌘+Enter
pressed with focus on nothing — but only when the last click was on the page the form is on (its `<main>`),
or there was no click yet. A click into the docked assistant's transcript also leaves focus on nothing, and a
Ctrl/⌘+Enter there is not a save. Focus in anything else (a dialog, the assistant, the search palette) is
left alone. **A smart-entry field keeps the text and lets the save follow**: with its list open, Ctrl/⌘+Enter
keeps the text as typed and the key travels on to the form. Rejected: making Ctrl/⌘+Enter only "keep as
typed" — a save shortcut that does nothing in half the form's fields. No other form uses the shortcut, so
smart entry elsewhere is unchanged.

## Related

[[purchases/_MOC]] · [[purchases/decisions]] · [[supplier]] · [[purchase-order]] ·
[[purchase-order-line]] · [[purchase-order-event]] · [[asset]] · [[attachment]] · [[application]] ·
[[authorization]] · [[0100-money-as-64-bit-minor-units]] · [[0089-bulk-receiving-and-checkout-acknowledgement]] ·
[[0088-application-license-seat-tracking]] · [[0034-consumables-design]] · [[0036-int4-bounded-integers]] ·
[[0082-attachments-storage]] · [[0004-asset-centric-design]] · [[0006-soft-delete-and-auditing]] ·
[[0032-soft-delete-middleware]] · [[0033-asset-history-event-model]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[vision]] · #1465 · #1466 · #1494 · #1495 · #1507 · #1508
