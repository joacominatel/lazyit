---
title: "Purchases — CEO inputs and decisions"
tags: [purchases, decisions, ceo]
status: accepted
created: 2026-10-01
updated: 2026-10-04
---

# Purchases — CEO inputs and decisions

> The CEO's inputs to the design, the package approved on 2026-10-01, the four decisions taken after
> acceptance (2026-10-01 and 2026-10-02), the confirmations of the decisions taken while building
> (2026-10-02) and dropping a document to start a purchase (2026-10-03), with the CEO's words quoted verbatim. Where a later decision
> replaces part of an earlier one, the earlier text is kept as approved and marked *superseded* or
> *refined*. The decision record built from this note is
> [[0099-purchases-scope-model-and-optionality|ADR-0099]], with the money widening in
> [[0100-money-as-64-bit-minor-units|ADR-0100]]. When this note and an ADR read differently, the ADR is
> the binding wording. Back to [[purchases/_MOC|the Purchases vault]].

## 1. Inputs given before the UX design

These two inputs were binding on [[purchases/ux-proposal|the UX proposal]].

1. **Suggest previously used values on manual entry.** Wherever a user types purchase data by hand
   (supplier, brand/manufacturer, model, category, currency, PO number patterns, free purchase fields
   on the asset), the field suggests values instead of starting blank: most recently used, closest match
   to what is being typed, and a searchable list of values entered before. The goal is to reduce how
   much the user has to type and to keep data consistent (no "Dell" / "DELL" / "Dell Inc." drift). It
   applies both to the purchase flow and to the free purchase fields on the asset.

   CEO, verbatim: "si se cargan datos manuales, a nivel ux, seria comodo que se filtren tambien por el
   ultimo usado o el ultimo parecido o que sea filtro de busqueda con los anteriores puestos algo asi,
   como para facilitarle al usuario la cantidad de datos. Sugerir digamos"

2. **Currency per purchase order, chosen by the user; no exchange rates.** Each purchase carries a
   currency code the user picks (suggested through smart entry, e.g. last used). lazyit does not fetch,
   store or apply exchange rates, and never converts or sums across currencies — it is not an ERP. The
   currency exists to state what the amounts are in. This resolved the conflict between the user
   research and [[purchases/technical-analysis|the technical analysis]] on currency.

   CEO, verbatim: "Si moneda configurable por usuario en cada ordne diria yo, sin cotizaciones, no es un
   ERP, pero si sirve para especificar una moneda" (the user picks the currency on each order; no
   exchange rates; it is not an ERP; it only states what currency the amounts are in).

   *Refined by D-C (§3):* the currency is a free-text label the user types, not a code picked from a
   list.

## 2. The approved package (2026-10-01)

CEO, verbatim: "dale, aprobado el paquete con la ampliación de montos" (ok, the package is approved,
including the money widening).

1. Reverse the purchase-order non-goal of [[0089-bulk-receiving-and-checkout-acknowledgement|ADR-0089]]
   with a new ADR-0099 that sets hard limits: no approval workflow, budgets, invoices as payables,
   three-way match, or supplier portal. lazyit records purchases; the finance system stays the system of
   record.
2. Model: [[supplier]] + [[purchase-order]] + [[purchase-order-line]] (+ an append-only
   [[purchase-order-event]] log); an asset points at one line (nullable). Asset purchase fields stay
   authoritative; purchase values are copied onto assets only on explicit confirmation (fill-empty
   pre-checked, replace never pre-checked).
3. Asset purchase cost gets an optional currency; existing assets read as "no currency". Each purchase
   carries a user-chosen currency; no exchange rates; never sum across currencies. *Refined by D-C:*
   both are optional free-text labels, with no ISO list.
4. Purchase status: the user sets DRAFT / ORDERED / CANCELLED; "partially received" and "received" are
   derived from linked assets plus cancelled units per line. No receipt ledger.
5. PO number (reference): optional, unique per supplier among live rows when set. No auto-numbering in
   v1. *Uniqueness superseded by D-D:* the reference is not unique; a repeat is a suggestion.
6. Viewer role: Purchases read denied by default (grantable per role). Delete/restore ADMIN-only.
7. The application "Vendor" field is relabelled "Publisher" (en) / "Fabricante" (es). Label only.
8. ~~The feature is an instance switch, OFF by default. Turning it off hides Purchases, deletes nothing,
   and assets keep showing their purchase read-only.~~ *Superseded by D-B:* there is no instance switch;
   Purchases is always available and optional at entry.
9. AI: extraction produces a draft that a human always reviews; a separate "Document extraction" switch
   under AI settings, OFF by default, with disclosure; purchase changes are never auto-approved.
   Extraction reads a document already attached to the purchase (no chat upload).
10. Back up the attachments volume before or alongside Phase 1. *Not delivered with the epic:* #1467 is
    open, deferred by the CEO; until it ships, the purchase's documents panel says the files are not in the
    backup ([[backups]]).
