---
title: Models & categories
category: assets
subcategory: models-categories
order: 1
---

# Models & categories

Models and categories let you describe your assets once at the type level instead of repeating the
same facts on every unit. You manage both under **Settings → Taxonomies**.

## Asset models

An **asset model** is a generic make/model — for example "Dell Latitude 7440" or "Cisco Catalyst
9300". It holds the facts every unit of that model shares, so individual assets don't have to repeat
them.

A model has a **name** (required), a **manufacturer** (required), an optional **SKU**, an optional
description, an optional **category**, and optional **default specs**.

The **manufacturer** field suggests the manufacturers your other models (and, if you can see purchases,
your purchase lines) already use — most used first, with how many records use each — and points out when what you typed is another spelling of an existing
one (for example `DELL` or `Dell Inc.` for `Dell`), so one brand doesn't end up split in two. It works
like the asset's [Company](/help/assets-asset-basics) field, and you can still type a new manufacturer.

- **Default specs** are key/value defaults — for example "ships with 16GB". When you create an asset
  and pick this model, those defaults are copied into the new asset's
  [custom fields](/help/assets-asset-basics) as a starting point. You can then change them for the
  individual unit before saving.
- A model's specs are a **snapshot at creation time**: editing a model later does **not** rewrite the
  custom fields of assets already created from it, and an asset's own values always win over the
  model's defaults.
- **SKU** is unique among live models when set, the same way a serial is for assets.
- The **SKU** and the **description** can be removed later too: when editing a model, empty the field
  and save, and the model no longer has one.
- The **category** is optional and can be removed later: when editing a model, pick **No category** at
  the top of the category list and save. The model (and every asset of it) is then uncategorized, so
  it no longer matches a category filter on the Assets list.

Manage models under **Settings → Taxonomies → Assets → Models**. The model picker in the asset form is
searchable, so a long catalog stays easy to use.

## Asset categories

An **asset category** classifies your models — for example Laptop, Desktop, Server, Switch, Firewall.
Categories drive grouping and the category filter on the Assets list.

- A category has a **name** (required, unique among live categories), an optional description and an
  optional icon.
- lazyit ships with a **starter set** seeded for you (Server, Switch, Router, Firewall, Laptop,
  Desktop, Mobile, Printer, Storage, UPS, Peripheral, Other). These are ordinary categories — rename,
  edit or remove them like any other; they are not special.
- A model points at a category, and an asset inherits its category **through its model**. The category
  filter on the Assets list matches an asset by its model's category.

Manage categories under **Settings → Taxonomies → Assets → Categories**.

### Specs dictionary (field hints)

A category can also declare an optional **specs dictionary** — a list of the
[custom fields](/help/assets-asset-basics) you expect on assets of that type (for example, every
Server should carry `cpu`, `ramGb` and a `formFactor`). It's a lightweight consistency aid, not a
straitjacket.

- Each field has a **key** (the custom-field name it governs), a **label**, a **type** (text, number,
  yes/no, or a **choice** list), and can be marked **required**. A choice field lists its allowed
  values.
- The dictionary is **advisory**: when you edit an asset whose model belongs to this category, the
  declared fields are suggested as you type and lazyit shows **soft warnings** — a required field left
  blank, a value that doesn't match its type, a choice outside the list, or a custom field that isn't
  in the dictionary. **Nothing is blocked**: you can always save, and existing assets are never
  changed or invalidated.
- Leave the dictionary empty for no governance (the default) — any custom fields are accepted, exactly
  as before.
- Editing the dictionary later does **not** rewrite assets already saved; it only changes the hints
  shown next time someone edits one.

Set a category's dictionary from its editor under **Settings → Taxonomies → Assets → Categories**.

## How they fit together

The relationship is a simple chain:

**Category** classifies a **model**, and a **model** is what an **asset** is an instance of.

All three are optional links — an asset can exist with no model, and a model with no category — but
filling them in is what makes filtering, grouping and reporting useful.

## Removing a model or category

Models and categories are **soft-deleted**, never destroyed, and removing one never deletes anything
that points to it. When it is still in use, lazyit first shows you what will be affected and asks for
**one decision for all of it** — you cannot choose item by item.

**Removing a model** that still has **assets**, or **open purchase lines** mapped to it, offers:

- **Leave them without a model** — the assets keep their details but no longer have a model, and the
  purchase lines lose their model mapping.
- **Move them to another model** — everything goes to the model you pick. It can belong to another
  category: an asset's category comes from its model, so the assets then show that category.
- **Create a new model** — type a name: lazyit creates it with the same manufacturer and category as
  the one you are removing, then moves everything there. This choice appears only if you can also
  create models.

**Removing a category** that still has **models** offers the same three choices for those models:
leave them without a category, move them to another category, or create a new category and move them
into it. Their assets follow their model, so the dialog also counts the assets whose category changes.

The dialog names up to 50 of each kind and counts all of them. If you are not allowed to view a kind
(purchases, say), you see only how many there are — the decision still applies to them.

The move and the removal happen together, and every asset moved off a model gets a model change in its
history. Records that are already history keep pointing at the removed model or category: archived
assets and models, purchase lines already received, and the lines of cancelled purchases. A model or
category nothing points to is removed straight away.

An admin can bring a removed model back from the archived view. Restoring a model or category does not
bring back what was moved off it. Restoring a model whose category is still removed is refused — restore
the category first.

## What's next

- [Asset basics](/help/assets-asset-basics) — register and edit the individual units.
- [Locations](/help/assets-locations) — track where assets live.
