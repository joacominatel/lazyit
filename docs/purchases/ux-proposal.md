---
title: "Purchases — UX proposal"
tags: [purchases, research, ux, design]
status: draft
created: 2026-10-01
updated: 2026-10-02
---

# Purchases in lazyit: UX proposal

> [!warning] Pre-decision research — [[0099-purchases-scope-model-and-optionality|ADR-0099]] is authoritative
> The UX proposal written before the CEO's decisions of 2026-10-01. The CEO accepted its defaults with the
> package ([[purchases/decisions|the decisions note]]); where it differs from
> [[0099-purchases-scope-model-and-optionality|ADR-0099]] or [[0100-money-as-64-bit-minor-units|ADR-0100]],
> those win. Notable differences: D12 is resolved by widening money to 64-bit integers, so the
> "max 21.474.836,47" error in §3.a and D1's "amounts stay int4" no longer apply.
>
> **Also superseded by the decisions after acceptance (2026-10-01/02):**
> - **No instance switch** (D-B). Every mention of the Purchases on/off switch — §0, §2.1, §2.2 *Switch
>   OFF vs ON*, the *Instance settings → Purchases* card, §3.g *A legacy instance turns the feature on*,
>   §7's Phase 1 "Switch", D10 and Appendix A's switch row — no longer applies: Purchases is always
>   available and optional at entry. The *Document extraction* switch under AI settings stays.
> - **Provenance follows `purchaseOrder:read`** (D-A): the asset's *Purchase* panel and the shared
>   documents are shown only with that permission.
> - **Currency is a free-text label** (D-C), not a closed ISO 4217 list (§4.4's currency row): smart entry
>   suggests labels used before, and amounts show without forced decimals.
> - **Light entry** (D-D): supplier and currency are **not required** (§3.a), a purchase needs only what
>   identifies it; the reference is **not unique per supplier** (§8.1 item 5, D6) — a repeat is a
>   suggestion; and over-receipt is **allowed with a warning**, not blocked (§3.d, §8.1 item 6).
>
> **Built differently (2026-10-02, epic #1465).** Kept as written; what changed while building:
> - The chat tool that reads a document (§3.c) is `purchase_document_read`, not `purchase_order_extract`.
> - A stock receipt from a consumable line (§7) posts its `IN` movement with the fixed reason *Received from
>   a purchase*, never the purchase's details (the consumable ledger is readable by Viewers, D-A).
> - The extraction review (§3.b) does not block saving on a missing supplier or currency and has no
>   "n fields still marked check — save anyway?" step; a PDF opens in a new tab instead of being framed.
> - Not built: *Receive delivery* across lines, the *Overdue only* toggle and the *created within 90 days*
>   chip, the dashboard *Pending deliveries* tile, purchases in global search, merging suppliers, *Suggest
>   purchases*, *Map a custom field to suppliers*, the warranty replacement action, the XLSX export, and
>   proposing a new line price to linked assets.
>
> What each build settled: [[0099-purchases-scope-model-and-optionality|ADR-0099]], *Decisions while
> building*, and [[purchases/_MOC#What was built]].
>
> Entity design: [[supplier]] · [[purchase-order]] · [[purchase-order-line]] · [[purchase-order-event]].
> Back to [[purchases/_MOC|the Purchases vault]].


> Design proposal for an optional "Purchase Orders" capability. Inputs: [[purchases/decisions|CEO inputs]]
> (binding), [[purchases/user-interview]] (research), [[purchases/technical-analysis]] (system side). Grounded
> in the current web app (`apps/web/`), the Manual (`apps/web/content/manual/en/`), `DESIGN.md`
> ("The Ledger") and `PRODUCT.md`. Design only: no code, no repository edits.

## 0. The proposal in one page

- **Name it "Purchases", not "Purchase Orders".** lazyit keeps the IT side of a purchase. It does
  not issue orders. The finance PO number is a field on the record, shown first and searchable.
- **Purchases lives under Inventory** in the sidebar, next to Assets and Consumables. It has three
  tabs: *Purchases* (landing on **Open**), *Pending units* and *Suppliers*. An instance switch
  turns it on. When the switch is off, nothing in the product changes except the smart-entry
  upgrade on fields that already exist.
- **The PO path is the Receive path.** Receiving from a purchase line uses the **same dialog as
  today's "Receive stock"** (`receive-stock-dialog.tsx`), opened with everything prefilled and the
  serials box first. When the switch is on, "Receive stock" itself gains an optional *From
  purchase* field and suggests open lines for the chosen model. A tech who goes around the purchase
  still ends up linked.
- **Nothing is overwritten silently.** Values are copied onto assets only through an explicit
  per-field diff. Empty fields are pre-checked to fill. Fields that would replace a value start
  unchecked, and one switch applies them all.
- **Currency is chosen per purchase** (CEO input 2) and shown next to every amount. Totals are
  grouped per currency and never converted or added together. I recommend a **nullable currency on
  the asset's purchase cost** so that cost copied from a USD purchase does not become a bare number
  in a peso estate (CEO decision D1).
- **Smart entry everywhere** (CEO input 1): one suggestion pattern for every typed purchase field.
  It offers recent values, the closest match while typing, a searchable history and inline create
  with a near-duplicate guard that normalizes case, accents, punctuation and legal suffixes.
- **MVP** = suppliers + purchases + lines (asset and other) + shared documents + receive from line
  + link existing assets (single and bulk, with the diff) + the asset's Purchase panel + the Open
  view + a locale-correct CSV + smart entry. Extraction comes next, then the AI chat.

---

## 1. Principles

1. **Record the purchase, don't run purchasing.** The ERP stays the system of record, and the
   finance PO number is the record's name. No approvals, payment tracking, tax engine, exchange
   rates or vendor-facing output. Every field that does not help answer *"what did we buy, from
   whom, with which documents, and which units came out of it"* is left out or hidden behind
   *More details*.
2. **Never slower than today's Receive stock.** When a purchase exists, recording against it must
   take fewer keystrokes than going around it. Prefill everything, put the serials box first, and
   let quantity follow the serials. If the bypass is still used, catch it with a suggestion instead
   of a rule.
3. **Never silently overwrite, never silently skip.** Every copy of purchase values onto an asset
   goes through a visible diff. Every document-driven change is a proposal. Every AI write is a
   card. Empty-to-value fills are pre-checked; value-to-different-value replacements need a
   deliberate tick.
4. **Blanks over guesses, and money always carries its currency.** Extraction leaves unreadable
   values blank and shows the exact text it read (`"1.412.500,00"`), so separator mistakes are
   visible. Amounts are always printed with their currency code. Totals are grouped per currency.
   "No currency" is its own visible state and never defaults to the instance's usual one.
5. **Optional all the way down.** No asset ever requires a purchase. The free purchase fields on
   the asset stay editable in every mode. Turning the feature off hides the area and never erases
   a link or a document.
6. **Type once, pick forever.** A value typed once is offered the next time, ranked by closeness,
   use and recency. Consistency comes from good suggestions and a near-duplicate guard, not from
   validation that blocks the operator.

---

## 2. Information architecture

### 2.1 Navigation

```
Sidebar (switch ON, user holds purchaseOrder:read)

  Dashboard
  Inventory
    Assets
    Topology
    Consumables
    Purchases          <- new, ShoppingCartIcon (heroicons/24/outline), pillar "inventory"
  Access
    Applications
    Access requests
  ...
```

- **Placement:** add an item under the existing `inventory` section of `NAV` in
  `apps/web/components/sidebar-nav.tsx`. It is gated on `permission: "purchaseOrder:read"` **and**
  the instance switch, and fails closed while loading, as the existing items do. The mobile nav
  inherits it.
- **Routes:**
  - `/purchases` is the list, defaulting to the **Open** filter.
  - `/purchases/pending` is the line-level pending view.
  - `/purchases/suppliers` is the supplier list; `/purchases/suppliers/[id]` is a supplier page.
  - `/purchases/new` is the create form; `/purchases/[id]` is the purchase detail.
- **Tabs, not separate nav items:** *Purchases · Pending units · Suppliers*. Suppliers sit inside
  Purchases because they have contacts and history, not because they are a picklist. That answers
  persona question 6, and it keeps Settings → Taxonomies for classification only.
- **Settings:** an *Instance settings → Purchases* card holds the on/off switch. It reuses the
  card and switch pattern of the asset-tag scheme and SMTP editors
  (`apps/web/app/(app)/settings/instance/_components/*`). Document extraction gets its own switch
  in the *AI settings* view, OFF by default and with a disclosure (Phase 2).
- **Roles:** the role editor gets a *Purchases* capability toggle under the Inventory group
  (*View purchases*, *Edit purchases*). Delete and restore are ADMIN-only, as elsewhere.
- **Elsewhere, when ON:**
  - **Asset detail:** a *Purchase* panel (2.3).
  - **Assets list:**
    - a *Link to purchase* batch action in `BatchActionBar` (`components/resource-table.tsx`);
    - optional *Supplier* and *Purchase* columns and filters;
    - *From purchase* in the Receive stock dialog.
  - **Consumable detail:** a *Last purchased* line (Phase 1b).
  - **Application detail:** a *License purchases* list (Phase 2).
  - **Dashboard:** a *Pending deliveries* tile in *Needs attention* (Phase 1b).
  - **Global search:** purchases by number, invoice number or supplier (Phase 1b).

### 2.2 Switch OFF vs ON

| Surface | OFF (default, and every existing instance after upgrade) | ON |
| --- | --- | --- |
| Sidebar | Unchanged | *Purchases* under Inventory |
| Asset form | Same fields as today. **Smart entry** upgrades Company, cost hints and spec values. Currency next to cost, optional (if D1 is approved). | Plus a *Purchase* section with *Link to purchase line* and the same free fields |
| Asset detail | Unchanged layout | Purchase fields move into a *Purchase* panel with provenance |
| Receive stock | Unchanged except smart entry | Optional *From purchase* line picker plus the open-line suggestion |
| Assets list | Unchanged | Batch *Link to purchase*, optional columns and filters |
| Switch turned OFF after being ON | n/a | Area and pickers hidden. The asset's Purchase panel keeps showing **read-only provenance** ("Purchased from Compumundo, OC 0001-00004512") and the purchase **documents**. Turning off hides the area; it never hides the evidence. |

### 2.3 The asset's purchase section

The free fields stay where they are when the switch is OFF. When ON, the asset detail page groups
them into one `DetailPanel` titled **Purchase**, placed directly after *Details*. The fields are
purchase date, warranty end, cost, book value, useful life and salvage, which today sit inside
*Details* in `asset-detail-view.tsx`.

```
ON, asset linked to a purchase line
+-- Purchase ------------------------------------------------------------------------+
| From  OC 0001-00004512 · Compumundo · line 1 of 4                [Open purchase]   |
|       Lenovo ThinkPad E14 Gen 5 · 3 of 4 received                                  |
|                                                                                    |
| Purchase date   10/03/2026                 Warranty end   10/03/2029              |
| Purchase cost   ARS 1.380.000,00  [differs from purchase]   Book value (IT est.)   |
|                 Purchase says ARS 1.412.500,00 · [Apply purchase value]            |
| Useful life     36 months                  Salvage        ARS 0,00                |
|                                                                                    |
| Supplier support  Compumundo RMA · rma@compumundo.com.ar · +54 341 ...            |
| Documents from this purchase (4)                                                   |
|   [pdf] Factura A 0003-00012345.pdf   Invoice   10/03/2026      Download           |
|   [pdf] OC 0001-00004512.pdf          Order     03/03/2026      Download           |
|   + 2 more                                                                         |
|                                               [Unlink from purchase]  (edit perm)  |
+------------------------------------------------------------------------------------+

ON, asset not linked
+-- Purchase ------------------------------------------------------------------------+
| Purchase date   12/03/2025                 Warranty end   12/03/2027              |
| Purchase cost   1.150,00  (no currency)                                            |
| Not linked to a purchase.  [Link to purchase]                                      |
+------------------------------------------------------------------------------------+
```

- **Differs from purchase** appears only for **cost and its currency**, the one value that should
  normally match the purchase. Purchase date and warranty end legitimately differ per delivery, so
  they get no marker; flagging them would be noise (persona question 4). The marker is a neutral
  `StatusBadge` (secondary), with the purchase value in its description and a one-click *Apply
  purchase value* that goes through the same diff confirmation.
- **Book value** is relabelled *Book value (IT estimate)* when ON, following Laura's request. The
  `bookValueHint` tooltip already exists. This is a copy change only.
- **Purchase documents** are listed read-only on the asset. They are the same rows, not copies, and
  uploading and deleting happen on the purchase. The asset's own *Documents* panel
  (`asset-documents-panel.tsx`) is unchanged.
- **Supplier support contact** sits one click from the asset, because warranty and RMA was
  research pain #3.

---

## 3. Key flows

### 3.0 Purchases landing (what the user sees first)

```
Purchases                                                    [Export v]  [+ New purchase]
[ Purchases ]  Pending units   Suppliers
[ Search number, invoice or supplier...     ]  Open v   Supplier v   Filters
---------------------------------------------------------------------------------------------
 Number                 Supplier       Ordered            Status               Received  Total
 OC 0001-00004512       Compumundo     03/03/2026 · 28 d  Partially received   11 / 14   ARS 7.955.000,00
                                                                               1 pending
 OC 0001-00004533       Dell Partner   20/03/2026 · 11 d  Ordered               0 / 4    USD 4.600,00
 Mercado Libre · 22/03  Mercado Libre  22/03/2026         Draft                 0 / 1    ARS 18.500,00
---------------------------------------------------------------------------------------------
 Open = Draft, Ordered or Partially received. Oldest order first.
```

- **First thing visible:** open purchases with "x pending" and their age. That is what the persona
  checks weekly. There are no totals strip and no hero metrics (DESIGN.md "hollow hero-metric"
  ban).
- **Number column:** the finance reference when there is one. Otherwise *Supplier · date*, in muted
  type (see D6).
- **Total column:** always prints the currency code. The list never sums across rows.
- **Empty state:** an `EmptyState` with the inventory pillar chip. Copy: *"Record what you buy:
  supplier, order number, documents, and the units that came out of it."* Actions: **New
  purchase** · *Link assets you already have* (opens the Assets list with a hint about the batch
  action). In Phase 2 the empty state adds *Create purchases from existing assets*.

### 3.a Create a purchase manually, optimized for speed

One page with a compact header row, a spreadsheet-like line grid and a document drop zone. There
is no wizard.

```
New purchase                                                           [Cancel]  [Save purchase]
+-------------------------------------------------------------------------------------------------+
| Drop the quote, order or invoice here, or [browse]      (files are attached when you save)       |
|   [pdf] Factura A 0003-00012345.pdf  1.2 MB  x                                                  |
+-------------------------------------------------------------------------------------------------+
 Supplier *                 PO / order number            Order date      Currency *    Status
 [ Compumundo        v ]    [ OC 0001-0000|          ]   [ 03/03/2026 ]  [ ARS  v ]    (Draft)(Ordered)
                            last: OC 0001-00004498                       last used
 > More details: expected delivery, deliver to, company, invoice no. and date, notes
+-- Lines ----------------------------------------------------------------------------------------+
| Type     Description                          Model (optional)           Qty  Unit price   Warr. |
| [Asset]  [ NB LEN E14 G5 I5 16/512        ]  [ ThinkPad E14 Gen 5  v ]  [4]  [1.412.500,00] [36] |
| [Asset]  [ Monitor Dell P2422H            ]  [ Dell P2422H         v ]  [4]  [  310.000,00] [36] |
| [Other]  [ Flete                          ]   -                         [1]  [   25.000,00]  -   |
| [+ Add line]   Tip: paste rows from a spreadsheet or email to add several lines at once         |
|                                                     Total (net, ARS)            7.955.000,00   |
+-------------------------------------------------------------------------------------------------+
```

- **Required:** supplier and currency, and nothing else. A generic supplier ("Mercado Libre",
  "Online / other") is fine. Reference is optional (D6).
- **Status:** a two-option segmented control, *Draft · Ordered*, defaulting to **Ordered**. Most
  records are made after finance has already issued the OC. This keeps a single primary button
  (DESIGN.md "One Voice").
- **Smart entry on every field** (§4):
  - picking the supplier proposes the reference pattern ("OC 0001-0000|" with the caret at the
    end) and the supplier's last-used currency;
  - line descriptions suggest that supplier's previous lines, together with their model mapping.
- **Line grid keyboard:**
  - Tab moves across cells and Enter on the last cell adds a row.
  - Typing in an empty bottom row creates the row.
  - Pasting tab- or semicolon-separated text splits it into rows and maps columns by position:
    description, qty, unit price.
  - Cmd/Ctrl+Enter saves.
- **Line types in the MVP:** *Asset* and *Other* (shipping, services, freebies at price 0).
  *Consumable* arrives in Phase 1b and *License* in Phase 2. The type selector is a small
  segmented chip, so later types do not change the layout.
- **Model on an asset line is optional.** An unmapped line shows the description in muted text
  with *"Map to a model when you receive"*. The research is explicit: "I don't want to create a
  model just to save a draft."
- **Unit price:**
  - The label is *Unit price*, with help text: *"The price that should become each unit's cost,
    usually without VAT."*
  - There is **no net/gross toggle and no tax fields.** A toggle would only be honest with a tax
    engine. The help text keeps one clear convention, and the invoice's VAT total lives in the
    attached PDF.
  - Price 0 is valid and distinct from blank.
- **Number input:**
  - Follows the UI locale: `es` accepts `1.412.500,00`, `en` accepts `1,412,500.00`.
  - When a value is ambiguous (one separator followed by exactly three digits, e.g. `1.150`), the
    field echoes how it was read under the input: *"Read as 1.150,00"*.
  - Today `majorToMinor` in `lib/utils/money.ts` uses `Number()` and would reject a
    comma-decimal value. This is a required change, and it is a bug class the research names as
    its nightmare.
- **Totals:** the footer shows the derived line total, labelled with the purchase currency. It is
  never stored (analysis §5).
- **Documents:** files dropped before the first save are staged in the browser and uploaded right
  after the save, with per-file progress. A failed upload stays visible on the detail page with
  *Retry*.
- **Errors:**
  - Supplier missing gives an inline error on the field.
  - A duplicate reference for the same supplier gives an inline error with a link: *"OC
    0001-00004512 already exists for Compumundo. Open it?"*
  - An amount above the storage ceiling gives an inline error: *"Too large for one amount (max
    21.474.836,47)."* (see D12).

**Purchase detail (after save):**

```
Purchases > OC 0001-00004512
+---------------------------------------------------------------------------------------------+
| OC 0001-00004512                              Partially received   [Receive v]  [Edit]  [...] |
| Compumundo · ARS · Ordered 03/03/2026 · Deliver to Warehouse · Company Acme S.A.             |
| Invoices A 0003-00012345, A 0003-00012388 (10/03/2026)                                      |
| [##########################......]  11 of 14 units received · 1 pending · 2 cancelled        |
+---------------------------------------------------------------------------------------------+
Lines                                                                             [+ Add line]
 #  Item                                 Qty   Unit price       Line total      Received
 1  [A] Lenovo ThinkPad E14 Gen 5          4   1.412.500,00     5.650.000,00    3 of 4    [Receive 1] [...]
        "NB LEN E14 G5 I5 16/512" · 36 months · 1 received as E14 Gen 6
 2  [A] Dell P2422H                        4     310.000,00     1.240.000,00    4 of 4              [...]
 3  [A] Dell WD19S dock                    4     260.000,00     1.040.000,00    2 of 4 · 2 cancelled [...]
 4  [O] Flete                              1      25.000,00        25.000,00    -                    [...]
                                                           Total (net, ARS)    7.955.000,00
Documents · visible on all 11 linked assets                       [Upload]  or drop files here
 [pdf] Quote Q-8812.pdf            Quote     Diego  01/03/2026   Download  [...]
 [pdf] OC 0001-00004512.pdf        Order     Laura  03/03/2026   Download  [...]
 [pdf] Factura A 0003-12345.pdf    Invoice   Nico   10/03/2026   Download  [...]
 [img] Remito 0002-7781.jpg        Delivery  Nico   10/03/2026   Download  [...]
 Documents are stored on the server volume, which is not yet in the database backup.  (Manual)
Linked assets (11)                                  [Link existing]  [Open in Assets list]
 Tag      Name              Serial     Line  Owner     Status        Cost
 LZ-0410  ThinkPad E14      PF4A1X2    1     Ana R.    Operational   ARS 1.412.500,00
 LZ-0411  ThinkPad E14      PF4A1X7    1     -         In storage    ARS 1.380.000,00  differs
 ...
Activity
 10/03  Nico received 3 units on line 1 (LZ-0410 to LZ-0412)
 10/03  Nico uploaded Factura A 0003-12345.pdf
 09/03  Diego changed line 1 unit price 1.380.000,00 -> 1.412.500,00 (4 linked assets updated: 3)
```

- **Order on the page,** following persona Q&A §12: identity, status and progress; then lines with
  per-line progress; then documents; then linked assets; then activity.
- **Header actions:**
  - *Receive* is a split button. The main action receives the line with the oldest pending units;
    the menu lists the lines. In Phase 1b it adds *Receive delivery (several lines)*.
  - The `...` menu holds *Cancel remaining units*, *Cancel purchase*, *Export lines and assets
    (CSV)* and, for ADMIN only, *Delete*.
- **Line `...` menu:** *Edit line*, *Link existing assets*, *Cancel remaining (n)*, *Remove line*
  (only when nothing is linked).
- **Document type** (Quote · Order · Invoice · Delivery note · Other) is an optional label set at
  upload. It defaults to *Other* in the MVP. Extraction sets it in Phase 2.
- **Editing a line price when assets are linked:** after saving, a follow-up dialog appears: *"Update
  cost on linked assets?"* It lists each asset with its current to new value. Assets whose cost
  still equals the old purchase value are **pre-checked**; assets that were overridden are
  unchecked and marked *overridden*. The rule is "follow unless overridden", and nothing changes
  without the click (research §3, "Editing after the fact").
- **Cancel purchase** is only offered when no units are received. With received units the menu
  offers *Cancel remaining units* instead, so a partly delivered purchase can close cleanly.

**Status vocabulary (displayed):**

| Status | How it is set |
| --- | --- |
| Draft | Stored, set by the user |
| Ordered | Stored, set by the user (the default) |
| Partially received | Derived: at least one unit received and units still pending |
| Received | Derived: every asset (and later consumable) line is fully received or cancelled |
| Cancelled | Stored, set by the user, with a reason |

There is no separate *Closed*. "Received" plus *Cancel remaining* covers "I'm done with it", and
there is nothing to babysit (persona question 18; D4). *Other* lines never count toward pending.

### 3.b Upload a document, extract, review side by side, save (Phase 2)

**Entry points:**
- the drop zone on *New purchase*: after dropping a PDF or image, a button **Fill from this
  document** appears;
- *Upload* on an existing purchase: the new document's row offers **Propose changes from this
  document**.

Both are visible only when the *Document extraction* switch is ON and the configured model accepts
files. Otherwise the button is disabled with a reason: *"Document extraction is off. An admin can
turn it on in AI settings."*

**States:** *Reading the document… (page 1 of 2)* with a skeleton draft, then **Review**, then the
normal save. On failure: *"Couldn't read this document. Nothing was filled; enter the purchase by
hand."* The document stays attached either way.

```
Review: Factura A 0003-00012345.pdf                                   [Discard]  [Save purchase]
+-- Document (page 1 of 2) [<] [>] ------+ +-- Draft --------------------------------------------+
|                                        | | 3 to check    Totals: lines 5.650.000,00 vs          |
|                                        | |               document net 5.675.000,00  mismatch    |
|   (browser's native PDF / image view)  | |                                                      |
|                                        | | Supplier   Compumundo            matched by tax ID   |
|                                        | |            read "COMPUMUNDO S.A. CUIT 30-71234567-9" |
|                                        | | Document   Invoice  A 0003-00012345   read as shown  |
|                                        | | Date       10/03/2026            read "10/03/2026"   |
|                                        | | Currency   [ ARS v ]  check      read "$" (could be  |
|                                        | |                                   ARS or USD)        |
|                                        | | Lines                                                |
|                                        | | # Description      Qty Unit price     read           |
|                                        | | 1 NB LEN E14 G5    4   1.412.500,00   "1.412.500,00"  |
|                                        | |   Model [ ThinkPad E14 Gen 5 v ]  suggested, check   |
|                                        | | 2 Flete            1   [          ]   couldn't read  |
|                                        | |                                       p.2, line 7    |
|                                        | | [+ Add line]                                         |
+----------------------------------------+ +------------------------------------------------------+
 Nothing is saved until you select Save purchase. Fields marked "check" need your eyes.
```

**Trust cues:**
- **Show what was read, not a highlight box.** Each extracted field shows the **verbatim source
  text** next to the parsed value (`read "1.412.500,00"`), plus a page reference.
  - Extraction through a structured-output call does not give reliable coordinates, so a
    highlighted region would be a false promise.
  - The verbatim string is what catches a 1,000x separator error at a glance.
  - The extraction schema must ask for `sourceText` and `page` per field. This is a requirement
    for the backend lane.
- **Blanks over guesses.** A field the model could not read stays empty with *couldn't read*. It
  is never filled from a "best guess".
- **Three field states:**
  - *read* (neutral);
  - *check* (warning badge: ambiguous format, currency symbol `$` shared by ARS and USD, suggested
    rather than matched model, low confidence);
  - *couldn't read* (empty).
  The header counter "3 to check" jumps to the next flagged field on click.
- **Totals self-check:** the banner compares the sum of the draft lines against the document's
  printed net (and gross when present). It shows **match** or **mismatch: 25.000,00** and points
  at the likely culprit (a blank line). The totals are compared during review and never stored.
- **Supplier matching:**
  - tax ID first ("matched by tax ID"), then normalized name ("matched by name, check");
  - otherwise an inline choice: *Use existing [v]* or *Create "COMPUMUNDO S.A."*, prefilled with
    the read tax ID.
- **Model mapping** reuses line memory (§4.4): if the same description was mapped before, the
  mapping is *matched*; otherwise it is *suggested, check*.

**Save rules:**
- Save is blocked only by a missing supplier, missing currency, or a *couldn't read* quantity or
  price on an asset line. The user can fill the value or remove the line.
- Fields marked *check* do not block saving. The counter stays visible, and saving with open checks
  asks once: *"3 fields are still marked check. Save anyway?"*
- That is one confirmation per save, not one per field.

**Number and date formats:**
- Parsing follows the document's evident locale (`1.234.567,89`, `DD/MM/YYYY`, `10,5%`), not the
  UI locale.
- When the document locale is ambiguous, the field is flagged *check* rather than guessed.

**Updating an existing purchase from a later document** (the quote to invoice case): the review
pane becomes a **proposed changes** table.

```
Proposed changes from Factura A 0003-00012345.pdf                 [Discard]  [Apply 3 changes]
 [x] Invoice number      (empty)              -> A 0003-00012345          fill
 [x] Invoice date        (empty)              -> 10/03/2026               fill
 [ ] Line 1 unit price   USD 1.150,00         -> ARS 1.412.500,00         replace (currency differs)
 [x] Line 4 Flete        (new line)           -> 1 x ARS 25.000,00        add
     [ Select all replacements ]
```

- Fills and additions start checked; replacements start unchecked. This is the same rule as the
  link diff (§3.e).
- A replacement that changes currency carries a note: *"Changing a line's currency changes the
  whole purchase's currency."* A purchase has one currency (CEO input 2), so a currency change
  applies to the header and to every line, and the dialog says so.
- If an applied price change touches linked assets, the "Update cost on linked assets?" follow-up
  from §3.a appears.

### 3.c AI chat: "here's this PO" (Phase 3)

The chat takes no files (`_synthesis.md:670`, analysis D14). The document lives on the purchase,
and the chat works on it through page context.

**Entry:**
- On a purchase page with a document, the chat's page chip reads **About: Purchase OC
  0001-00004512**. This needs `purchaseOrder` added to `AiEntityTypeSchema`.
- The document row's `...` menu offers *Ask the assistant to fill from this*, which opens the chat
  with the chip and a prefilled prompt.
- If the user says "here's this PO" anywhere else, the assistant answers with one line and a button:
  *"Upload it to a purchase and I'll read it from there."* [New purchase].
- On mobile the same works with a phone photo uploaded to the purchase's documents.

**Sequence:**
1. The assistant runs `purchase_order_extract(attachmentId)`. The tool activity line reads
   *"Read Factura A 0003-00012345.pdf (untrusted content)"*. From then on the conversation is
   marked *based on content written by others* (existing yellow note).
2. It asks **one batched form** (`request_input`, rendered by `ai-input-card.tsx`) containing only
   what it could not infer.
3. It proposes the writes as **one paged approval card** (`ai-approval-pager.tsx`), one page per
   kind of change.

```
The assistant asks
Fill purchase OC 0001-00004512 from the invoice
Why: a few things on the invoice don't map to lazyit records yet.

 Supplier on the invoice: COMPUMUNDO S.A. (CUIT 30-71234567-9)
   [ Compumundo (existing)                       v ]   required
 Is "0003-00012345" the finance PO number or the invoice number?
   ( ) PO number   (o) Invoice number                    required
 Line models                                            one row per line
   Line                          Model
   NB LEN E14 G5 I5 16/512       [ Lenovo ThinkPad E14 Gen 5  v ]   (or "Create new")
   MON DELL P2422H               [ Dell P2422H                v ]
 Deliver to            [ Warehouse v ]  (purchase default)   optional
 Did anything arrive already?  [ ] Yes, receive units now     optional
                                                [Continue without]   [Send]
```

**Batched form rules** (persona question 13):

- Everything ambiguous goes into **one** form, never seven messages in a row:
  - supplier match;
  - PO vs invoice number;
  - model mapping per line (a repeat group);
  - consumable mapping (Phase 1b lines);
  - delivery location;
  - "anything arrived?".
- "Net or gross?" appears only if the document is unclear.
- Serials are asked in a **second** form, and only if "anything arrived" was ticked. That form has
  one repeat group per line, one serial per row, prefilled from a delivery note when one was read.
- Select options come from lazyit lists. `AI_INPUT_OPTION_SOURCES` needs `suppliers` and
  `consumables` added. "Create new" is an explicit option, never a default.

```
Proposed changes · 3 changes                                                 page 2 of 3   < >
+--------------------------------------------------------------------------------------------+
| Proposed change                                                       Pending              |
| Update purchase OC 0001-00004512 from the invoice                                          |
|                                                                                            |
|            ARS 7.955.000,00                     <- money in large type, with currency       |
|            4 lines · net                                                                   |
| Applies to  Purchase OC 0001-00004512 (Compumundo)                                         |
| Before -> after                                                                            |
|   Invoice number   (empty) -> A 0003-00012345                                              |
|   Line 1 price     USD 1.150,00 -> ARS 1.412.500,00                                         |
|   Currency         USD -> ARS                                                              |
| Before you approve                                                                         |
|   Based on content written by others: Factura A 0003-00012345.pdf                          |
|   Changes money on a purchase. Not included in "Approve all".                              |
|                                                            [Reject]   [Approve]            |
+--------------------------------------------------------------------------------------------+
 Pages: 1 Create model "Lenovo ThinkPad E14 Gen 6"   2 Update purchase   3 Receive 3 units (line 1)
```

**Approval rules** (persona questions 9 and 13):

- **Every purchase write is a card.** This covers creating or updating a purchase, creating a
  supplier, creating a model, receiving units, linking or unlinking, cancelling, and applying
  values to assets.
- **Auto-approve never covers purchase writes.** The untrusted-content marker would block it
  anyway after an extraction. Keeping one rule for every purchase write is simpler to explain than
  "drafts are fine". The research accepted "draft without asking" as the one exception; I recommend
  against it for clarity (D11).
- **"Approve all" excludes pages that create assets or change money.** These get a new marker
  alongside the existing "needs a closer look" exclusions, and the card lists them as left out,
  exactly like password-gated pages today. A batch that only creates a supplier and a model can
  still be approved all at once.
- **The receive page** uses the existing batch-of-new-assets table (`ai-preview-table.tsx`), with
  one row per unit showing serial, tag and cost with currency.

### 3.d Generate assets from a line: "Receive"

The goal is fewer keystrokes than today's *Receive stock*. Today's dialog needs model, quantity,
status, the shared details and the serials. From a line, the only thing to type is the **serials**.

```
Receive units                                                                         [x]
OC 0001-00004512 · Compumundo · Line 1: Lenovo ThinkPad E14 Gen 5 · 1 of 4 pending
+-----------------------------------------------------------------------------------------+
| Serial numbers, one per line                                              [Scan]        |
| +---------------------------------------------------+   Quantity  [ 1 ] of 1 pending    |
| | PF4A1X9|                                           |   follows the serials you paste  |
| |                                                    |                                  |
| +---------------------------------------------------+                                   |
|                                                                                         |
| From the purchase                                                         [Change]      |
|   Model          Lenovo ThinkPad E14 Gen 5                                              |
|   Status         In storage                                                             |
|   Location       Warehouse                 purchase "deliver to"                        |
|   Company        Acme S.A.                                                              |
|   Purchase date  10/03/2026  invoice date   [Today] [Order date 03/03]                  |
|   Cost per unit  ARS 1.412.500,00                                                       |
|   Warranty end   10/03/2029  36 months from purchase date                               |
|   Documents      4 purchase documents will show on each unit                            |
|   Asset tags     Automatic, starting at LZ-0421                                         |
+-----------------------------------------------------------------------------------------+
                                                            [Cancel]   [Receive 1 unit]
```

- **Same component:** this is `receive-stock-dialog.tsx` in a "from purchase line" mode, not a new
  dialog. It keeps the partial-success result view, the duplicate-serial reporting and the
  auto-tag hint (`auto-tag-hint.ts`). The Manual page for receiving stays one page with one new
  section.
- **Quantity follows the serials:**
  - Quantity defaults to all pending units.
  - Pasting or scanning serials sets quantity to the number of non-empty lines, up to the pending
    count.
  - Typing a quantity with an empty serials box still creates serial-less units.
  - This removes today's "mismatched count is rejected" friction in this mode. I recommend the same
    behaviour in plain Receive stock.
- **Prefill sources:**

  | Field | Source |
  | --- | --- |
  | model | the line |
  | status | the user's last choice in this dialog, falling back to *In storage* |
  | location | the purchase's delivery location |
  | company | the purchase |
  | purchase date | see rule below |
  | cost | the line's unit price, with currency |
  | warranty end | purchase date + line warranty months |
  | supplier, link, documents | implicit |

  *Change* expands every prefilled value into editable fields. Each override applies to this
  receive only.
- **Purchase date default** (persona question 3): the **invoice date** when the purchase has one,
  otherwise **today** (the delivery date). It can be changed per receive, with quick chips. The
  order date is offered as a chip but never defaults. This follows Laura's rule ("invoice date,
  that's what the auditor matches") and works at the door before the invoice exists.
- **Different model delivered** (persona question 1):
  - Changing the model in *Change* shows a **Note** field: *"Delivered as a different model, e.g.
    'Gen 6 sent, same price'"*.
  - The units are received **against the line**. The line is not split and not edited.
  - The line shows "1 received as E14 Gen 6". The note goes into the purchase activity and each
    asset's history.
- **Line without a model:** the Model field is empty and focused. It suggests matches for the line
  description, and *+ New model* opens the existing **New model** dialog
  (`create-asset-model-dialog.tsx`) with the name prefilled from the description, as Receive stock
  does today with the search term.
- **Over-receipt** (analysis D8 "block" vs research "warn, don't block"):
  - Quantity is capped at the pending count.
  - Exceeding it shows an inline message with a fix: *"Line 1 ordered 4 and has 3. [Raise the line
    to 5]"*. The fix edits the line, is logged, and continues.
  - The guard stays on the server, and over-delivery is still recorded honestly.
- **Result:** today's partial-success view, plus purchase-aware next steps:
  ```
  3 units received.  1 couldn't be created:
    #2  PF4A1X7  serial already used by LZ-0399 [Open]       [Retry #2 with a new serial]
  [Receive next line: Dell P2422H (4 pending)]   [Back to purchase]   [Open the 3 new assets]
  ```
- **Catching the bypass:** with the switch ON, plain *Receive stock* (Assets list) and *New asset*
  gain an optional **From purchase** line picker at the top. When the chosen model has open lines,
  a quiet suggestion appears:
  > 1 unit of this model is pending on OC 0001-00004512 (Compumundo). [Receive against it]

  One click switches the dialog into purchase mode with everything prefilled.
- **"None now, later"** needs no special UI: a line simply stays pending. "Receive all that
  arrived" across lines is the Phase 1b *Receive delivery* sheet (§6).

### 3.e Link existing assets: single and bulk, with the diff

**Three entry points, one dialog:**

1. **Purchase line → Link existing assets.**
   - Step 1 is an asset picker prefiltered to *this line's model · not linked to a purchase ·
     created within 90 days of the order date*. Each filter is a removable chip.
   - Checkboxes allow multi-select; the count is shown against pending ("selecting 2 of 1
     pending").
2. **Assets list → select → batch bar → Link to purchase.**
   - Filter, select (including "select all matching"), and choose *Link to purchase* in
     `BatchActionBar`.
   - Step 1 picks the purchase and line with smart entry. Lines whose model matches the selection
     rank first, then open purchases, then recent ones.
3. **Asset detail → Purchase panel → Link to purchase.** The same dialog with one asset.

**Step 2: the diff.**

```
Link 4 assets to a purchase                                                       Step 2 of 2
Purchase  OC 0001-00004512 · Compumundo · ARS       Line  1 · Lenovo ThinkPad E14 Gen 5
After linking: line 1 will have 4 of 4 received.

Apply values from the purchase?                          [ ] Apply every purchase value
 Field           From the purchase         Your 4 assets                          Apply
 Purchase cost   ARS 1.412.500,00          3 x USD 1.150,00  currency differs      [ ] replace 3
                                           1 x empty                               [x] fill 1
 Purchase date   10/03/2026 (invoice)      4 x 12/03/2026                          [ ] replace 4
 Warranty end    10/03/2029 (36 months)    2 x empty · 2 x 11/03/2027              [x] fill 2
                                                                                   [ ] replace 2
 Company         Acme S.A.                 4 x Acme S.A.                           same
 Supplier, purchase and documents          always linked, nothing to apply
 [Show each asset v]

 Result: 4 assets linked · 3 values filled · nothing replaced
                                                              [Back]   [Link 4 assets]
```

- **Group by field, not by asset.** Bulk linking 20 monitors should be a five-row decision, not a
  100-cell table. *Show each asset* expands into a per-asset grid with per-cell checkboxes for the
  rare mixed case.
- **Defaults:**
  - Fills (empty to purchase value) are **checked**.
  - Replacements are **unchecked**.
  - The single *Apply every purchase value* switch checks all of them. That is two clicks for the
    persona's usual "update from PO", and zero silent overwrites (feared friction #3).
- **Cost and currency move together.** Replacing cost also sets the currency, and the row says
  *currency differs* when it does. A USD-cost asset never ends up "ARS-labelled with a USD number".
- **The result line** restates exactly what will happen before the click ("3 values filled ·
  nothing replaced"). After the click it becomes a toast with *Open purchase*.
- **Over-quantity:** when linking would exceed the line quantity, the dialog shows a choice above
  the table:
  > Line 1 has 4 ordered and 2 already received. Linking 4 makes 6.
  > (o) Raise line 1 to 6   ( ) Link only 2 (choose which)   ( ) Pick another line
- **Unlink:**
  - From the asset Purchase panel or the purchase's linked-assets row menu.
  - The confirmation reads: *"Unlink LZ-0411 from OC 0001-00004512? Its purchase values stay as
    they are."*
  - Values are never cleared on unlink, and the action is logged on both sides.
- **Already linked elsewhere:** in step 1, such assets show *on OC …* and need an explicit *Move
  here*. They are never moved silently.

### 3.f Pending units

```
Purchases
 Purchases   [ Pending units ]   Suppliers
[ Search... ]  Supplier v   [ ] Overdue only
-------------------------------------------------------------------------------------------
 Compumundo · OC 0001-00004512 · ordered 03/03/2026 (28 d)                   1 unit pending
   Lenovo ThinkPad E14 Gen 5          3 of 4 received   1 pending             [Receive]  [...]
 Dell Partner · OC 0001-00004533 · ordered 20/03/2026 (11 d) · expected 25/03 overdue  4 pending
   Dell Latitude 5450                 0 of 4 received   4 pending             [Receive]  [...]
-------------------------------------------------------------------------------------------
 2 purchases · 5 units pending
```

- **Line level, grouped by purchase, oldest first.** This is the weekly view and the door view on
  a phone.
- **Excludes** drafts, cancelled purchases, *Other* lines and lines whose remainder is cancelled.
- **Row actions:** **Receive** (§3.d), and in the `...` menu *Link existing* and *Cancel
  remaining*.
- **Cancel remaining:**
  - The dialog asks for a quantity, defaulting to all pending, and a required short reason ("4th
    never came").
  - The line then shows "3 received · 1 cancelled · 0 pending" and leaves the view. If it was the
    last pending line, the purchase becomes *Received*.
- **Overdue** only appears when an expected date was set. It uses the `--warning` status chip, with
  text alongside the color.
- **MVP fallback:** if Phase 1 must shrink, the *Open* list with its "x pending" column (§3.0)
  covers this view, and the tab arrives in 1b.
- **Later:**
  - the dashboard *Pending deliveries: 3 purchases, 7 units* tile, next to the warranty tile in
    *Needs attention*;
  - an optional weekly digest line ("OC 4512 has had 1 unit pending for 14 days").
  There is no bell notification per event, matching the research.

### 3.g A legacy instance turns the feature on

1. **The admin flips the switch.** *Settings → Instance → Purchases*:
   > **Purchases** · Off
   > Record what you buy, link the units that came out of it, and keep invoices in one place.
   > Turning this on changes nothing on existing assets: their purchase fields stay as they are,
   > and nothing is linked automatically. You can turn it off later; records and links are kept.
   > [Turn on]
2. **First visit.** The Purchases empty state (§3.0). The Assets list shows a one-time dismissible
   callout (`components/callout.tsx`): *"New: link assets to purchases. Select assets and choose
   Link to purchase."*
3. **Existing assets look exactly as before.** Their cost shows *(no currency)* only if D1 is
   approved. The Purchase panel offers *Link to purchase*.
4. **Back-linking recent buys** (the persona accepts "the last 6 months, an afternoon").
   - Phase 1 path, by hand: create the purchase, then on the Assets list filter by model and date,
     select all, and choose *Link to purchase*. The diff fills gaps and replaces nothing by
     default.
   - Phase 2 helper, **Create purchase from selected assets**, from the same batch bar:
     ```
     Create a purchase from 20 selected assets
     Supplier [ Compumundo v ]  Number [ OC 0001-00003990 ]  Order date [ 12/03/2025 ]
     Currency [ ARS v ]
     Lines (one per model)
       Dell P2422H     20 units   unit price [ 210.000,00 ]  all 20 assets have this cost
     The 20 assets are linked. Their values are not changed.
                                                         [Cancel]  [Create and link]
     ```
     A unit price is prefilled only when every asset in the group has the same cost; otherwise it
     is blank. Assets are linked **without** the diff, and their values are never written.
   - Phase 2, *Suggest purchases from existing data* (persona question 11):
     - an optional page reached from the Purchases empty state and the `...` menu, never on
       upgrade;
     - lists proposed groups (same model, purchase date and cost, or same value in a custom field
       such as `oc`/`proveedor`) as cards with **Create** and **Ignore**;
     - nothing happens until a card is accepted, and ignored proposals stay hidden.
   - Phase 2, *Map a custom field to suppliers*:
     - takes the distinct values of a chosen spec key (`proveedor`, `Proveedor`), each mapped to an
       existing or new supplier, using the import wizard's conflicts-step pattern
       (`imports/_components/steps/conflicts-step.tsx`);
     - the custom fields are never moved or deleted.

### 3.h Finance or a read-only colleague

**Laura (Viewer with *View purchases*):**
- sees the Purchases nav, list, pending view, supplier pages and purchase detail;
- has no *New*, *Edit*, *Receive*, *Link* or *Upload* actions, which are hidden rather than
  disabled;
- can download documents;
- has every export.

The asset list and asset detail work as today (Viewers already read assets and cost).

**Exports, CSV in the MVP:**
- **Purchases list (filtered):** number, supplier, supplier tax ID, status, order date, invoice
  numbers, invoice date, currency, total, units ordered, received, pending and cancelled.
- **Purchase → Export lines and assets:** one row per linked asset with its line. Lines with no
  assets get one row. Columns: tag, serial, model, description, purchase date, invoice number,
  supplier, unit cost, currency, status, location, owner.
- **Assets list export** gains supplier, purchase number, invoice number, **purchase cost and
  currency**. Today's inventory CSV leaves cost out (`asset-inventory-csv.ts`), but the auditor's
  fixed-asset register needs it (D13). The book value column is labelled *IT estimate*.

**Spanish-locale Excel:**
- CSVs follow the UI locale. `es` uses `;` as delimiter and a comma decimal; `en` uses `,` and a
  dot decimal.
- Files are UTF-8 with a BOM, and dates are written as ISO `YYYY-MM-DD`, which Excel parses in any
  locale.
- XLSX comes in Phase 2 when the export surface grows.

**Read access, and the role-level limit:**
- Permissions are per role, not per person (Manual, *Permission configuration*). Granting *View
  purchases* to Viewer therefore grants it to **every** Viewer, the warehouse supervisor included.
- The Manual must say this plainly, and the role editor's summary shows it.
- **Default: Viewer denied** (D3).

**Uploading as finance:** Laura uploading invoices without edit rights would need a separate
*Add documents to purchases* permission. Defer it. In v1 she sends the PDF and a Member uploads it.

---

## 4. Smart entry (CEO input 1)

One pattern, two variants, every typed purchase field, in both modes.

### 4.1 Variants

| Variant | Used for | Built on |
| --- | --- | --- |
| **Entity picker** (choose a record, create one inline) | Supplier, Model, Category, Location, Purchase line, Consumable, Application | Existing `Combobox` in server-search mode (`components/combobox.tsx`) + `CreatableField`, extended with the ranking and groups below |
| **Suggest input** (free text with suggestions) | Manufacturer, Company, PO number, Invoice number, Line description, custom spec **values**, Currency (closed list) | New `SuggestInput` that **replaces the `<datalist>`** used today for Company (`asset-form.tsx:590`) and spec keys (`specs-fields-editor.tsx:198`). Native datalists cannot rank, group, show counts or warn about near-duplicates. |

### 4.2 The smart-entry combobox

```
Supplier
+------------------------------------------------+
| comp|umundo                                     |   grey completion; Tab accepts it
+------------------------------------------------+
+------------------------------------------------+
| Matches                                         |
| > Compumundo                 14 purchases · 3 d |
|   Compudata                   2 purchases · 8 mo|
| Recent                                          |
|   Dell Partner Cono Sur                         |
|   Mercado Libre                                 |
| ----------------------------------------------- |
| + Create "comp"                         Ctrl+Enter |
+------------------------------------------------+

Typing a near-duplicate
+------------------------------------------------+
| COMPUMUNDO SA|                                  |
+------------------------------------------------+
| Matches                                         |
| > Compumundo                 same name without  |
|                              "SA" · 14 purchases|
| ----------------------------------------------- |
| + Create "COMPUMUNDO SA" anyway                 |
|   A supplier with this name already exists.     |
+------------------------------------------------+

Free-text variant (manufacturer on a new model)
 Manufacturer  [ DELL               ]
               Use "Dell" instead? Used on 142 assets.  [Use Dell]  (Tab)
```

**On focus with an empty field:**
- shows **Recent**: up to five values *this person* used in *this field*, kept in `localStorage`
  per browser as a per-viewer convenience, wrapped in try/catch, with no server state needed;
- then **Most used**: up to five values instance-wide, by count;
- the full history is searchable by typing.

The persona's "suggest instead of starting blank" is satisfied before a key is pressed.

**While typing:** results are ranked in tiers, then by use, then by recency.

1. **Same value:** the normalized key equals the query's normalized key (see 4.3).
2. **Starts with** the normalized query.
3. **A word starts with** the query, including acronyms: "tp" matches "ThinkPad".
4. **Contains** the query.
5. **Close spelling:** Damerau-Levenshtein ≤ 1 for 4–7 characters, ≤ 2 for 8 or more. This catches
   "Compumndo".

Within a tier, results sort by `log(use count)` and then by last used. Use count and last used
come from the server's distinct-values read. The read already exists for companies
(`useAssetCompanies`) and needs the same shape (value, count, lastUsedAt) per field.

**Inline completion:** the top result is completed in grey after the caret when it starts with what
was typed. Tab accepts it. This is the fastest path for repeat values.

**Context boosts:**
- When a supplier is set, the Model and Line description fields rank that supplier's past values
  first.
- When a category is set, models in that category rank first.
- When a model is chosen, Manufacturer is filled from it.

**Show the count and age** ("14 purchases · 3 d") so the canonical spelling is obvious.

**Keyboard:**

| Key | Behaviour |
| --- | --- |
| ↓ | Opens the list |
| ↑ / ↓ | Move the highlight |
| Enter | Picks the highlighted item |
| Tab | Accepts the grey completion, or moves on, keeping the text in free-text fields |
| Esc | Closes the list and keeps the typed text |
| Ctrl/Cmd+Enter | Explicit **Create** (entity) or **keep as typed** (free text) |
| Home / End | Inside the input, as normal |

Enter never creates a record by accident. The cmdk keyboard model of the current `Combobox` stays
in place.

### 4.3 How drift is prevented

- **Normalized key** (computed in the browser and on the server, never stored as the display
  value):
  - lowercase, with accents stripped;
  - punctuation and spaces collapsed;
  - legal suffixes removed (`sa`, `s.a.`, `srl`, `sas`, `sl`, `inc`, `llc`, `ltd`, `gmbh`, `corp`,
    `co`, `bv`, `spa`).
  So "Dell", "DELL", "Dell Inc." and "dell, inc" all key to `dell`.
- **On create** (entity): if the normalized key equals an existing record's, the create row turns
  into *"A supplier with this name already exists"*, and the existing record is the highlighted
  default. Creating anyway stays possible. The guard prevents accidents; it does not refuse
  intent.
- **On blur** (free text): if the typed value's normalized key equals an existing value spelled
  differently, an inline hint offers *Use "Dell" instead?* with the use count, accepted with Tab
  or a click. The value is **never auto-replaced**, because silent changes are what the research
  fears.
- **Supplier tax ID** is the strongest key (D7). Typing a tax ID that already exists says so
  immediately: *"30-71234567-9 belongs to Compumundo. [Open]"*. Extraction matches on it first.
- **Later clean-up** (Phase 2): *Merge suppliers* (ADMIN; repoints purchases, logs on both) and a
  *Values in use* view per free-text field that lists the variants with counts and rewrites the
  chosen ones in a confirmed batch. This is the same mechanism as the custom-field-to-supplier
  mapping in §3.g.

### 4.4 Where it applies

| Field | Variant | Suggestions | Extra smartness | Create inline |
| --- | --- | --- | --- | --- |
| Supplier (purchase) | Entity | Recent, most used, all | Tax ID match; near-duplicate guard | Yes: small dialog (name, tax ID optional) |
| PO / order number | Suggest | The supplier's last numbers | **Pattern prefill**: after choosing a supplier, the field proposes the prefix of their last number (`OC 0001-0000`) with the caret at the end; duplicates per supplier are flagged inline | n/a |
| Invoice number(s) | Suggest (chips) | The supplier's last invoice numbers | Pattern prefill (`A 0003-000…`) | n/a |
| Currency (purchase, asset cost) | Suggest, closed list (ISO 4217) | **Last used by me**, then most used on the instance, then all, searchable by code or name ("peso" offers ARS, CLP, COP, MXN, UYU) | A supplier's last currency is suggested when the supplier is picked | No |
| Line description | Suggest | The supplier's previous line descriptions | **Line memory**: picking a past description also proposes its model mapping and shows *"Last paid ARS 1.380.000,00 on OC …4498 (Feb)"* as a hint with click-to-use. The price is never prefilled silently. | n/a |
| Model (line, receive, asset) | Entity | Recent; models previously bought from this supplier first | Description-to-model memory | Yes: existing *New model* dialog, name prefilled |
| Manufacturer (new model) | Suggest | Distinct manufacturers (the AI input form already uses this source) | Near-duplicate hint | n/a (free text) |
| Category | Entity | Recent, most used | Filtered by model when known | **No.** Kept pick-only as in Receive stock today ("a typo would leave a ghost category"). Categories are created in Settings. |
| Location (deliver to, receive) | Entity | Recent | The purchase's location prefills receives | Existing create dialog |
| Company (purchase, asset) | Suggest | Distinct companies with counts | Replaces today's datalist | n/a |
| Warranty months (line) | Suggest | 12 / 24 / 36 plus this model's last value | n/a | n/a |
| Asset purchase cost (free field) | Hint | *"Last cost for this model: ARS 1.412.500,00 (OC …4512)"*, click to use | Currency comes along with the click | n/a |
| Useful life (free field) | Suggest | The most common value for this category ("36 months, used on 140 laptops") | n/a | n/a |
| Custom spec **values** (free fields) | Suggest | Distinct values seen for that key, e.g. every `proveedor` value | Near-duplicate hint | n/a |

---

## 5. Vocabulary (en / es)

The single most confusing collision is already shipped. The application's "Vendor" field is
translated **"Proveedor"** in `messages/es/applications.json`, which is exactly the Spanish word
for the new supplier. I recommend renaming that *label* (D2; no data change).

| Concept | en | es | Notes |
| --- | --- | --- | --- |
| The area | Purchases | Compras | Not "Purchase Orders": lazyit does not issue them |
| One record | Purchase | Compra | |
| The finance number | PO / order number | Nº de orden de compra (OC) | Shown as the record's title |
| Who you pay | **Supplier** | **Proveedor** | Help text: "Who you buy from and pay. Not the maker." |
| Who makes the hardware | Manufacturer (unchanged) | Fabricante (unchanged) | On models |
| Who makes the software | **Publisher** (was "Vendor") | **Fabricante** (was "Proveedor") | Application field label only; help text "Who makes the software, not who you buy it from." |
| Line | Line | Línea | |
| Line types | Asset · Consumable · License · Other | Activo · Consumible · Licencia · Otro | |
| Unit price | Unit price | Precio unitario | Help: "usually without VAT" / "normalmente sin IVA" |
| Statuses | Draft · Ordered · Partially received · Received · Cancelled | Borrador · Pedida · Recibida parcialmente · Recibida · Cancelada | Feminine, agreeing with *compra* |
| Line progress | 3 of 4 received · 1 pending · 1 cancelled | 3 de 4 recibidas · 1 pendiente · 1 cancelada | |
| Receive (generate assets) | Receive | Recibir | Matches today's "Receive stock / Recibir stock" |
| Receive several lines | Receive delivery | Recibir entrega | Phase 1b |
| Link | Link to purchase · Link existing assets | Vincular a una compra · Vincular activos existentes | |
| Unlink | Unlink from purchase | Desvincular de la compra | |
| Diff | Apply values from the purchase? · fill · replace | ¿Aplicar valores de la compra? · completar · reemplazar | |
| Divergence | Differs from purchase | Difiere de la compra | |
| Cancel the rest | Cancel remaining units | Cancelar unidades pendientes | |
| Pending view | Pending units | Unidades pendientes | |
| Document types | Quote · Order · Invoice · Delivery note · Other | Presupuesto · Orden de compra · Factura · Remito · Otro | "Remito" matches the LatAm audience the current `es` catalog addresses |
| Extraction | Fill from this document · Propose changes from this document | Completar desde este documento · Proponer cambios desde este documento | |
| Missing currency | No currency | Sin moneda | Never "default currency" |
| Book value | Book value (IT estimate) | Valor contable (estimación de IT) | |

Tone follows the existing catalogs: direct, peer-to-peer, no buzzwords. The `es` catalog currently
mixes *Elige*/*Elegí* and *puedes*/*podés*. The new strings should follow whichever register the
catalog owner standardizes on. That is not this feature's call.

---

## 6. Mobile and receiving at the door

The moment that matters: the courier is at the warehouse, Nico has a phone and his hands are full.

**v1 (MVP): responsive and photo-capable, no new device features.**

- Every purchase surface uses the existing `ResourceCard` mobile twin, the same as the lists today.
  Purchase detail stacks as header, lines (cards with a big **Receive** button), documents, assets.
- **Remito photo:**
  - the purchase's *Upload* uses `accept="image/*,application/pdf"`, so mobile browsers offer the
    camera directly;
  - it is attached as a document of type *Delivery note*;
  - this costs nothing and stops the "photo goes to WhatsApp" habit.
- The Receive dialog becomes a full-height `Sheet` on small screens. The serials textarea comes
  first, and the primary button is fixed at the bottom.

**Phase 1b ("at the door"): worth doing early, because it is where errors disappear.**

- **Scan serials into the list:**
  - The *Scan* button reuses the camera scanner from `/assets/scan`
    (`assets/scan/_components/asset-scanner.tsx`, `html5-qrcode`), enabled for 1D barcodes
    (Code 128 / Code 39, which are on laptop and monitor boxes) as well as QR.
  - It scans continuously. Each read is appended as a line with a short haptic/visual tick,
    duplicates within the session are ignored with a toast, and quantity follows the count.
  - *Done* returns to the sheet for review.
- **Receive delivery** (several lines at once; persona question 8):
  ```
  Receive delivery · OC 0001-00004512
  Lenovo ThinkPad E14 Gen 5       1 pending   [ - 1 + ]  Serials (1)  [Scan]
  Dell WD19S dock                 2 pending   [ - 0 + ]
  Delivery note photo             [Take photo]
                                               [Receive 1 unit]
  ```
  - Each line has a quantity stepper defaulting to 0 and a serials box that opens when quantity is
    above 0.
  - The shared prefill comes from the purchase.
  - One submit runs one receive per line and shows a combined partial-success result.
  - On a phone, the scanner fills **the focused line**.
- *Pending units* is the mobile landing: tap a purchase, tap *Receive*.

**Later:** the chat on mobile ("photo of the remito: these arrived for OC 4512") through the
Phase 3 flow, with the photo uploaded to the purchase first. A native or PWA offline mode is not
worth it for 6–12 purchase events a month.

---

## 7. Phasing from the UX side

| Phase | Flows and surfaces | Why here |
| --- | --- | --- |
| **0: Decide** | The CEO decisions below, ADR-0099, the Manual outline | |
| **1: MVP (manual)** | Switch; Suppliers (list, page, smart picker, tax ID); purchase list (Open default) and detail; create/edit with line grid (Asset, Other); **shared documents** (shown on linked assets); **Receive from line** (Receive stock in purchase mode); Receive stock / New asset *From purchase* picker and bypass suggestion; **Link existing** from line, asset detail and **bulk from the Assets list**, with the diff; asset *Purchase* panel (provenance, differs marker, purchase documents, supplier support contact); Cancel remaining / Cancel purchase; line price change follow-up; activity log; CSV exports (locale-correct); **smart entry** across all fields in §4.4, in both modes; locale-aware money input; Viewer read via the role editor; Manual pages (en + es) | Delivers the research's biggest wins: one invoice for 20 assets, asset-to-purchase-to-invoice in one click, back-linking the existing estate, "x of y received", and a receive that is faster than today |
| **1b: At the door** | *Pending units* tab; *Receive delivery* across lines; barcode scanning into serials; **Consumable lines** ("Receive into stock" posts an IN movement with the purchase as reason); consumable "Last purchased"; dashboard *Pending deliveries* tile; global search for purchases; supplier page purchase history with yearly totals **per currency** | Highest-frequency purchases (toner, 3–4 a month) and the error-killing mobile moment |
| **2: Extraction** | Fill from document; propose changes from a later document; document-type labels; *Create purchase from selected assets*; *Suggest purchases*; *Map a custom field to suppliers*; *Merge suppliers*; **License lines** (link to an application and *propose* a seats/renewal update through the same diff, never automatic arithmetic); XLSX export; warranty replacement action | Extraction is the persona's favourite convenience, but it depends on trust built in Phase 1 |
| **3: AI chat** | Page-context chip for purchases; extract tool; batched input form; paged approval cards with money and asset pages excluded from Approve all; purchase lookup questions ("what's pending from Compumundo?") | Lookups and convenience, on the same rules as extraction |

**The smallest MVP that still wins**, if Phase 1 must shrink:

- **Keep:** suppliers, purchases, lines, shared documents, receive-from-line (it is Receive stock
  in a mode), link existing (single and bulk) with the diff, the asset Purchase panel, the *Open*
  list with pending counts, CSV, and smart entry on the new fields plus Company and Manufacturer.
- **Cut to 1b first:** the bypass suggestion in plain Receive stock, the line price follow-up
  dialog (show a "linked assets keep their values" note instead), and supplier yearly totals.
- **Never cut:** the diff, currency display, and locale-aware number input. They protect trust,
  and trust is the adoption risk.

---

## 8. Conflicts and decisions

### 8.1 Where the research and the analysis disagree

**1. Currency per purchase vs single implicit currency.** *Resolved by the CEO: per purchase, no
FX.* What remains is the asset's cost.

| Option | UX consequence |
| --- | --- |
| A. Nullable currency on the asset's purchase cost; copying from a purchase sets cost and currency together; existing assets show *No currency* | Honest everywhere: book value is printed in the asset's own currency; any aggregate groups by currency with a *No currency* group; a later batch action *Set currency* on selected assets fixes the backlog by filter ("everything bought before 2025-01 is ARS"). Smart entry suggests the last used currency on the asset form. |
| B. No asset currency; cost is copied only when it is unambiguous and otherwise shown read-through from the purchase | The asset shows "Cost from purchase: USD 1.150,00" without owning it. Book value is absent for those assets, and unlinked assets stay bare numbers. Two display rules for one field, and the backlog problem stays unsolved. |
| C. Copy the number, ignore currency | Silently misstates cost and depreciation. This is research fear #4. |

**Recommendation: A** (D1). It adds a nullable label, not a second money convention: amounts stay
int4 minor units. Every reader that sums purchase cost must group by currency.

**2. Finance read access vs "Viewer denied".** Permissions are per role, so "Laura yes, warehouse
supervisor no" is impossible within the Viewer role.

| Option | UX consequence |
| --- | --- |
| Default deny for Viewer | The admin flips *View purchases* for Viewer when every Viewer may see purchases |
| Default allow | The warehouse supervisor sees supplier prices out of the box, which the persona did not want |

**Recommendation: deny by default**, with the Manual explaining the trade-off. Copied asset costs
stay visible to Viewers as today (persona question 15: do not take away what people already see).

**3. Receipt ledger vs derived "x of y received".**

| Option | UX consequence |
| --- | --- |
| Ledger | Records "arrived but not yet registered" and delivery dates separately, at the cost of two counters for operators to reconcile, which the persona never asked for |
| Derived | Received = assets linked to the line (later also stock moved in for consumable lines) |

**Recommendation: derived**, plus a stored **cancelled quantity per line** (with the reason in the
event log) so "3 received · 1 cancelled" closes a purchase. Also show *Partially received* and
*Received* as **derived** statuses rather than the user-set `RECEIVED` the analysis proposes
(D4), so nobody has to babysit a status.

**4. Consumable and license lines timing.** The research wants both in v1; the analysis puts them
after the MVP.

| Line type | UX consequence of deferring |
| --- | --- |
| Consumable | Consumables are the most frequent purchase (3–4 a month). Deferring them means toner orders become *Other* lines plus a separate stock movement. That is double entry, so Agus would skip the purchase. |
| License | One or two renewals a month, and the desired behaviour (propose seat and renewal updates) needs the diff machinery to be mature first |

**Recommendation:** consumable lines in **Phase 1b**, the first follow-up and ahead of extraction.
License lines in Phase 2, as a link plus a *proposed* update, never automatic (D9).

**5. Purchase number required vs optional.** The analysis wants a required reference, unique per
supplier. Requiring it forces fake numbers ("ML", "-") for the Mercado Libre mouse and pollutes
search. **Recommendation:** optional, unique per supplier when set; the display falls back to
*Supplier · date*; no own running number in v1 (D6).

**6. Over-receipt: block vs warn.** **Recommendation: block, with a one-click "Raise the line to
n"** that edits the line and continues. The server guard keeps integrity, and the operator is
never stuck (agrees with analysis D8).

**7. Auto-approved draft creation in chat.** The research accepts it; the analysis' untrusted marker
forbids auto-approval after an extraction anyway. **Recommendation:** no auto-approve for any
purchase write, and asset and money pages excluded from *Approve all* (D11).

**8. File upload in chat.** The persona expects to drop a PDF in the chat. **Recommendation:**
upload on the purchase and work through the page context (agrees with analysis D14). The chat
explains this in one line, with a *New purchase* button.

**9. "Highlight where it came from" in extraction.** There are no reliable coordinates from
structured output. **Recommendation:** verbatim source text plus a page number per field (§3.b).

**10. Net/gross toggle and header tax/shipping amounts.** **Recommendation:** no toggle and no
stored tax. Shipping is an *Other* line. Unit price help text sets the convention. This also
avoids int4 risk on header amounts.

**11. Header fields beyond the analysis' model.** The research's must-haves include fields the
analysis' model lacks: currency, delivery location, company, invoice number(s), invoice date and
expected date. **Recommendation:** add them, all optional and behind *More details* except
currency (D5).

**12. Supplier fields.** The research needs a **tax ID** (the real duplicate key) and a separate
**support/RMA contact**, which the analysis' Supplier lacks. **Recommendation:** add both (D7).

### 8.2 Answers to the persona's open questions ([[purchases/user-interview]] §(c))

| # | Question | Answer | Owner |
| --- | --- | --- | --- |
| 1 | Different model delivered | Receive **against the line** with the model overridden and a note. No split, no edit of what was ordered. The line shows "1 received as E14 Gen 6". | UX |
| 2 | Warranty replacement with a new serial | A **new asset** (asset = physical unit; serials are unique). It inherits the purchase link, cost and **original warranty end**, and does not count toward the line quantity. The old asset becomes *Retired*, and both histories show "Replaced by / Replaces". Phase 2 *Replace under warranty* action, which needs a relation (data model). Until then: new asset plus a note. | UX; the relation is a CEO data decision in Phase 2 |
| 3 | Which date is the purchase date | Invoice date when known, else today (delivery), overridable per receive. Order date never defaults. | UX |
| 4 | How differences show | A *Differs from purchase* badge on cost and currency only, with the purchase value and *Apply*. Nothing for dates. | UX |
| 5 | Live values or copies | **Copy** at link or receive through the diff. *Apply purchase value* re-applies. Line price edits propose updates for assets that were not overridden. | UX (matches analysis D4) |
| 6 | Where suppliers live | A tab inside Purchases. Supplier vs Manufacturer vs **Publisher** naming plus on-screen help text. | UX; the label rename is CEO D2 |
| 7 | What "received" means per line kind | Asset: linked live assets. Consumable: units moved in from the line. License: a manual "delivered" toggle with an optional proposed seats/renewal update. Other: no receiving and never pending. | UX; license behaviour is CEO D9 |
| 8 | Receiving several lines, on a phone with a scanner | *Receive delivery* sheet with a stepper and serials per line; the scanner fills the focused line (Phase 1b). | UX |
| 9 | Own running number, which is primary | No running number in v1. The finance number is primary when present, else *Supplier · date*. | CEO D6 |
| 10 | Currency on existing assets | *No currency* is its own state. A batch *Set currency* acts on a selection or filter. Totals show a separate *No currency* group. | CEO D1 |
| 11 | Presenting the backfill | An optional *Suggest purchases* page with accept/ignore cards. It never runs on upgrade and only links. | UX (Phase 2) |
| 12 | Extraction review layout and nagging | Split view; source text per field; *3 to check* counter; one save-time confirmation; totals banner. | UX |
| 13 | What is batched and what gets its own card | All ambiguity goes into one form (serials in a second form only if units arrived). Each kind of write gets its own card page. No auto-approve. Money and asset pages are excluded from Approve all. | UX; CEO D11 |
| 14 | One invoice covering two purchases | Upload it to both in v1. Phase 2 *Also attach to another purchase*. | UX |
| 15 | Prices for Viewers | Hide purchases by default; keep cost and book value on assets visible as today. | CEO D3 |
| 16 | Turning off with existing data | Area and pickers hidden; read-only provenance and purchase documents stay on assets. | CEO D10 |
| 17 | Leases and reimbursements | Out of v1. The Purchase panel leaves room for a later "How acquired" field. Reimbursements work today through the free fields plus the asset's own documents. | CEO (roadmap) |
| 18 | When a purchase is done | Automatically *Received* when every countable line is received or cancelled. No invoice requirement and no manual *Closed*. | CEO D4 |

### 8.3 Decisions for the CEO

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Asset purchase cost gains a nullable **currency**: set together with cost when copied from a purchase, *No currency* for existing assets, a batch *Set currency* later | **Yes.** It is a label on the existing int4 amount, not a second money convention. Readers that aggregate cost must group by currency. |
| D2 | Rename the application field label "Vendor / Proveedor" to **"Publisher / Fabricante"** (label and Manual only, no data change) | **Yes.** Otherwise "Proveedor" means two things in Spanish on day one. |
| D3 | Default for Viewer on *View purchases* (role-level only: no per-person grant) | **Denied by default**, with Manual guidance. Asset cost stays visible to Viewers as today. |
| D4 | Purchase status model | Store **Draft · Ordered · Cancelled**; derive **Partially received · Received**; no *Closed*. Add a per-line **cancelled quantity**. This replaces the analysis' user-set `RECEIVED`. |
| D5 | Extra optional header fields: delivery location, company, invoice number(s), invoice date, expected date | **Add all** (optional, behind *More details*). |
| D6 | PO number required vs optional; own running number | **Optional**, unique per supplier when set; display falls back to *Supplier · date*; **no running number in v1**. |
| D7 | Supplier gets **tax ID** (duplicate key) and a separate **support/RMA contact** | **Yes.** |
| D8 | Receipt ledger | **No ledger.** Received is derived from linked assets (and later consumable movements), plus cancelled quantity. |
| D9 | Line kinds timing | Asset + Other in the MVP; **Consumable in Phase 1b**; **License in Phase 2** as a link plus a proposed seats/renewal update, never automatic. |
| D10 | Switch OFF with existing data | Hide area and pickers; **keep read-only provenance and purchase documents visible on assets**. |
| D11 | AI approval policy for purchases | **No auto-approve for any purchase write**; pages that create assets or change money are **excluded from Approve all**. |
| D12 | int4 money ceiling (21.474.836,47 per amount) vs ARS-scale unit prices (a server in ARS can exceed it) | **Input needed from the CEO** on target currencies. UX ships a clear inline error, and totals are derived, never stored. |
| D13 | Assets CSV starts including **purchase cost and currency** (excluded today), plus supplier, purchase number and invoice number; CSV follows UI locale (`;` and decimal comma for `es`, BOM) | **Yes.** The auditor's register needs it, and Viewers can already see cost on screen. |
| D14 | Document extraction switch | **Separate, OFF by default**, with disclosure of what is sent; disabled for providers that cannot read files (agrees with analysis D13). |
| D15 | PO documents and the backup gap | **Prioritize the attachments backup** and show a quiet warning on the purchase's Documents panel until then (agrees with analysis D15). |
| D16 | Leases and "how acquired" | **Out of v1**; revisit with a separate ADR. |

---

## Appendix A: reused patterns and files

| Need | Reuse | File |
| --- | --- | --- |
| Receive from line | Receive stock dialog in a new "from purchase line" mode, with partial-success result and auto-tag hint | `apps/web/app/(app)/assets/_components/receive-stock-dialog.tsx`, `receive-stock-payload.ts`, `auto-tag-hint.ts` |
| Inline model create | New model dialog, name prefilled | `apps/web/components/create-asset-model-dialog.tsx`, `creatable-field.tsx` |
| Entity pickers | Combobox (server-search) | `apps/web/components/combobox.tsx` |
| Free-text suggestions | Replace `<datalist>` | `asset-form.tsx` (Company), `components/specs-fields-editor.tsx` (spec keys and values) |
| Bulk link | Row selection and BatchActionBar | `apps/web/components/resource-table.tsx`, `lib/hooks/use-row-selection` |
| Documents | Upload, drag-and-drop, list | `apps/web/app/(app)/assets/[id]/_components/asset-documents-panel.tsx` |
| Detail layout | DetailPanel / DetailField | `apps/web/components/detail-panel.tsx`, `asset-detail-view.tsx` |
| Empty states, callouts | EmptyState, Callout | `components/empty-state.tsx`, `components/callout.tsx` |
| Instance switch | Settings card with switch | `apps/web/app/(app)/settings/instance/_components/asset-tag-scheme-editor.tsx`, `smtp-settings-editor.tsx` |
| Nav entry | NAV inventory section, permission-gated | `apps/web/components/sidebar-nav.tsx` |
| AI questions | `request_input` form (repeat groups, option sources) | `components/ai/ai-input-card.tsx`; `packages/shared/src/schemas/ai-run.ts` (`AI_INPUT_OPTION_SOURCES` needs `suppliers`, `consumables`) |
| AI approvals | Paged approval card, preview table | `components/ai/ai-approval-pager.tsx`, `ai-approval-card.tsx`, `ai-preview-table.tsx` |
| Barcode scan | html5-qrcode scanner | `apps/web/app/(app)/assets/scan/_components/asset-scanner.tsx` |
| Value-to-entity mapping | Import conflicts step | `apps/web/app/(app)/imports/_components/steps/conflicts-step.tsx` |
| Money | Minor/major helpers; needs locale-aware parsing and currency formatting | `apps/web/lib/utils/money.ts` |

## Appendix B: design-system guardrails for this feature

- Purchases wears the **inventory** pillar: a tinted icon chip in the page header and empty state,
  never as readable text (DESIGN.md "Pillar-as-Decoration").
- Statuses use solid `StatusBadge` fills:
  - Draft: secondary;
  - Ordered: info;
  - Partially received: warning;
  - Received: success;
  - Cancelled: secondary.
  Each status has a text label, and color never stands alone.
- Amounts are in Commit Mono with tabular numerics. The currency code precedes the amount
  (`ARS 1.412.500,00`) in every locale, so the code is never lost in a column.
- One primary button per view: *Save purchase*, *Receive n units*, *Link n assets*.
- The progress bar on the purchase header uses neutral plus success tokens (the Signal Dense ratio
  bar idea), with the counts written out next to it.
- Every new surface is AA in both themes and reduced-motion safe. Dialogs become `Sheet`s on small
  screens.