11. Money widening: money amounts move from int4 to 64-bit integers (minor units) — the new purchase
    tables and the existing `Asset.purchaseCost` / `salvageValue` and `Application.costPerSeat`.
    Widening is non-destructive. Amends [[0036-int4-bounded-integers|ADR-0036]] and
    [[0088-application-license-seat-tracking|ADR-0088]] → [[0100-money-as-64-bit-minor-units|ADR-0100]].

**UX-proposal defaults accepted with the package:** the name "Purchases" / "Compras" under Inventory;
optional header fields (delivery location, company, invoice numbers, invoice date, expected date);
supplier tax ID plus a support/RMA contact; consumable lines in Phase 1b and license lines in Phase 2
(propose, never auto-change seats); smart entry applies everywhere a purchase field is typed (the
accepted wording, "with the feature ON or OFF", lost its meaning with D-B); the assets CSV gains cost,
currency, supplier, PO and invoice numbers in a locale-aware format; leases out of v1.

## 3. Decisions after acceptance (2026-10-01 and 2026-10-02)

ADR-0099 was accepted with four questions open. The CEO settled them before anything was built.

### D-A — Purchase provenance follows `purchaseOrder:read` (2026-10-01)

Asked whether a principal without `purchaseOrder:read` (e.g. a Viewer) sees a linked asset's purchase
provenance and documents. The recommendation: no — the asset's *Purchase* panel (supplier, reference,
dates, purchase documents) is shown only with `purchaseOrder:read` and hidden otherwise; the asset's own
purchase fields (cost, currency, dates) stay visible under `asset:read`, as today.

CEO, verbatim: "dale, seguí con tu recomendación." (go ahead, follow your recommendation).

### D-B — No instance switch (2026-10-02)

Asked whether the API should refuse purchase writes when the feature is switched off.

CEO, verbatim: "Pero porque desactivado? para mi que funciones por defecto pero que a nivel de carga sea
opcional." (But why switched off? To me it should work by default, and be optional at data entry.)

The instance on/off switch is removed entirely. Purchases is always available (subject to permissions);
nobody has to use it, and the asset's free purchase fields keep working exactly as today. Replaces
package item 8. The separate AI *Document extraction* switch, OFF by default (item 9), **stays**: it
governs sending financial documents to an external AI provider, not the Purchases feature.

### D-C — Currency is free text (2026-10-02)

Asked how to display amounts in currencies without two decimals.

CEO, verbatim: "Las monedas son texto libre del usuario, no elige una moneda, no hacemos cotizaciones,
guardamos valores nada mas. Depende como los cargue el usuario" (Currencies are the user's free text; the
user does not pick a currency; we do no exchange rates; we only store values. It depends on how the user
enters them.)

Currency is an optional free-text label the user types, with smart entry suggesting labels used before.
No ISO 4217 list, no currency semantics, no exchange rates, no conversion. Amounts are stored as entered
(64-bit minor units, ADR-0100, unchanged) and displayed as entered: locale grouping, decimals only as the
user entered them, no forced ",00" on whole amounts. Totals group by label (trimmed, case-insensitive) and
are never summed across labels. The same holds for the optional asset cost currency.

### D-D — Flexibility over strictness (2026-10-02)

Asked to approve strict field rules for Phase 1 (supplier name unique, tax ID unique, and similar).

CEO, verbatim: "Yo lo haria bastane mas flexible la verdad, la idea de la features es que no sea moleste
y no sea denso cargar." (Honestly I would make it a lot more flexible; the idea of the feature is that it
is not a nuisance and not heavy to fill in.)

A governing principle of ADR-0099: entry is light and never in the way. Concretely: minimal required
fields (a purchase needs only what makes it identifiable — a supplier, a reference, or one line; a line
needs only a description, its quantity defaults to 1 and its price is optional); **no uniqueness
constraints** on supplier name, tax ID or purchase reference, with likely duplicates surfaced as
non-blocking suggestions ("is this the same supplier?"); tax ID optional; invoice numbers one free-text
field; document type an optional free-text label; status and line kind stored as `TEXT` validated by zod.
Replaces the uniqueness of package item 5 and the required supplier and currency.

**The CTO's application of D-D** (not a CEO quote): generating or linking more assets than a line's
quantity is **allowed with a warning** and shown as over-received, replacing "blocked under a lock". The
per-line count stays correct under concurrency because it is derived from linked assets, never stored.

## 4. Where each decision is recorded

