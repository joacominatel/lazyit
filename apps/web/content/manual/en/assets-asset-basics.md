---
title: Asset basics
category: assets
subcategory: asset-basics
order: 1
---

# Asset basics

An **asset** is a single thing your team owns and is accountable for — a laptop, a server, a switch,
a monitor, a license. In lazyit the asset is the first-class record: people come and go, but the
asset stays, and its whole history travels with it. You manage assets from the **Assets** area.

## Registering an asset

Open **Assets** and choose **New asset**. The form captures:

- **Name** — required, your own label for the unit (for example `Ada's laptop` or `SW-CORE-01`).
  lazyit does not enforce a naming convention; pick one that suits your team.
- **Status** — required (see below).
- **Model** — optional. Link the asset to an [asset model](/help/assets-models-categories) (its
  make/model). Picking a model can pre-fill custom fields from the model's defaults.
- **Location** — optional. Where the unit physically lives. See
  [Locations](/help/assets-locations).
- **Serial** and **Asset tag** — both optional (see *Serial and asset tag* below).
- **Purchase date** and **Warranty end** — optional dates.
- **Notes** and **Custom fields** — optional free-form detail.

You do not assign an owner here. Ownership is a separate step you take once the asset exists — see
[Assignments & history](/help/assets-assignments-history).

## Status

Every asset is **classified by a status** — there is no default, so you choose one when you register
it. The values are:

- **Operational** — in active service.
- **In maintenance** — temporarily out for repair or servicing.
- **In storage** — kept in stock, not currently in use.
- **Retired** — decommissioned, kept for the record.
- **Lost** — unaccounted for.
- **Unknown** — status not established.

Status appears as a colored badge in the list and on the detail page. Changing it is recorded in the
asset's activity log. You can also set the status of several assets at once from the list.

## Serial and asset tag

These are two different things, and both are optional:

- **Serial** — the manufacturer's serial number of the physical unit.
- **Asset tag** — your own company label, the one you write on the sticker (for example `LZ-0001`).

Each is **unique among live assets** when set: if you try to save a serial or asset tag that another
live asset already uses, lazyit refuses it. When an asset is deactivated, its serial and asset tag
are freed, so the value can be reused or restored later.

The asset tag is **not** the asset's internal identity — lazyit keeps a separate, permanent internal
id for links and references. The asset tag is a human-facing label you can change at any time. If you
want lazyit to assign asset tags automatically from a running number, see
[Asset tags](/help/assets-asset-tags).

## Custom fields

Different kinds of asset carry different attributes — a laptop has RAM and a CPU, a switch has a port
count and an IP. Rather than force a fixed set of columns, lazyit stores these as **custom fields**:
a free-form list of name/value pairs on the asset (for example `ram` → `16GB`, `ip` → `10.0.0.4`).

Add, edit or remove rows in the **Custom fields** section of the form. When you pick a model that has
default specs, those values are copied in as a starting point — you can change them for this
individual unit before saving. Custom fields are shown as a tidy label/value list on the detail page.

## Editing, cloning and deactivating

- **Edit** updates the asset in place; each meaningful change (status, location, model, custom
  fields) is written to the activity log.
- **Clone** opens a new asset pre-filled from this one, with the serial and asset tag cleared so the
  copy gets its own — handy for registering a batch of identical units.
- **Deactivating** an asset is a soft delete: the record is hidden from the normal list but never
  destroyed, so its history is preserved. Deactivated assets can be **restored** by an administrator,
  which also reclaims their freed serial and asset tag (unless a live asset has taken the value
  meanwhile). lazyit never hard-deletes asset data.

## What's next

- [Models & categories](/help/assets-models-categories) — group and classify your assets.
- [Locations](/help/assets-locations) — track where things live.
- [Assignments & history](/help/assets-assignments-history) — record who holds an asset over time.
- [Asset tags](/help/assets-asset-tags) — auto-assign running asset tags.
