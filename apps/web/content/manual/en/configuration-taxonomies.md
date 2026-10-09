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

The Taxonomies screen has two panes. On the left, every taxonomy is listed by module with how many
entries it has; pick one and it opens on the right. (On a phone the list is a picker at the top.)

- **Assets**
  - **Categories** — how assets are grouped (e.g. laptops, monitors, phones).
  - **Models** — the make/model records that assets reference (e.g. *Dell Latitude 5440*). A model
    carries the shared details, so individual assets only record what's unique to that unit.
  - **Custom statuses** — your own names for the built-in asset statuses (see
    [Custom asset statuses](#custom-asset-statuses) below). Optional.
- **Applications → Categories** — how applications are grouped.
- **Consumables → Categories** — how consumables are grouped.
- **Knowledge → Folders** — a link to the Knowledge Base. Articles are filed in **folders**, and you
  create, rename and order them in the Knowledge Base itself, not here. See
  [Folders & access](/help/knowledge-base-folders-access).

Each entry is one compact row: its **name**, its description in muted text when it has one, how much
it is **in use** — *42 assets*, *5 apps*, *3 consumables*, or *Unused* — and a **⋯** menu. For a category,
the count is how many records will **lose their category** if you delete it. (Right after an update,
before the server reports counts, the column stays empty rather than guessing.)

- **Add** — type a name in the **New category…** row at the bottom of a category list and press
  **Add** (or Enter). Models and custom statuses have more fields, so they keep a **New** button that
  opens their full form.
- **Edit** — **⋯ → Edit** opens the full form: name, description, icon, order and, for asset
  categories, the [specs dictionary](/help/assets-models-categories).
- **Duplicate** — **⋯ → Duplicate** opens a new entry pre-filled from this one.
- **Delete** (categories, models) or **Archive** (custom statuses) — from the same menu, with a
  confirmation.
- **Filter** — the filter box above each list narrows it by name or description.

**What deleting a category does.** Deleting an asset, application or consumable category is a
**soft delete**: the category is hidden, never erased, and it can be restored. lazyit does **not** stop
you from deleting a category that is in use. The records filed under it keep all their data, but they
show **no category** until the category is restored or you file them under another one. The
confirmation says how many records that is (*Used by 42 assets — they keep their records but show no
category until it is restored*). There is no list of deleted categories in Settings yet; an
administrator can restore one through the API (`POST /api/asset-categories/{id}/restore`, and the same
under `application-categories` and `consumable-categories`).

**Removing several categories at once.** Choose **Select** above the list to show a checkbox on each
row, tick the ones you want to remove and use **Delete** in the selection bar. The confirmation names
the selected categories that are in use and how many records will show no category in all. lazyit
deletes them one by one and reports the result; if a request fails (a lost connection, say), that row
stays selected and the summary says how many could not be deleted, so you can try again. **Done**
leaves selection.
(Bulk delete requires the category-delete permission; **Select** only appears when you hold it.)

Old links that opened a tab — `?tab=asset`, `?tab=models`, `?tab=statuses` and so on — still open the
same taxonomy. A link to the old *Article categories* tab now shows where to manage folders instead.

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
reports). The **Custom statuses** list shows this mapping directly: the six built-in statuses are fixed
group headings, and your custom statuses are listed under the one each belongs to.

**Creating and editing.** Use **New custom status**, or **Add** on a built-in status's heading to
start under it. A custom status has:

- **Name** — required, unique among the live custom statuses.
- **Built-in status** — the one it is a kind of.
- **Color** — optional. Pick one from the palette or type a `#RRGGBB` value; it colors the dot next
  to the name. Left empty, the dot uses the built-in status's color.
- **Description** and **Order** — optional. Order sorts the custom statuses within their built-in
  status (lower first).

Each custom status shows how many assets use it; click the count to open the Assets list filtered to
them.

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

Removing a taxonomy entry follows the same **soft-delete and audit** rules as the rest of the domain:
the entry is hidden, not erased, and the records that reference it are kept. A record whose category
was deleted simply shows none. Check the **In use** count before you delete, and file the records under
another entry first if they should keep one.

## Where to manage related setup

- **Locations** are a sibling registry, reached from the Settings navigation rather than from
  Taxonomies — they describe *where* assets are, not *what kind* they are.
- **Asset categories vs. models** — categories are broad buckets for grouping and filtering; models
  are specific make/model definitions. Use categories to slice your estate, and models to avoid
  re-typing the same hardware details on every unit.

For how models and categories drive the asset experience, see the Assets section of this manual.

## With the AI assistant

If the [AI assistant](/help/ai-assistant-overview) is on, you can also ask it to create, rename or edit
asset, application and consumable categories, to archive one, to edit, archive or restore asset models
and locations, and to create, edit, archive or restore custom asset statuses. Each change is proposed as a card you approve, and an archive card says what still uses the
entry before you decide. See [Approving changes](/help/ai-assistant-approvals#categories-models-and-locations).
