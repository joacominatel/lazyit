---
title: Consumables & categories
category: consumables
subcategory: consumables-categories
order: 1
---

# Consumables & categories

A **consumable** is a stock-counted supply — cables, adapters, toner, screws. Unlike an asset,
which lazyit tracks one piece at a time, a consumable is just a quantity on hand: you care about
*how many* you have, not *which one*. The list lives under **Consumables** in the sidebar.

## Add a consumable

Open **Consumables** and choose **New consumable**. A consumable has:

- **Name** — required, e.g. *USB-C to HDMI adapter*.
- **SKU** — optional part number. It is shown in monospace and is searchable, but does not have to
  be unique-looking; it just has to be unique among your live consumables.
- **Category** — optional grouping (see below). Picking one is what makes the **Category** filter on
  the list useful.
- **Reorder threshold** — optional. When the on-hand count drops to this number or below, the item
  is flagged as low stock. See [Low-stock alerts](/help/consumables-low-stock-alerts).
- **Unit** — the unit of measure (*units*, *meters*, *boxes*…). It is a plain label that rides along
  with the count everywhere it is shown; it does not change any maths.
- **Description** and **Notes** — optional free text.

Stock does **not** start as a field you type. A new consumable begins at **0** on hand, and the
count only ever moves through stock movements — never by editing the consumable. See
[Stock movements](/help/consumables-stock-movements).

## The list

The consumables list shows the name, category, current **Stock**, unit, SKU and when each item was
last updated. The stock figure is colour-coded:

- **Green** — in stock.
- **Amber** — low stock (at or below the reorder threshold).
- **Red** — out of stock (0 on hand).

You can search by name or SKU, and filter by **Category** or by **Low stock only**. Each row also
carries the quick `−1` / `+1` buttons for adjusting the count in place.

## Categories

Categories (Cables, Adapters, Peripherals, Office supplies, Other, …) are an optional grouping you
manage yourself. They are **not** set up on the consumable form — you create and edit them under
**Settings → Taxonomies**, on the Consumables tab. lazyit ships a small starter set; rename, add to
or remove it to suit your estate.

A few things worth knowing:

- A consumable can have **one** category, or none.
- **Deleting a category does not delete its consumables.** Each consumable that pointed at it simply
  becomes uncategorised — nothing is lost. (This differs from some other parts of lazyit that block
  a delete while things still reference the item.)
- Categories are **soft-deleted** and a deleted name is freed for reuse, so you can recreate or
  restore one later without a clash.

## Editing, cloning and removing

From a consumable's detail page or its row menu you can **Edit**, **Clone** or **Delete** it.

- **Clone** opens a new consumable pre-filled from the original. The SKU is cleared and the stock
  starts at zero — handy for stocking a near-identical part.
- **Delete** is a soft delete: the consumable is archived, not erased, and its movement history is
  preserved. Administrators can switch the list to the archived view and **Restore** it.
