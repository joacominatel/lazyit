---
title: Exporting data
order: 1
category: notifications-activity
subcategory: data-export
---

# Exporting data

Most lists in lazyit can be downloaded as a **CSV** file you can open in a spreadsheet, hand to finance,
or feed to a script. Look for the **Export CSV** button at the top of the list.

## Where you can export

| Screen | What the file holds |
| --- | --- |
| **Assets** | One row per asset: name, tag, serial, status, model, location, company, dates, owners, notes, purchase cost and currency. |
| **Reports** (activity) | One row per event: when, action, entity, actor and summary. |
| **Reports → Audit log** | One row per event of the source tab you have open (Secrets, Permissions, Service accounts or Exports). |
| **Users** | One row per person: name, email, role, whether the account is active, directory details, manager, and how many assets and grants they hold. |
| **An application's page** | Its access grants, active and revoked: who, access level, granted and revoked by whom and when, expiry and notes. The button is on the *Active access* panel. |
| **A person's page** | The same grant columns for that person, active and revoked. The button is on the *Access* tab. |
| **Consumables** | One row per item: name, SKU, category, unit, current stock, reorder threshold and whether it is low. |
| **Purchases** | One row per purchase: reference, supplier, status, receipt state, dates, invoice numbers, units ordered, received and pending, total and currency. |

The secret manager has its own export of a vault's items, which works differently: see
[Vaults & members](/help/secret-manager-vaults-members).

## What goes in the file

An export holds **every row that matches the filters you have set**: the search, the filters, the tab
and the archived view. It is never just the page in front of you, and it ignores the page size, the
columns you chose to show and the order you sorted by. Each list always writes the same columns, newest
rows first, so a script reading the file keeps working.

To export a slice, filter the list first, then export.

## Limits

- **100,000 rows per file.** If the list matches more, the button tells you before downloading anything,
  and the export is refused rather than cut short. Narrow the filters (a date range on Reports is the usual
  fix) and try again.
- **One export at a time, five a minute.** A second export while one is still downloading, or a sixth
  within a minute, is turned away with a message asking you to wait a moment.

## Who can export

Anyone who can see a list can export it. There is no separate export permission. The file follows the
same rules as the screen: the archived view stays administrator-only, and on **Assets** the supplier,
purchase reference and invoice-number columns appear only for people who can view purchases.

## Every export is recorded

Each export is written to the audit log, under **Reports → Audit log → Exports**: who exported, which
list, how many rows and with which filters. The entry is written when the download starts, so an export
you abandon half way still shows up. An export that is refused (too many rows, or too many at once) is
not recorded. Exporting the *Exports* tab itself includes the entry for that very export.

## Opening the file in a spreadsheet

The file is UTF-8 with a byte-order mark, so Excel shows accented names (*José*, *Dirección*) correctly.
A text cell that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet never runs it as a
formula. Numbers and dates are written as plain values.

## The asset file can be imported back

The assets file starts with a line like `# lazyit v2.1.0 — 2026-10-16T…` naming the version that wrote
it. Keep that line when you edit the file to bring it back through the
[bulk import](/help/assets-bulk-import): the importer reads it to check the file comes from a compatible
version. Activity and audit files do not carry it, so their column names are on the first line.
