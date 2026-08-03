---
title: Asset tags
category: assets
subcategory: asset-tags
order: 1
---

# Asset tags

An **asset tag** is the company label you write on a physical sticker — `LZ-0001`, `IT-2026-0042`. By
default you type each one by hand. lazyit can also assign them automatically from a running number, so
every new asset gets a consistent, never-colliding tag. This is the **asset tag scheme**, configured
under **Settings → Instance**.

> The scheme is **off until you turn it on**. With no scheme, asset creation is unchanged: the asset
> tag is whatever you type, or nothing. Turning it on is a deliberate setting.

## How the scheme builds a tag

A tag is built from three parts:

- a **prefix** (optional, for example `IT-`),
- a **number** — a running counter, optionally zero-padded to a fixed **width** (width 4 → `0042`),
- a **suffix** (optional, for example `-HW`).

So a prefix of `IT-` with width 4 produces `IT-0001`, `IT-0002`, and so on. The editor shows a live
**Next tag** preview as you type. The preview is the tag the next asset would really get: it applies
the same skip-existing rule as the allocator, so if the counter's number is already in use the
preview shows the free one that would be assigned instead, and tells you how many it stepped over.

> Because the preview never reserves a number, it is a read of *right now*, not a promise. If someone
> else creates an asset first, they take that tag and your next preview moves on.

With **Auto-assign asset tags** switched off, the same card is labelled **Tag shape** and carries no
number at all: it shows your prefix and suffix around a described slot — `IT-` then *4 digits*. With
the scheme off nothing is assigned, so there is no next tag to show, and printing one anyway would be
a value the allocator will never hand out.

If the preview can't reach the server it says so and offers a **Retry**, so a failed check never
looks like a slow one.

## Turning it on

Open **Settings → Instance → Asset tag scheme** and switch on **Auto-assign asset tags**. Set the
prefix, suffix and number width you want, optionally a **Start at** number to seed the counter, then
**Save scheme**. Configuring the scheme requires the *manage settings* permission.

From then on, when you create an asset and leave the **Asset tag** field blank, lazyit fills in the
next tag automatically. If you **do** type a tag, your explicit value always wins; the scheme only
fills the gap.

The create form tells you which tag that would be, in a line **below** the field: *"Leave blank and
this asset gets IT-1001."* That line only appears when the scheme is on, and it is the real
next-available tag, not the raw counter. The greyed-out text **inside** the field is a different
thing: it is only a formatting example (`e.g. LZ-0001`), and it never means "this is the tag you will
get". If you can't see the hint line at all, you don't have the *manage settings* permission — the
tag is still assigned for you on save.

## The skip-existing rule

An auto-assigned tag is **never** one that already exists on a live asset. If the counter would land
on a tag that's already taken, lazyit skips ahead to the next free one. For example, if `IT-1000`,
`IT-1002` and `IT-1005` already exist, the next allocations are `IT-1001`, `IT-1003`, `IT-1004`,
`IT-1006`, and so on. This rule always holds — you can't end up with two assets sharing a tag.

## Numbering is monotonic, not gap-free

The counter only moves forward. It does **not** back-fill numbers that were skipped, rolled back, or
freed when an asset was deactivated, so the sequence may have holes (`…0041, 0043, 0044…`). This is
intentional: guaranteed-consecutive numbering isn't worth the complexity for a small team, and a
missing number is harmless.

## Seed suggestion

When you configure the scheme over an existing estate, the editor reads the tags that already match
your pattern and **suggests a starting number** just above the highest one it finds (for example "12
existing tags match — suggested start: 43"). Accept the suggestion so the counter starts above your
current range, or set your own.

## Tagging assets that already exist

Turning the scheme on does **not** retroactively tag the assets you already have — it only affects new
creates. To tag the existing estate, use **Tag existing assets** in the scheme settings. This opens a
review-then-apply tool:

- **Choose what to tag.** *Untagged only* (the safe default) gives a tag only to assets that have
  none. *Also fix non-conforming* additionally re-tags assets whose tag doesn't match the scheme —
  this is behind a warning, because it overwrites a label someone set by hand and may have printed.
  **Conforming tags are never changed.**
- **Optionally limit to one model**, so you tag just a subset.
- **Preview before applying.** lazyit lists the assets in scope with their **proposed tag**, writing
  nothing yet. Deselect any rows you want to skip.
- **Apply.** lazyit assigns the real tags and records each one in the asset's activity log.

Backfill is **forward-only — there is no bulk undo.** If a single tag comes out wrong, fix it by
editing that one asset.

## Printing a QR label

Every asset can print a small **QR label** to stick on the physical unit. On the asset's page, use
**Print label**. lazyit opens a clean, chrome-less sheet showing a QR code with the asset tag and name
printed underneath, and a **Print** button that hands off to your browser's print dialog — send it to a
label printer, or print on paper and cut it out.

The QR encodes a **direct link to that asset in lazyit** (built from the address you're using right
now), so scanning it — with the built-in scanner below, or any phone camera — opens the asset's page.
The human-readable asset tag is always printed under the code, so a person can still read or type it if
they can't scan.

## Scanning to find an asset

**Assets → Scan** opens your device camera to read an asset's QR label hands-free. Point the camera at
the label and lazyit acts on what it reads:

- a lazyit QR label → it opens that asset's page directly;
- any other code or text → it runs an asset **search** for that value, so a plain tag sticker still
  finds the unit.

Scanning works in the browser — no app to install — on mobile Safari (iOS), Android Chrome and desktop
Firefox. It needs **camera permission** and a **secure (HTTPS) connection**; allow the camera when your
browser asks. If the camera isn't available or you deny access, the same screen offers a **manual
entry** field — type an asset tag and it runs the same lookup.

## What's next

- [Asset basics](/help/assets-asset-basics) — where asset tags appear on each unit.
- [Assignments & history](/help/assets-assignments-history) — the activity log that records each
  retag.
