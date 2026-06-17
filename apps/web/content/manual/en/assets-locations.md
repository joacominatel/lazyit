---
title: Locations
category: assets
subcategory: locations
order: 1
---

# Locations

A **location** is where an asset physically lives — an office, a datacenter, a rack, a warehouse, or
"remote / with an employee". Locations answer half of the core inventory question: not just *what* do
we have, but *where is it*. You manage them from the **Locations** area.

## Adding a location

Open **Locations** and create a new one. A location has:

- **Name** — required.
- **Type** — required; every location is classified (see below).
- **Description**, **Address**, **Floor** and **Notes** — all optional free text.

Floor is a **label, not a number** — values like "Ground", "Basement 1" or "Mezzanine" are fine.

## Location types

Each location is classified by a type, chosen from a fixed set:

- **Office**
- **Datacenter**
- **Rack**
- **Remote** — for assets that aren't at a fixed site (for example a laptop out with an employee).
- **Storage**
- **Other**

Locations are **flat** — there is no site → room → rack nesting. For a small team a flat list is
usually enough; if you need hierarchy, model it in the name (for example `HQ — Rack A3`).

## Assigning a location to an asset

You set an asset's location on the asset form — it is one of the optional fields when you register or
edit an asset. See [Asset basics](/help/assets-asset-basics). A location is optional: an asset can
exist without one.

Changing an asset's location is recorded in that asset's activity log, so you can see when a unit
moved.

## The "assets here" view

Open a location to see its details together with the **assets currently at that location** — the
inventory physically located there. This is the quick answer to "what's in this rack?" or "what's at
the branch office?".

## Removing a location

Locations are **soft-deleted**, never destroyed. Removing a location does **not** delete the assets
that point to it — those assets simply become location-less for that link, and the record is kept for
history. lazyit favors auditability over strict tidiness.

## What's next

- [Asset basics](/help/assets-asset-basics) — register units and set their location.
- [Models & categories](/help/assets-models-categories) — classify what the asset is.
