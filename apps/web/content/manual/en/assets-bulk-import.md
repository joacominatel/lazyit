---
title: Bulk import
category: assets
subcategory: bulk-import
order: 1
---

# Bulk import

The **bulk importer** loads an existing estate of assets into lazyit from a single CSV or JSON file.
It is built for the first day of a new instance, when your inventory still lives in a spreadsheet or
a legacy tool. You drive it from **Importer** in the sidebar.

The importer is **administrator-only** — it needs the `import:run` permission, which administrators
hold by default. If you can't see it, ask an administrator to run the import for you.

> **What you can import today.** Assets only. Users, consumables and history import are deliberately
> not available yet and are noted as *coming later* in the wizard. Asset **ownership/assignment** is
> also out of this first phase.

## The flow at a glance

The importer is a guided wizard. **Nothing is written to your data until the final commit step**, and
even then every row is checked one more time before it is saved.

1. **Upload** — pick what you're importing (Assets) and choose your file.
2. **Summary** — confirm the detected record count, encoding and columns.
3. **Mapping** — match each lazyit field to a column in your file.
4. **Preview** — a *dry run* that validates every row without writing anything.
5. **Conflicts** — resolve any references that matched (or didn't match) existing records.
6. **Commit** — the import runs, and you get a result report.

You can go **Back** at any step before the commit to change your answers.

## 1. Upload your file

Export your spreadsheet as **CSV (UTF-8)**, or provide a **JSON array** of objects. Each row (or
object) becomes one asset.

- `.xlsx` files are **not** accepted — export them to CSV first.
- The file is parsed in the background; this usually takes a few seconds.
- Date-only columns and any `created`/`updated`/`deleted` timestamp columns are rejected — this first
  phase imports the *current state* of an asset, not its history.

## 2. Confirm the summary

After parsing, the importer shows the **record count**, the detected **encoding**, the **delimiter**
and the list of **columns** it found. Use this to confirm the file parsed the way you expect before
you spend time mapping. If it found zero rows, go back and check the file.

## 3. Map your columns

For each lazyit field you can either point it at a **source column** or pin a **constant** value that
applies to every row:

- **Name** — *required*. Your label for the asset.
- **Status** — *required*. The asset's lifecycle status. Each distinct status value in your file is
  mapped to a lazyit status (for example `active → OPERATIONAL`, `retired → RETIRED`). Common
  synonyms are suggested automatically; you can change any of them.
- **Serial number** — optional, but **important**: it is the asset's only natural key. If you map it,
  re-uploading the same file won't create duplicates for those rows. Without it, a re-upload is **not
  de-duplicated** (you'd get a second copy).
- **Asset tag** — optional. A tag from your file is used as-is; a blank one is auto-assigned later if
  your instance has an asset-tag scheme enabled.
- **Model** and **Location** — optional **references**: they are matched to existing records by name
  (see *Conflicts* below).

Required fields must be mapped or pinned before you can continue. Columns you don't map are simply
ignored.

## 4. Preview (the dry run)

The dry run validates, coerces and resolves **every** row — **writing nothing**. You get:

- A count of **valid** and **invalid** rows.
- Per-row outcomes, with the exact validation error for each invalid row (so you can fix the file).
- **Asset-tag collisions** — any tag in your file that already belongs to a live asset is flagged
  here, never silently dropped.

Because the preview runs the *same* checks the commit will, what you see is what you'll get.

## 5. Resolve conflicts

When your file references a **model** or a **location** by name, the importer looks for an existing
record. For each distinct value it shows you the matches it found, the **blast radius** (how many rows
use that value, with a few example row numbers), and asks you to choose one of four outcomes:

- **Link to an existing record** (*match*) — use a live record that already exists.
- **Restore an archived record** (*restore*) — bring back a soft-deleted (archived) record and link
  to it.
- **Create a new record** (*create*) — make a new one. Only offered when no live match exists. The
  new record is created with sensible defaults you can edit afterward.
- **Skip — leave unlinked** (*skip*) — import the rows without that link.

**lazyit never guesses for you.** When more than one record matches a value, the conflict is marked
*ambiguous* and you must pick the specific record — the importer will not auto-select one. You resolve
each distinct value **once**, and that choice applies to every row that shares it.

## 6. Commit and the result

When the plan is set, the import runs in the background. It is **chunked** and **resumable**, and it
follows a **keep-partial** rule:

- Successful rows are **kept** — a problem with one row never rolls back the rows that already
  succeeded.
- If a value was taken by someone else between the preview and the commit, that row is recorded as a
  **failure** (not silently dropped), and the rest continue.

The result report shows how many rows were **created**, **failed** and **skipped**, plus the
**import run** id for your audit trail. If some rows failed, fix them in your file and run the
importer again — already-imported rows are skipped on a re-run (when a serial number is mapped).

## Good to know

- **It's additive and audited.** The importer only creates and links; it never deletes or overwrites
  your existing assets. Every created asset gets a history entry attributed to you.
- **Sessions expire.** An in-progress import session is kept for 24 hours and then discarded. The
  audit ledger of a *completed* import is permanent.
- **Permissions still apply at commit.** Beyond `import:run`, creating a new model or location during
  a conflict needs the matching write permission; the importer checks this before writing anything.
