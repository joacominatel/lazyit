---
title: "Purchases — CEO inputs and decisions"
tags: [purchases, decisions, ceo]
status: accepted
created: 2026-10-01
updated: 2026-10-01
---

# Purchases — CEO inputs and decisions

> The CEO's inputs to the design and the package approved on 2026-10-01, with the CEO's words quoted
> verbatim. The decision record built from this note is
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
   carries a user-chosen currency; no exchange rates; never sum across currencies.
4. Purchase status: the user sets DRAFT / ORDERED / CANCELLED; "partially received" and "received" are
   derived from linked assets plus cancelled units per line. No receipt ledger.
5. PO number (reference): optional, unique per supplier among live rows when set. No auto-numbering in
   v1.
6. Viewer role: Purchases read denied by default (grantable per role). Delete/restore ADMIN-only.
7. The application "Vendor" field is relabelled "Publisher" (en) / "Fabricante" (es). Label only.
8. The feature is an instance switch, OFF by default. Turning it off hides Purchases, deletes nothing,
   and assets keep showing their purchase read-only.
9. AI: extraction produces a draft that a human always reviews; a separate "Document extraction" switch
   under AI settings, OFF by default, with disclosure; purchase changes are never auto-approved.
   Extraction reads a document already attached to the purchase (no chat upload).
10. Back up the attachments volume before or alongside Phase 1.
11. Money widening: money amounts move from int4 to 64-bit integers (minor units) — the new purchase
    tables and the existing `Asset.purchaseCost` / `salvageValue` and `Application.costPerSeat`.
    Widening is non-destructive. Amends [[0036-int4-bounded-integers|ADR-0036]] and
    [[0088-application-license-seat-tracking|ADR-0088]] → [[0100-money-as-64-bit-minor-units|ADR-0100]].

**UX-proposal defaults accepted with the package:** the name "Purchases" / "Compras" under Inventory;
optional header fields (delivery location, company, invoice numbers, invoice date, expected date);
supplier tax ID plus a support/RMA contact; consumable lines in Phase 1b and license lines in Phase 2
(propose, never auto-change seats); smart entry applies with the feature ON or OFF; the assets CSV gains
cost, currency, supplier, PO and invoice numbers in a locale-aware format; leases out of v1.

## 3. Where each decision is recorded

| Decision | Recorded in |
| --- | --- |
| 1, 2, 3, 4, 5, 6, 8, 9, 10 and the accepted defaults | [[0099-purchases-scope-model-and-optionality|ADR-0099]] |
| 7 | ADR-0099 §13, [[application]], [[0088-application-license-seat-tracking|ADR-0088]] amendment |
| 11 | [[0100-money-as-64-bit-minor-units|ADR-0100]] |
| Smart entry (input 1) | ADR-0099 §7, [[purchases/ux-proposal]] §4 |
