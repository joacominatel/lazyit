---
title: "ADR-0099: Purchases — scope, model, and optionality"
tags: [adr, purchases, assets, suppliers, money, currency, permissions, ai-assistant, data-model]
status: accepted
created: 2026-10-01
updated: 2026-10-02
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
documents, the *Pending units* tab and the asset's *Purchase* panel. What the builds settled is in
[[#Decisions while building (Phase 1 core, #1472)]], [[#Decisions while building (Phase 1 web, #1474)]],
[[#Decisions while building (Phase 1 flows, #1473)]] and
[[#Decisions while building (Phase 1 flows web, #1475)]].

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

Four new entities, all planned for Phase 1 (details in the entity notes):

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
  assets (pre-checked only where the asset still holds the old purchase value).

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
quote; it replaces the "blocked on write, under a lock" rule accepted on 2026-10-01 and matches what the
research persona asked for: "warn me, don't block me" ([[purchases/user-interview]]).

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
- The asset's purchase cost gains an **optional currency label** of the same kind (planned column on
  [[asset]]). Existing assets read as **"No currency"** — its own visible state, never defaulted to a
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
  create assets or change money from "Approve all" (D11); the Phase 3 design confirms it.

### 12. Prerequisite: back up the attachments volume

Purchase documents are financial evidence, and the attachments volume is outside every backup today
([[0082-attachments-storage]], [[backups]]). **The attachments backup ships before or alongside Phase 1.**
Until it does, the purchase's documents panel says plainly that files are not in the backup.

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
    reduce them; merging suppliers (Phase 2) cleans them up.
  - Currency labels are not normalised beyond trimming and case: "USD" and "u$s" are two groups in any
    total. Smart-entry suggestions are the mitigation; lazyit never interprets a label.
  - With no switch, every upgraded instance gains a visible (empty) Purchases area for ADMIN and MEMBER.
  - Viewers keep seeing asset cost while purchases and an asset's purchase provenance are hidden from
    them; there is no field-level authorization.
  - Purchase documents raise the stakes of the attachments backup gap until §12 ships.
  - A supplier's PDF goes to the configured AI provider when extraction is on; the disclosure and the
    separate OFF-by-default switch are the mitigation.
- **Follow-ups:**
  - Phase 1 backend and frontend units under epic #1465, starting with [[0100-money-as-64-bit-minor-units]].
  - The attachments backup sidecar (§12).
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
  itself is gated in #1473.
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
  not carry lines and the same purchase must read the same everywhere.
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
- **The list opens on purchases waiting for units** (`receipt=PENDING`). Because that view can be empty
  while purchases exist, the "optional feature" empty state is shown only when the area holds no purchase
  at all.
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
  follow-up outside #1473's scope.
- **AI tools.** Every new handler is unexposed for Phase 3 (#1478); binary upload and download stay
  file-tool exclusions. The asset AI tools gain `purchaseCurrency` next to `purchaseCost`.

## Decisions while building (Phase 1 flows web, #1475)

CTO decisions taken while building the flows' screens (2026-10-02), under the principles above — above all
D-D, "not a nuisance and not heavy to fill in". None reopens a CEO decision.

- **Receiving is the *Receive stock* dialog in a purchase mode** ([[purchases/ux-proposal]] §3.d), through
  `POST /purchase-orders/:id/lines/:lineId/receive`. The serials come first and the quantity follows them
  (the quantity field is read-only while serials are pasted, so a count mismatch cannot be sent); the
  prefilled values read as a summary with *Change*. Every value is sent explicitly, because each one is an
  override of the purchase's prefill: a field the operator cleared is `null`, never omitted. The purchase
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
  to apply for them; an asset that receives more gets its full list in `applyByAsset`; a field nobody ticked
  is in neither, so it is never touched. Fills start ticked, replacements never; *Apply every purchase value*
  ticks both; *Show each asset* opens the per-asset grid. Assets already on the line are left out; assets on
  another purchase need a per-asset *Move here*, and `move: true` is sent only when one is ticked.
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
  (not built, #1473).
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
  marks every asset that sits on another purchase.

## Related

[[purchases/_MOC]] · [[purchases/decisions]] · [[supplier]] · [[purchase-order]] ·
[[purchase-order-line]] · [[purchase-order-event]] · [[asset]] · [[attachment]] · [[application]] ·
[[authorization]] · [[0100-money-as-64-bit-minor-units]] · [[0089-bulk-receiving-and-checkout-acknowledgement]] ·
[[0088-application-license-seat-tracking]] · [[0034-consumables-design]] · [[0036-int4-bounded-integers]] ·
[[0082-attachments-storage]] · [[0004-asset-centric-design]] · [[0006-soft-delete-and-auditing]] ·
[[0032-soft-delete-middleware]] · [[0033-asset-history-event-model]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0046-roles-permissions-v2]] · [[0048-service-accounts]] · [[0097-ai-assistant-mcp-and-headless-api]] ·
[[vision]] · #1465 · #1466
