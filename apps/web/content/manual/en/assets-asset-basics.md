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
- **Company** — optional grouping label (see *Company* below).
- **Purchase date** and **Warranty end** — optional dates.
- **Purchase & depreciation** — optional cost fields (see *Cost & depreciation* below).
- **Notes** and **Custom fields** — optional free-form detail.

Under **Head start** you can optionally **assign the first owner** right away: pick a user and, when
you create the asset, they're recorded as its current owner in the same step. Leaving it blank keeps
the classic flow — ownership is otherwise a separate step you take once the asset exists (see
[Assignments & history](/help/assets-assignments-history)). If the assignment part fails for any
reason, the asset is still created; you'll just be asked to assign the owner from the asset.

Something a purchase is waiting for? When a [purchase](/help/purchases-recording-purchases) still waits for
units, the form opens with a **From purchase** picker: choosing a line opens
[Receive stock](/help/assets-bulk-receiving#receiving-against-a-purchase) for it, so the unit is created
already linked to its purchase, with the purchase's values. You see it only if you can view and edit
purchases.

Registering a batch of similar units? Use **Create & add another** instead of **Create asset**: it
saves the current one and keeps the form open with the **model, location, company and status**
carried over, clearing just the name, serial and asset tag so you can type the next unit straight
away.

## Registering many at once

If you have a whole spreadsheet of gear to bring in, don't type them one by one — use the bulk
**Import**. The **Import** button sits next to *Export* at the top of the Assets list (and the empty
Assets screen offers an *Import from CSV* link), taking you straight to the guided
[bulk import](/help/assets-bulk-import) wizard. The button appears only if you have permission to run
an import.

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
asset's activity log. You can change it quickly without opening the editor: on the **detail page**
the status badge itself is a dropdown, and in the list the row's **⋯** menu has a **Change status**
option. You can also set the status of several assets at once from the list: select them and pick one
under **Set status** in the selection bar.

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

## Company

**Company** is an optional grouping label on an asset — a way to tag which organization, business
unit or client an asset belongs to (handy if you manage gear for several clients, or split kit by
legal entity). It is **only for grouping, filtering and reporting**: it is **not** an access control.
Company does not hide anything — anyone who can see assets sees *all* assets regardless of their
company; setting it simply lets you narrow the list to one company when you want to.

It is a free-text field with **suggestions**, so you reuse the same spelling instead of creating
near-duplicates:

- **When you click into it**, lazyit lists the companies *you* used most recently (remembered in this
  browser), then the other companies already in use — most used first, with how many records use each
  and when one was last used. Companies typed on [purchases](/help/purchases-recording-purchases) are
  suggested too, if you can see purchases.
- **As you type**, the closest matches come first: a company that starts with what you typed, then one
  where a word starts with it, then one that contains it — and even a close misspelling.
- **With the keyboard**, **↓** opens the list, **↑**/**↓** move through it, **Enter** or **Tab** takes the
  highlighted company, and **Esc** closes the list and keeps what you typed. When the best match
  completes what you are typing, it is highlighted for you, so **Enter** or **Tab** finishes the word;
  **Ctrl+Enter** (**⌘+Enter** on a Mac) keeps your text exactly as typed instead.

You can always type a brand-new value — a suggestion is never forced. If what you typed is just another
spelling of a company already in use (different capitals or accents, punctuation, or a legal suffix
such as "S.A." or "Inc."), a hint below the field says so and offers a button to use the existing
spelling. It is only a hint: ignore it and your value is saved exactly as typed.

There is no separate "companies" screen to manage: a company exists simply because at least one asset
uses it.

On the asset detail page the company is shown when set, and links to the list filtered by that
company. You can filter and add a **Company** column to the list (see below).

## Cost & depreciation

Under **Purchase & depreciation** you can optionally record what an asset cost and how long it's
expected to serve. All the fields are optional — leave them blank for gear whose value you don't
track.

- **Purchase cost** — what you paid for the unit.
- **Currency** — an optional label for the amounts, as your team writes it (`ARS`, `USD`, `u$s`…). It
  suggests the labels already in use. lazyit never converts or interprets it; it only prints it in front
  of the cost.
- **Useful life** — how long you expect to use it, **in months** (for example `36` for three years).
- **Salvage value** — its estimated worth at the end of that life. Defaults to **0** if left blank.

When a purchase cost is set, the asset's detail page shows a **Book value** — the asset's worth
**today** under **straight-line depreciation**: the value falls in equal steps from the purchase cost
down to the salvage value across the useful life, then holds at the salvage value. If you set a cost
but no useful life, the book value simply stays at the purchase cost (there's nothing to depreciate
over). Assets with no purchase cost show no book value at all.

An asset with a cost but no currency label shows its cost as **No currency** — its own visible state,
never a default currency. Assets recorded before currency labels existed read this way until someone
sets one. The book value carries the same label as the cost.

### Entering amounts

Type an amount the way numbers are written in the language you use lazyit in:

| Language | Accepted | Not accepted |
| --- | --- | --- |
| English | `1,234.56` · `1234.56` · `1500` | `1.234,56` |
| Spanish | `1.234,56` · `1234,56` · `1500` | `1,234.56` |

Use at most **two decimals**, and leave out currency signs and minus signs. lazyit never guesses: if an
amount can't be read in your language's format — `1,234.56` while lazyit is in Spanish, or a third
decimal that is most likely a mistyped thousands separator — it says so below the field when you leave
it, and the form isn't saved until you fix it. Once read, the amount is rewritten in the standard form
(`1234,5` becomes `1.234,50`), so you can see it was understood. One shape reads differently between
languages — a single separator followed by exactly three digits, such as `1.150` in Spanish or `1,150`
in English. lazyit reads it as thousands and says so under the field, for example *Read as 1150*.

Amounts are **shown as entered**, with your language's separators: a whole amount has no decimals
(`1,500` in English, `1.500` in Spanish) and an amount with cents shows two (`1,234.56` / `1.234,56`).

## Custom fields

Different kinds of asset carry different attributes — a laptop has RAM and a CPU, a switch has a port
count and an IP. Rather than force a fixed set of columns, lazyit stores these as **custom fields**:
a free-form list of name/value pairs on the asset (for example `ram` → `16GB`, `ip` → `10.0.0.4`).

Add, edit or remove rows in the **Custom fields** section of the form. When you pick a model that has
default specs, those values are copied in as a starting point — you can change them for this
individual unit before saving. Custom fields are shown as a tidy label/value list on the detail page.

If the asset's category defines a
[specs dictionary](/help/assets-models-categories), the form **suggests** those expected fields and
shows gentle **warnings** (a required field left blank, a value that doesn't match its type, or an
unexpected field). These hints are advisory only — you can always save.

## Finding assets in the list

The **Assets** list has a search box and a **Status** dropdown right in the toolbar, plus a
**Filters** button that opens a small panel for the rest. The search box matches an asset's name,
serial, asset tag, and its model's name or manufacturer — so searching a model like "ThinkPad" or
"Pro 14" finds every asset carrying it, even though the model isn't in the name.

- **Category** and **Location** — narrow to one model category or one place.
- **Company** — narrow to one company (the grouping label above). Only companies in use appear.
- **Owner** — show only the assets currently assigned to a specific person. Start typing a name to
  pick them; the list then shows just that person's live assignments.
- **Ownership** — filter by whether an asset has any current owner at all (*Has owners* /
  *No owners*), regardless of who.
- **Warranty** — narrow to assets whose **warranty is about to lapse** (*Expiring ≤ 90d*) or has
  **already lapsed** (*Expired*). This filter has no toolbar control: it appears as a chip when you
  arrive from the dashboard's **Needs attention** warranty tile (which links to *Expiring ≤ 90d*),
  and you clear it by removing the chip.

The **Filters** button shows a small count of how many of these are active. Every filter you set
also appears as a removable chip below the toolbar, and the filters live in the page address, so a
filtered view is easy to undo, share or bookmark.

On the asset detail page, both **Model** and **Category** are links back into this list: Model
narrows to that exact model, Category to every model in that category — a quick way to see "what
else is this exact model" versus "what else is in this category."

### Exporting the inventory

The **Export (filtered)** button at the top of the Assets page downloads a **CSV** of the inventory
that matches your **current filters** — the whole result set, not just the page in front of you. Set
the status, category, location, company, owner or search you care about first (for example *all the
Dell servers in the colo that are out of warranty*), then export just that slice. The file carries one
row per asset with its name, asset tag, serial, status, category, manufacturer, model, location,
company, purchase and warranty dates, current owners, notes, the created/updated timestamps, the
**purchase cost** (as a plain number with a dot for decimals, so a spreadsheet reads it) and its
**currency** label — and, only if you can view [purchases](/help/purchases-recording-purchases), the
asset's **supplier**, **purchase reference** and **invoice numbers**, as the last columns. Without that
permission those three columns are left out of the file entirely. It is safe to open in a spreadsheet. Custom **specs** fields are not included in this version. If you have
the *Show archived* view open, the export is that archived slice instead.

### Choosing which columns to show

The **Columns** button (next to *Filters*) opens a checklist of the table's columns, in groups:

- **Details** — asset tag, serial, manufacturer (from the asset's model), model, category, location
  and company.
- **Status** — status and owners.
- **Purchase & warranty** — purchase date, warranty end and purchase cost.
- **Activity** — updated.

Untick the ones you don't care about to slim the table down, or tick more to bring them in. Out of the
box the table shows asset tag, model, category, location, company, status, owners and updated; **serial**,
**manufacturer** and the **Purchase & warranty** columns stay off until you turn them on. The **Name**
column and the row actions always stay. Your choice is remembered in this browser, so the table keeps the
same shape next time you visit.

**Purchase cost** shows the amount as it was entered, with its currency label (for example *USD 1,500*).
An amount recorded without a label reads **No currency** beside it — lazyit never assumes a currency.
Click the **Serial**, **Purchase date**, **Warranty end** or **Purchase cost** header to sort the whole
list by it; costs sort by amount alone, whatever their label. **Manufacturer** cannot be sorted.

On a phone the asset cards always show the usual details, plus any of the serial, manufacturer and
purchase & warranty columns you have turned on.

## Where it was bought

If the asset is linked to a [purchase](/help/purchases-recording-purchases), its page shows a **Purchase**
panel right after *Details*: the purchase and its supplier, the reference, dates and invoice numbers, the
supplier's support contact, and the purchase's documents to download. It is shown **only to people who
can view purchases**; everyone else keeps seeing the asset's own cost and dates in *Details*, as before.
The panel marks **Differs from purchase** when the asset's cost is not the price on its purchase, and
offers **Unlink from purchase** to those who can edit purchases and assets. An asset that is not linked
offers **Link to purchase** there instead. See
[Purchases — The asset's Purchase panel](/help/purchases-recording-purchases#the-assets-purchase-panel).

## Assets on the topology map

If an asset backs a node on the [Infrastructure diagram](/help/assets-topology-diagram) — for
example a host, a NAS or a switch you've placed on the map — its detail page shows an **On topology**
badge next to the status, and the same marker appears as a small share glyph beside the asset's name
in the list. A **View in topology** button on the detail page jumps straight to the map, flying to
that node and giving it a brief highlight so you can spot which one it is at a glance. (You only see
these when you have permission to view the topology.) The reverse link exists too: a node's details
panel links its *inventory name* back to this asset, so you can move between an asset and its node in
either direction.

## Documents

An asset can carry **documents** — warranty PDFs, purchase receipts, damage photos — kept on the
asset record instead of scattered across drives and chat threads. The **Documents** section on the
asset's detail page lists them with their name, size and upload date.

- **Upload** with the button, or **drag and drop** files onto the section. Supported types are
  **PDF, PNG, JPEG, WebP, GIF, TXT, CSV, DOCX and XLSX**, up to **25 MB** each.
- **Download** opens the file. Documents are served **only** to people who can read the asset — they
  are never on a public link.
- **Delete** removes a document after a confirmation. Like the rest of lazyit this is reversible at
  the storage layer; the record of who uploaded it is kept.
- Uploading and deleting need the asset-write permission; anyone who can view the asset can download.
- **Type** — optional, free text (*Invoice*, *Warranty*, *Delivery note*…), suggested from the types
  already used. Fill it before uploading, or set, change or clear it later with the pencil on the
  document. It shows next to the file name.

> **Backups.** Attachments are stored on the server's file volume, which is **not yet covered by the
> database backup**. Until backup support ships, keep an independent copy of anything irreplaceable.

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
