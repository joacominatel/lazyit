---
title: Quick view
order: 1
category: notifications-activity
subcategory: quick-view
---

# Quick view

Quick view is a small **eye** that appears on each row of the entity pickers — the dropdowns you use
to choose an asset, a person, a model, an application or a location while assigning, granting access
or linking a record. It opens a generous preview of that row **without leaving what you are doing**,
so you can tell two similar-looking entries apart before you pick one.

It exists because a picker row is necessarily terse: an asset shows as a name, a person as "Juan D.",
a model as "Dell Latitude". When two rows look alike — two laptops with the same model, two people
with the same first name — the eye lets you confirm which is which in place.

## Opening a preview

Hover the mouse over a row and the **eye** appears at its right edge. There are two ways to use it:

- **Hover** the eye for a moment and a **preview** opens beside the row. Move away and it closes on
  its own. This is the quick "let me just check" glance.
- **Click** the eye (or press **Enter** / **Space** while the eye is focused) to **pin** the preview
  open. A pinned preview stays put until you dismiss it, and it adds an **"Open full record"** link.

Only one preview is open at a time — opening another row's eye closes the previous one.

## Using the keyboard

Quick view is fully keyboard-operable:

- Move through the list with the **↑ / ↓** arrows. The eye is revealed on the highlighted row.
- Press **Enter** or **Space** on the eye to open and pin the preview.
- Press **Esc** to close the preview; focus returns to the eye you opened it from, so you can keep
  navigating without losing your place.

## What a preview shows

The preview is tailored to the kind of record:

- **Asset** — serial and asset tag, model (manufacturer + name), category, location and its status.
- **Person** — email, role, username, file number, manager and how many assets and app accesses they
  currently hold, with their initials avatar.
- **Model** — manufacturer, SKU and description.
- **Application** — vendor, web address and description.
- **Location** — type, address, floor and description.

Empty values are simply left out, so the preview never shows a blank label.

## Opening the full record

When a preview is **pinned** and the record has its own detail page, an **"Open full record"** link
appears at the bottom. It opens that record's page in a **new tab**, so your current flow — the form
you were filling in — is never interrupted. Asset models and similar records that have no standalone
page don't show the link.

## What it never shows

Quick view reuses information the picker has **already loaded**, so opening a preview costs no extra
wait and no extra request. It is also deliberately limited:

- **Secrets are never shown.** A preview only ever references a secret by name, never its value.
- An application's **web address is shown as plain text**, and only when it is a safe address — an
  unsafe or scripted link is dropped rather than rendered.

Because the preview reflects the picker's summary of a record, a few detail-only fields (for example
an asset's full technical specs) aren't shown there — use **Open full record** to see everything.
