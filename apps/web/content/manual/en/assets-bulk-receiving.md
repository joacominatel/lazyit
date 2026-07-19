---
title: Receiving stock
category: assets
subcategory: asset-basics
order: 2
---

# Receiving stock

When a shipment of identical gear arrives — twenty of the same laptop, a box of monitors — you don't
have to fill in the new-asset form twenty times. **Receive stock** creates many assets from a single
model in one step, applying the same shared details to every unit and giving each one its own record.

You reach it from the **Assets** list: choose **Receive stock** in the top-right (you need permission
to create assets). It opens a short form.

## What you fill in

- **Model** (required) — the one model every unit is created from. Its name seeds each unit's default
  name, and its category and default specs come along just as they would on the single-asset form.
- **Quantity** (required) — how many units to create, from 1 up to the per-request maximum.
- **Status** — the state every unit starts in (for example *Operational* or *In storage*).
- **Location**, **Company**, **Purchase date**, **Purchase cost**, **Notes** — optional shared
  details applied to **every** unit. The purchase cost is entered per unit, in major units, exactly
  like the asset form.
- **Serial numbers** — optional. Paste one serial per line, in order, and each unit gets the matching
  serial. Leave it blank to create serial-less units, or paste **exactly** as many lines as the
  quantity — a mismatched count is rejected before anything is created.

Auto asset tags still apply: if your instance uses an [asset-tag scheme](/help/configuration-asset-tag-scheme),
each unit is tagged automatically as it is created.

## Partial success is normal

Each unit is created **individually** — its own record, its own asset tag. That means a receive can
**partly** succeed: most units land while a few fail, most often because a pasted serial collides with
one that already exists. This is by design, not an error.

When the receive finishes, lazyit shows you the outcome:

- **How many assets were created** — these are already in your inventory.
- **A list of any units that couldn't be created**, each with its position in the batch and the
  reason (for example a duplicate serial). Fix those and receive them again separately.

Even if **every** unit fails, that is reported as a result to read — not a lost request. Nothing you
see in the "created" count is ever rolled back by a later failure in the same batch.

From the result you can jump straight to the new assets (the inventory filtered to that model),
**receive more**, or close.

## When to use import instead

Receiving stock is for **new** units of a model you already have. To load an **existing** estate from
a spreadsheet or a legacy tool — many different models, with their own serials and owners — use the
[bulk importer](/help/assets-bulk-import) instead.

## What's next

- [Asset basics](/help/assets-asset-basics) — the single-asset form and everything on an asset.
- [Assignments & history](/help/assets-assignments-history) — hand a received asset to its owner.
