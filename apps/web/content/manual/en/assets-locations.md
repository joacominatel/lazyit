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
- **Parent location** — optional; nests this location under another (see [Nesting locations](#nesting-locations)).
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

## Nesting locations

Locations can be **nested** to mirror how your estate is really laid out — a **datacenter** contains
**racks**, a **site** contains **rooms**, and so on. Set a location's **Parent location** to hang it
under another; leave it as **top-level** for a standalone site. A location with no parent is a root.

On a location's page, a **breadcrumb** shows its full ancestry (for example `Datacenter → Rack A3`),
and each ancestor links to its own page. On an asset, the location field shows the **full path**, not
just the leaf, so you can see at a glance that a server lives in `HQ → DC1 → Rack A3`.

You can re-parent a location at any time by editing it and changing its parent, or promote it back to
top-level by choosing **None (top-level)**. A location **cannot** be nested under itself or under one
of its own descendants (that would create a loop) — lazyit rejects such a move and explains why on the
form. Nesting is optional: a flat list still works if you don't need the structure.

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

## Consumables left at a location

A location's page also has a **Consumables delivered** section: the supplies **left** there — a fire
extinguisher on floor 2, spare cables in a comms room — newest first, with the quantity and when. Use
**Deliver consumable** to record a new one, and **Return…** when a returnable item comes back. A
location is a destination only: lazyit keeps one stock count per consumable, not a count per place.
See [Stock movements](/help/consumables-stock-movements).

## Removing a location

Locations are **soft-deleted**, never destroyed, and removing one never deletes anything that points
to it. When the location still has **assets**, **child locations** or **open purchases** delivering
there, lazyit first shows you what will be affected and asks for **one decision for all of them** —
you cannot choose item by item:

- **Leave them without a location** — the assets lose their location, the child locations become
  top-level and the open purchases lose their delivery location.
- **Move them to another location** — everything goes to the location you pick. It must be a live
  location that is not inside the one you are removing.
- **Create a new location** — type a name: lazyit creates it with the same type and parent as the
  one you are removing (at the top level when that one has no parent or its parent was removed), then
  moves everything there. If the new location is created but the removal fails, the dialog says so
  and offers to move everything to it on the next try, so you never end up with two. This choice
  appears only if you can also create locations.

The dialog names up to 50 of each kind and counts all of them. If you are not allowed to view a kind
(purchases, say), you see only how many there are — the decision still applies to them.

The move and the removal happen together, and every moved asset gets a location change in its
history. Records that are already history keep pointing at the removed location: consumables
delivered there, purchases that are cancelled or fully received, and archived assets. A location
nothing points to is removed straight away.

An admin can bring a removed location back from the archived view. Restoring it does not bring back
what was moved off it. Restoring a location whose parent is still removed is refused — restore the
parent first.

## What's next

- [Asset basics](/help/assets-asset-basics) — register units and set their location.
- [Models & categories](/help/assets-models-categories) — classify what the asset is.
