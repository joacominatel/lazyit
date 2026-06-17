---
title: Asset tag scheme
category: configuration
subcategory: asset-tag-scheme
order: 3
---

# Asset tag scheme

The **asset tag scheme** auto-assigns a running asset tag to new assets — a prefix, a zero-padded
number and a suffix (for example `IT-0042-HW`). It is **off until you turn it on**, and an explicit
tag you type on an asset always wins. You configure it under **Settings → Instance** (administrators
only).

## Designing the scheme

The editor has four fields and a **live preview** that shows exactly what the next tag will look like
as you type:

- **Prefix** — text before the number (e.g. `IT-`). Optional.
- **Suffix** — text after the number (e.g. `-HW`). Optional.
- **Number width** — zero-pad the number to this many digits (e.g. `4` → `0042`). Leave blank for no
  padding.
- **Start at** — optional. Re-seed the counter so the next tag starts at this number. Leave blank to
  continue the existing sequence.

Turn the scheme on with the **Auto-assign asset tags** toggle. While it is on, any new asset created
without a tag gets the next number automatically. While it is off, nothing is auto-assigned.

> The counter only ever moves **forward**. Numbers can have gaps — that is expected and fine. A tag
> you typed by hand is never overwritten by the auto-assigner.

## The skip-existing guarantee

An auto-assigned tag is **never** a tag that already exists on a live asset. When the scheme allocates
the next tag, it skips past any number whose rendered tag is already taken and uses the first free one.
So if `IT-1000`, `IT-1002` and `IT-1005` already exist, the next allocations fill `IT-1001`, `IT-1003`,
`IT-1004`, `IT-1006`, and so on. You never get a collision, even if you start the counter inside a range
that is already in use.

To help you pick a sensible starting point, the editor suggests a **Start at** value based on the
highest existing tag that matches your pattern. The suggestion only appears when the scheme is on and
some live assets already match the pattern, and it is never applied automatically — click to accept it.

## Backfilling existing assets

Turning the scheme on tags **new** assets going forward; it does not retroactively tag what you already
have. To tag the existing estate, use **Tag existing assets** (visible once the scheme is enabled). It
opens a wizard:

1. **Choose what to tag.** Two modes:
   - **Untagged only** (the default, safe option) — only assets that have no tag yet get one. Existing
     tags are left untouched.
   - **Also fix non-conforming** (opt-in) — additionally re-tag assets whose tag doesn't match the
     scheme. lazyit shows an explicit warning first, because this **overwrites tags someone set by
     hand**, which may be printed on physical labels. Tags that already conform to the scheme are
     never touched.
2. **Narrow the scope (optional).** Filter to a single asset model so you backfill one fleet at a time.
3. **Review the preview.** A paginated, read-only list shows each affected asset with its current tag
   and the proposed new tag. **Nothing is written yet.** Deselect any rows you want to skip —
   deselections are remembered as you page through.
4. **Apply.** lazyit allocates the tags for real. You get a summary of how many were tagged and how
   many were skipped.

> Backfill is **forward-only and audited** — each retag is recorded in the asset's history. There is
> **no bulk undo**. If a single tag comes out wrong, fix it by editing that one asset. Because the
> preview is a projection (not a reservation), the applied tags still follow the skip-existing
> guarantee even if the estate changed between previewing and applying.
