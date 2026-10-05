---
title: Taxonomies
category: configuration
subcategory: taxonomies
order: 2
---

# Taxonomies

**Taxonomies** are the controlled vocabularies that classify your records. Instead of letting anyone
type a free-text category, lazyit keeps a curated list per record kind so the same thing is always
named the same way — which keeps filtering, reporting and search consistent. You manage them all from
**Settings → Taxonomies** (administrators only).

## What you can manage

The Taxonomies screen is a single page with a tab bar. Each tab manages one kind:

- **Asset categories** — how assets are grouped (e.g. laptops, monitors, phones).
- **Application categories** — how applications are grouped.
- **Consumable categories** — how consumables are grouped.
- **Article categories** — how knowledge-base articles are filed.
- **Asset models** — the make/model records that assets reference (e.g. *Dell Latitude 5440*). A
  model carries the shared details, so individual assets only record what's unique to that unit.
- **Statuses** — your own names for the built-in asset statuses (see
  [Custom asset statuses](#custom-asset-statuses) below). Optional.

Each tab is its own create / edit list. Add a new entry, rename one, or remove one you no longer need.

**Removing several at once.** Tick the checkboxes on the rows you want to remove and use **Delete** in
the selection bar. lazyit deletes them one by one and reports the result — because a category that is
**still in use** (it has articles or sub-folders) is protected and cannot be removed, a batch can end
as a **partial success**: the free ones are deleted and the in-use ones are **kept and skipped**, with
a summary such as *"Deleted 3, 2 skipped (still in use)"*. The skipped rows stay selected so you can
reassign their records first and try again. (Bulk delete requires the category-delete permission; the
checkboxes only appear when you hold it.)

## Custom asset statuses

Every asset has one of six **built-in statuses** — Operational, In maintenance, In storage, Retired,
Lost and Unknown (see [Status](/help/assets-asset-basics#status)). They are fixed, and they are what
the dashboard, the filters, imports, reports and every other rule read. **Custom statuses** let your
team use its own words on top of them: *In repair at vendor* and *On the bench* can both be kinds of
*In maintenance*; *Loaner pool* and *Awaiting imaging* can both be kinds of *In storage*.

They are **optional**. If you never create one, nothing changes: assets keep using the built-in
statuses exactly as before, and even once you have some, any asset can keep a plain built-in status.

**How they map.** Each custom status belongs to exactly **one** built-in status. Giving an asset a
custom status also sets its built-in status to that one — so an asset in *Loaner pool* counts as
*In storage* everywhere a built-in status matters (the dashboard chart, the **In storage** filter,
reports). The **Statuses** tab shows this mapping directly: the six built-in statuses are fixed group
headings, and your custom statuses are listed under the one each belongs to.

**Creating and editing.** Use **New custom status**, or **Add** on a built-in status's heading to
start under it. A custom status has:

- **Name** — required, unique among the live custom statuses.
- **Built-in status** — the one it is a kind of.
- **Color** — optional. Pick one from the palette or type a `#RRGGBB` value; it colors the dot next
  to the name. Left empty, the dot uses the built-in status's color.
- **Description** and **Order** — optional. Order sorts the custom statuses within their built-in
  status (lower first).

The **Assets** column counts the assets using each custom status; click the number to open the
Assets list filtered to them.

**The built-in status is locked while it is in use.** You cannot move a custom status to another
built-in status while any asset uses it — those assets would silently change status. The field is
disabled and says how many assets use it. Move them to another status first, or create a new custom
status instead.

**Archiving one that is in use asks where its assets go.** When you archive a custom status that
assets still use, lazyit asks you to choose a destination — another custom status, or a plain
built-in status — and tells you how many assets will move. The move and the archive happen together,
and every moved asset gets an entry in its history. A custom status no asset uses archives with a
simple confirmation.

**Archived statuses** are listed under **Show archived** (administrators), where you can **Restore**
one. A restored custom status comes back with no assets — they were moved when it was archived.

Managing custom statuses uses the same permissions as the categories: viewing needs the
category-view permission, creating and editing the category-edit one, and archiving or restoring the
category-delete one.

## How taxonomies relate to records

A category or model is a **reference** that records point at — it is not the record itself. An asset
*belongs to* an asset category and *is a* model; it does not own a private copy of either. That is why
keeping the list curated matters: rename a category once and every record that references it follows.

Because records depend on these entries, lazyit protects them: it follows the same
**soft-delete and audit** rules as the rest of the domain, so removing a taxonomy entry does not
silently break the records that reference it. If an entry is in use, fix or reassign the records first.

## Where to manage related setup

- **Locations** are a sibling registry, reached from the Settings home rather than from a Taxonomies
  tab — they describe *where* assets are, not *what kind* they are.
- **Asset categories vs. models** — categories are broad buckets for grouping and filtering; models
  are specific make/model definitions. Use categories to slice your estate, and models to avoid
  re-typing the same hardware details on every unit.

For how models and categories drive the asset experience, see the Assets section of this manual.

## With the AI assistant

If the [AI assistant](/help/ai-assistant-overview) is on, you can also ask it to create, rename or edit
asset, application and consumable categories, to archive one, to edit, archive or restore asset models
and locations, and to create, edit, archive or restore custom asset statuses. Each change is proposed as a card you approve, and an archive card says what still uses the
entry before you decide. See [Approving changes](/help/ai-assistant-approvals#categories-models-and-locations).
