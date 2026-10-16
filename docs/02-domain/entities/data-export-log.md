---
title: DataExportLog
tags: [domain, entity, audit, export, reports, security]
status: accepted
created: 2026-10-16
updated: 2026-10-16
---

# DataExportLog

> 🟢 implemented · Area: Reports / Audit · see [[0103-data-export-streaming-path]]

## Purpose

An **append-only** record of every server-side data export: who pulled which list, with which
filters, and how many rows. It answers "who exported the user directory last month" without a DBA,
and it is the fourth source of Reports › Audit ([[0081-audit-log-read-surface]]).

## Relationships

- **attributed to** at most one actor: a [[user]] (`actorId`, `onDelete: SetNull`) **or** a
  [[service-account]] (`serviceAccountId`, `onDelete: SetNull`), never both (CHECK
  `data_export_logs_one_actor`, [[INVARIANTS]] INV-SA-4). Neither = system / unknown.
- **names** the exported list by its `resource` label; there is no foreign key to the exported rows.

## Business rules

- **Append-only and immutable** ([[0006-soft-delete-and-auditing]]). Rows are written by
  `ExportService.recordExport()` and never updated or deleted; there is no service method that does.
- **One row per export, written before the first byte.** The export engine counts the matching rows,
  refuses above the cap, then writes this row with that count and only then streams. An export the
  client abandons is still recorded. A refused export (over the cap, or rate-limited) writes nothing.
- **`rowCount` is the count at start**, not the number of rows sent: rows deleted during the stream
  make the file shorter, rows inserted during it are not in the file.
- **`filters` is sanitized**: flat JSON of scalars and scalar arrays, strings cut at 200 characters,
  arrays at 50 items, nested objects and empty values dropped. It holds list filter values, never a
  secret.
- **`resource` is text, not an enum.** It holds a `DATA_EXPORT_RESOURCES` label from `@lazyit/shared`
  (`ASSETS`, `ACTIVITY`, `AUDIT`, `USERS`, `ACCESS_GRANTS`, `CONSUMABLES`, `PURCHASE_ORDERS`). The write
  site is typed against that list; the read is tolerant of any value, so a resource added later needs no
  migration and an older build still reads the row.

## Conventions

- **ID:** `autoincrement()` — a log entity ([[0005-id-strategy]]).
- **Timestamps:** `createdAt` only — append-only ([[0006-soft-delete-and-auditing]]).

## Fields

Prisma model `DataExportLog` → table `data_export_logs`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `int` | `autoincrement()`. Also the audit feed's keyset. |
| `actorId` | `uuid?` | FK → [[user]] (`@db.Uuid`), `SetNull`. |
| `serviceAccountId` | `cuid?` | FK → [[service-account]], `SetNull`. |
| `resource` | `text` | A `DATA_EXPORT_RESOURCES` label. |
| `filters` | `jsonb` | The sanitized list filters. |
| `rowCount` | `int` | Matching rows counted before streaming. |
| `createdAt` | `datetime` | `@default(now())`. |

Indexes: `(actorId, id)`, `(serviceAccountId, id)`, `(resource, id)` and `(createdAt)` — the audit
feed's actor, service-account, resource and date filters over its newest-first `id` order.

## Read

`GET /audit/logs?source=export` (and `/logs/export`, `/logs/filters`), `logs:read`. On the unified
audit row, `action` is the resource, `detail` is `{"rowCount":…,"filters":{…}}`.

Related: [[0103-data-export-streaming-path]] · [[0081-audit-log-read-surface]] · [[secret-audit-log]] ·
[[permission-audit-log]] · [[service-account-audit-log]] · [[INVARIANTS]] INV-EXP-1
