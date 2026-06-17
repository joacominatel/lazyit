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
**Next tag** preview as you type, so you can see exactly what the next asset will get.

## Turning it on

Open **Settings → Instance → Asset tag scheme** and switch on **Auto-assign asset tags**. Set the
prefix, suffix and number width you want, optionally a **Start at** number to seed the counter, then
**Save scheme**. Configuring the scheme requires the *manage settings* permission.

From then on, when you create an asset and leave the **Asset tag** field blank, lazyit fills in the
next tag automatically — the create form even hints the next value in the field. If you **do** type a
tag, your explicit value always wins; the scheme only fills the gap.

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

## What's next

- [Asset basics](/help/assets-asset-basics) — where asset tags appear on each unit.
- [Assignments & history](/help/assets-assignments-history) — the activity log that records each
  retag.