| Decision | Recorded in |
| --- | --- |
| 1, 2, 3, 4, 5, 6, 9, 10 and the accepted defaults | [[0099-purchases-scope-model-and-optionality|ADR-0099]] |
| 7 | ADR-0099 §13, [[application]], [[0088-application-license-seat-tracking|ADR-0088]] amendment |
| 8 (superseded) | ADR-0099 §7 and *Decisions after acceptance* (D-B) |
| 11 | [[0100-money-as-64-bit-minor-units|ADR-0100]] |
| Smart entry (input 1) | ADR-0099 §7, [[purchases/ux-proposal]] §4 |
| D-A | ADR-0099 §8 and §10, [[authorization]], [[asset]] |
| D-B | ADR-0099 §7, §11, §13, §14 |
| D-C | ADR-0099 §5, [[0100-money-as-64-bit-minor-units|ADR-0100]] §5, [[purchase-order]], [[asset]] |
| D-D and its CTO application | ADR-0099 governing principle, §2, §4, §6, [[supplier]], [[purchase-order]], [[purchase-order-line]] |
| The confirmations and the stock-receipt reason (§5 below) | ADR-0099 *CEO confirmations (2026-10-02)*, [[0100-money-as-64-bit-minor-units\|ADR-0100]] §5, [[consumable-movement]], [[purchase-order-line]], [[INVARIANTS]] INV-PO-1 |
| Dropping a document to start a purchase (§6 below) | §6 below, [[purchases/ux-proposal]] (*Built differently*), the Manual's *Purchases & suppliers* page |

## 5. CEO confirmations (2026-10-02)

After the build, the CEO answered direct questions on the decisions the builds had taken provisionally
(#1494). The recommended option of each question is marked *(Recomendado)*; the answers are verbatim.

**The stock receipt names the purchase reference** (a new decision; it amends ADR-0099 Phase 1b). Asked
whether a consumable stock receipt keeps the fixed reason *Received from a purchase* — no supplier, no
reference, because Viewers read the stock ledger:

CEO, verbatim: "Incluir el número de orden" (include the order number).

The receipt's movement now reads *Received from purchase OC-4512* (the fixed text when the purchase has no
reference). Everyone who can see the consumable's movements, Viewers included, sees the reference: an
accepted exception to D-A for the reference only — the supplier and every other purchase detail still
follow `purchaseOrder:read`. Movements recorded earlier keep the fixed reason.

**The provisional decisions, confirmed:**

| Question | CEO, verbatim |
| --- | --- |
| Document extraction permissions: `purchaseOrder:write` + `ai:use`, human-only | "Compras + uso de IA (Recomendado)" |
| AI approvals: never-auto-approve and the "Approve all" exclusion stay purchase-only, not extended to the asset tools | "Solo Compras, como está (Recomendado)" |
| The bare `purchaseOrderLineId` visible under `asset:read` | "Dejarlo como está" |
| The *Inventory operator* preset with purchase read and write | "Sí, ver y editar (Recomendado)" |
| Over-receipt | "Avisar sin bloquear (Recomendado)" |
| A cancelled purchase can still receive and link | "Sí, sin trabas (Recomendado)" |
| Identifiability (a supplier, a reference or one line) and the *Purchase · date* title | "Sí, como está (Recomendado)" |
| *New purchase from a document* keeps its draft when abandoned | "Sí, que quede (Recomendado)" |
| Money displayed as entered, a third decimal refused, the "Read as" echo | "Sí, como está (Recomendado)" |
| Extraction providers, limits, PDFs in a new tab | "Sí, como está (Recomendado)" |
| The Spanish register (the Manual's AI pages in *voseo*, the rest in *tú*) | "Dejarlo como está" |
| The items planned but not built | "Un unico issues y sub-issues de ese" (one issue, with sub-issues of it) — #1495, sub-issues #1496–#1503 |

## 6. Drop a document to start a purchase (2026-10-03, #1516)

After seeing a promo video in which the invoice is dropped on *New purchase*, the CEO asked for it as a
feature.

CEO, verbatim: "me gusta la feature de tirar la factura en el new purchase y que ya empiece a cargar con una
buena animacion... No estaria mal agregarlo" (I like dropping the invoice on New purchase and having it start
loading right away with a good animation… it wouldn't hurt to add it).

| Question | CEO, verbatim |
| --- | --- |
| Where the drop is accepted | "New purchase y la lista de Compras" (New purchase and the Purchases list) |
| The motion | "Soltar + escaneo al leer" (drop + a scan while reading) |

**As built.** Dropping a PDF or image on *New purchase* or the Purchases list is the same as picking it with
*New purchase from a document*, and goes through the same pipeline: a `DRAFT` purchase named after the file,
the file attached, the review opened with `?read=1`, which reads it at once. Dropping is therefore consent
to the read, exactly like picking — the drop target repeats that the file goes to the AI provider. The drop
target exists only where the button would (`purchaseOrder:write` and extraction available); one document is
read at a time (several dropped → the first one that can be read, said once); wrong-type and too-large files
are refused with the button's messages, the first file's when none can be read. A card with the document's name and size shows the steps — creating the purchase,
attaching the document, opening the review — and the review sweeps a line over the document (the image, or
the PDF card) while it is read. The motion is CSS only and stops under `prefers-reduced-motion`: no sweep,
no landing movement, the text says what is happening. No API, contract or CSP change.
