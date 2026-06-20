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

> **What you can import today.** Assets, the **people** each one is assigned to, and that **assignment**.
> When your file has an "assigned to" column, the importer creates the person and hands them the asset
> (see *Assign assets to people* below). Consumables and history import are deliberately not available
> yet and are noted as *coming later* in the wizard.

## The flow at a glance

The importer is a guided wizard. **Nothing is written to your data until the final commit step**, and
even then every row is checked one more time before it is saved.

1. **Upload** — pick what you're importing (Assets) and choose your file.
2. **Summary** — confirm the detected record count, encoding and columns.
3. **Mapping** — go column by column: send each one to a lazyit field, save it as a custom field, or
   ignore it.
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

Mapping is **column-first**: the importer lists **every column from your file**, each as its own card
showing the column name and a few **example values** pulled from your file, so you always know what
you're looking at before you decide where it goes.

> **Heads up — this screen shows your real data.** The example values are taken straight from the
> file, so they can include employee data such as names and emails. Nothing is written anywhere until
> the final commit; the values are only shown to you, the operator running the import.

For each column, open it and pick one target from the dropdown:

- **A lazyit field**, grouped by entity:
  - **Asset** — **Name** (*required*), **Status** (*required*), **Serial number**, **Asset tag**,
    **Purchase date**, **Warranty end**, **Model** and **Location**.
  - **Model** — **Manufacturer** and **Category** for the asset models the import creates (see
    *Model brand and category* below).
  - **Person** — the person the asset is **assigned to**: **Name**, **Email**, **Employee no.**,
    **Username**, **Job title**, **Department** and **Supervisor** (see *Assign assets to people*
    below).
- **Create a custom field…** — for a column with no native home (RAM, IMEI, screen size, cost, an
  external URL…). You give it a name, and its value is saved to the asset's **details** (`specs`).
  A custom field is stored **only on rows that actually have a value** — empty cells add nothing.
- **Ignore** — drop the column. **Empty and irrelevant columns default to Ignore**, so a wide export
  with dozens of unused columns isn't a wall of work; you only touch the ones that matter.

A few fields behave specially:

- **Name** and **Status** are **required**: you must map a column to each before you can continue.
- **Status** values are reconciled **inside that column's card** — each distinct status value in your
  file maps to a lazyit status (for example `active → OPERATIONAL`, `retired → RETIRED`). Common
  synonyms are filled in for you; change any of them.
- **Serial number** is optional but **important**: it is the asset's only natural key. Map it and a
  re-upload won't create duplicates for those rows. Without it, a re-upload is **not de-duplicated**.
- **Asset tag** — a tag from your file is used as-is; a blank one is auto-assigned later if your
  instance has an asset-tag scheme enabled.
- **Model** and **Location** are **references**, matched to existing records by name (see *Conflicts*).

The importer **pre-fills a best guess** for each column, but it never decides for you — you confirm
every column, and nothing is dropped silently. The guess understands more than exact English
headers: it recognises **Spanish and Snipe-IT-style names** too (for example *Nombre*, *Número de
serie*, *Asignado a*, *Modelo*), so a typical export lands mostly pre-mapped. You still confirm each
column — the auto-detection only proposes the target.

### Model brand and category

**A model is created from its name.** To have the import create models, map a column to **Model**
(under the *Asset* group). Mapping only **Manufacturer** or **Category** does *not* create a model —
those two only **enrich** a model that already comes from a mapped **Model** column. The category is
attached **through the model**, not directly to the asset.

When the import creates a new **Model**, it needs a **manufacturer** and a **category**. You can set
these two ways:

- **Per row** — map a column to **Manufacturer** or **Category** in the dropdown, and each model takes
  its value from that row.
- **For every model** — if your file has no such column (or all your assets are the same brand), pin a
  single **Manufacturer** and/or **Category** in the *Model brand and category* box; it applies to
  every model the import creates. A mapped column always wins over a pinned value.

### Assign assets to people

Map any **Person** field and the import will, for each row, find or create that person and **assign the
asset to them** — the assignment is recorded the same way it would be in the app, with history.

- **An imported person has no login.** They are a **directory** person: a real entry in your Users list
  (badged **Directory**), but without an account in your identity provider. They exist so the asset has
  an owner on record; they cannot sign in until they get an account.
- **To assign, map the person's Name *and* one identity key.** **Name** (the *Assigned to* column) is
  **required** to assign an asset, plus at least one of **Email**, **Employee no.** or **Username** to
  know *who* a row belongs to (and to avoid creating the same person twice). **If you map any Person
  field, the wizard won't let you continue until both the Name and an identity key are mapped.** A row
  that's missing the name is flagged as an **invalid row** in the preview, so you fix it before
  committing — it never fails silently at the end. A row with a name but no identity key imports the
  asset **unassigned**, with a warning.
- **They link to a real account automatically — only with a matching email.** When that person later
  signs in through your identity provider (OIDC) using the **same verified email**, lazyit links the two:
  the directory entry becomes their account and the **Directory** badge disappears. **A person imported
  without a real email never links automatically** — there's no email to match on. Promote them by hand
  (next point) when they need to sign in.
- **You can create their account now.** An administrator can open the person's page and choose **Create
  OIDC account** to provision them in the identity provider immediately, instead of waiting for a login.
  The identity provider requires a real email, so the button is **disabled until the person has one** —
  edit the person and add a real email first.

The asset always imports either way; only the **assignment** depends on identifying the person.

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
