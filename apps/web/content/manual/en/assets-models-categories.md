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

- **Default specs** are key/value defaults — for example "ships with 16GB". When you create an asset
  and pick this model, those defaults are copied into the new asset's
  [custom fields](/help/assets-asset-basics) as a starting point. You can then change them for the
  individual unit before saving.
- A model's specs are a **snapshot at creation time**: editing a model later does **not** rewrite the
  custom fields of assets already created from it, and an asset's own values always win over the
  model's defaults.
- **SKU** is unique among live models when set, the same way a serial is for assets.

Manage models under **Settings → Taxonomies → Asset models**. The model picker in the asset form is
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

Manage categories under **Settings → Taxonomies → Asset categories**.

## How they fit together

The relationship is a simple chain:

**Category** classifies a **model**, and a **model** is what an **asset** is an instance of.

All three are optional links — an asset can exist with no model, and a model with no category — but
filling them in is what makes filtering, grouping and reporting useful.

## Removing a model or category

Models and categories are **soft-deleted**, never destroyed. Removing one does **not** delete or
break the assets that reference it — those assets simply keep their snapshot and become unclassified
for that link. This keeps your history intact: lazyit favors auditability over strict tidiness.

## What's next

- [Asset basics](/help/assets-asset-basics) — register and edit the individual units.
- [Locations](/help/assets-locations) — track where assets live.
