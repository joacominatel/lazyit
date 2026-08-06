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
  If the model doesn't exist yet, create it right here — see below.
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

## Creating the model without leaving the form

Most shipments arrive *because* something new was bought, so the model you need often doesn't exist
yet. Use the **+** next to the model picker: it opens a small **New model** dialog on top of the form.

- It appears only if you have permission to manage models. Without it, pick from the existing models.
- A model needs a **name** and a **manufacturer**. If you had already typed a search term in the
  picker, the name starts pre-filled with it — so you don't create a near-duplicate of a model that
  was simply spelled differently.
- **Category is optional**, and you can only choose one that already exists. Creating a category here
  is deliberately not offered: a typo would otherwise leave a ghost category behind. Add categories
  under [models & categories](/help/assets-models-categories) when you need a new one.
- On **Create**, the dialog closes, the new model is selected, and **everything you already typed —
  quantity, status, location, serials — is still there.** Cancelling or pressing Escape closes only
  that dialog and changes nothing on the form.

The model is a record in its own right: once created it stays in your catalogue and is reusable, even
if you then cancel the receive or the receive fails.

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

Receiving stock is for **new** units of a **single** model — one you already have, or one you create
on the spot from the form. To load an **existing** estate from
a spreadsheet or a legacy tool — many different models, with their own serials and owners — use the
[bulk importer](/help/assets-bulk-import) instead.

## What's next

- [Asset basics](/help/assets-asset-basics) — the single-asset form and everything on an asset.
- [Assignments & history](/help/assets-assignments-history) — hand a received asset to its owner.
