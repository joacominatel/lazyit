---
title: "ADR-0103: Data export — one server-side streaming path per list"
tags: [adr, api, export, csv, security, audit, reports]
status: accepted
created: 2026-10-16
updated: 2026-10-21
deciders: [Joaquín Minatel]
---

# ADR-0103: Data export — one server-side streaming path per list

## Status

accepted — 2026-10-16, epic #1597. The CEO accepted every recommendation of the proposal on #1597
(decisions D1–D5, "2. ok"), after asking that "almost every screen of the application" be exportable
at the data level. Amends [[0030-list-pagination-contract]] (exports page by keyset),
[[0044-recent-activity-view]] (the view gains a `sourceKey`) and [[0081-audit-log-read-surface]] (a
fourth audit source). Builds on [[0083-versioning-and-releases]] (the provenance stamp),
[[0048-service-accounts]] (actor attribution) and [[0100-money-as-64-bit-minor-units]].

## Context

Three lists stream a CSV from the server today: assets (`GET /assets/export`), Reports › activity
(`GET /dashboard/activity/export`) and Reports › audit (`GET /audit/logs/export`). The vault export is
different: the browser decrypts and the server only records `ITEMS_EXPORTED`. The three server exports
share the cell escaping in `@lazyit/shared`, but each owns its own loop, order and limits, and:

- assets and activity page with OFFSET, so a row inserted mid-export shifts later batches and a
  boundary row is sent twice (audit already moved to a keyset cursor, AUD-033);
- the formula guard misses `\n` and the full-width `＝ ＋ － ＠`, and it is applied to every cell, so a
  negative quantity would come out as the text `'-5`;
- there is no UTF-8 BOM, so Excel on Windows shows `José` as mojibake;
- no export leaves an audit row, not even an export of the security audit logs;
- there is no row cap and no rate limit.

Most other list screens (users, access grants, consumables, purchases, …) have no export at all.

## Considered options

1. **One engine, one route per resource** (`GET /<resource>/export`), each route reusing its list's
   permission, filter parser and `where` builder. *(chosen)*
2. A central `GET /exports/:resource` registry. Authorization and filter parsing live per controller
   (`@RequirePermission`, `parseAssetFilters`, the zod query schemas); a registry would re-implement
   each one and drift from the list it exports, which is the failure the existing export comments
   already warn about.
3. Background jobs with a stored file, a download ticket and a notification ([[0053-async-workers-bullmq-valkey]]).
   Retention, storage and a second delivery path for a 5–20 person install whose largest realistic
   export is a few years of activity.

## Decision

### 1. Per-resource routes on a shared engine

`apps/api/src/common/export/` holds the engine; each resource keeps its own route. A route is a few
lines: the list's `@RequirePermission`, its own filter parser, its own `where` builder, a column set,
and one call to `ExportService.exportCsv()`.

| Piece | Responsibility |
| --- | --- |
| `ExportColumn<T>` | `{ header, kind, value(row) }`, `kind` one of `text` · `number` · `date` · `money` (integer minor units, [[0100-money-as-64-bit-minor-units]]). |
| `streamCsv()` | BOM, the optional stamp line, the header, then one chunk per batch; every line ends in CRLF. |
| `keysetBatches()` + `keysetWhere()` + `keysetOrderBy()` | Newest first over `(createdAt, id)`, with an explicit `createdAt < c OR (createdAt = c AND id < i)` predicate. |
| `assertWithinCap()` | Refuses above the cap with a 422, before the first byte. |
| `ExportService.recordExport()` | Appends the `DataExportLog` row. |
| `ExportLimiter` | One running export per principal, five started per minute. |

`ExportService.exportCsv()` runs them in order: take the principal's slot (429 when busy or over the
rate), count the matching rows with the same `where` the batches read, refuse above the cap, write
the audit row with that count, then return a `StreamableFile` over the keyset stream. Resources import
`ExportModule`; its providers are app-wide singletons, so there is one limiter.

### 2. Authorization is the list's, and columns are an allowlist

- **No new permission (D1).** An export carries the list route's `@RequirePermission` and nothing else.
  Anyone holding `X:read` can already page the whole list through the API; a separate verb would add
  friction, not protection, and would need seeding on live installs to keep current VIEWERs' asset
  export.
- **Same rows as the list.** The export calls its service's own `where` builder, never a generic Prisma
  query: soft-delete slices keep `assertCanListDeleted` (`deleted=only` is ADMIN-only), consumables keep
  their explicit `deletedAt` filter, the activity view keeps its own, and the KB keeps
  `FolderAccessService.visibleFolderIds` plus draft visibility.
- **Columns are an explicit allowlist mapped from the list projection**, never the model. Password
  hashes, `externalId`, session epochs, token hashes, ciphertext and article bodies are unexportable by
  construction. The column set is computed per principal where a list gates fields: asset purchase
  provenance follows `purchaseOrder:read` ([[0099-purchases-scope-model-and-optionality]] §8, INV-PO-1),
  consumable delivery targets follow [[0098-consumable-delivery-targets]].
- **Secrets are out of scope by construction.** Vault items stay a client-side export (INV-10). Workflow
  secrets, service-account tokens and OAuth grants have no export.

### 3. Keyset over immutable keys

An export never orders by a mutable column or by the on-screen sort. It walks `(createdAt, id)`
newest first. `createdAt` is server-set and never updated, unlike `grantedAt` / `assignedAt`, which a
client can backdate. Once the first batch is read, a newly inserted row sorts ahead of the cursor and
is not sent; nothing is sent twice. Prisma's `cursor` option is not used: it resolves the cursor row by id, and a
cursor row soft-deleted mid-export would break the walk. The activity view has no stable row id, so it
gains a `sourceKey` (§ amendment to [[0044-recent-activity-view]]); the audit logs keep keying on their
autoincrement `id`.

### 4. Cap and refusal (D3)

`DATA_EXPORT_ROW_CAP = 100_000`, in `@lazyit/shared` so the web can warn before calling. The count runs
before the first byte; above it the export is refused with **422** "narrow your filters" and nothing is
streamed, audited or truncated. A count of exactly the cap is accepted. The count and the file can
differ by the rows written between them: the first batch reads with no cursor, so a row inserted (or a
row whose filtered fields change) between the count and that read can appear, and a row deleted
mid-export is missing. Rows inserted after the first batch is read are never in the file. There is no
hard limit on that difference. One such row is predictable: the audit row is written after the count and
before the first read, so an export of the audit log's `export` source includes the row recording that
export itself (the file holds `rowCount` + 1 rows).

A batch that fails mid-stream aborts the response: the error is logged and the connection destroyed,
so the client sees a failed download, never a short file that looks complete. The audit row stays.

### 5. Synchronous streaming only

No background job, stored file, emailed export or schedule. The response streams from an async
generator through `Readable.from`, a batch of 1,000 rows at a time, so no export holds its result in
memory. Revisit only if real installs hit the cap.

### 6. Limiter

`EXPORT_RATE_LIMIT = { max: 5, windowMs: 60_000 }` per principal on the shared
`FixedWindowRateLimiter`, plus **one running export per principal**. Both answer **429**. Keyed on
`user:<id>` or `sa:<id>`, in memory and per replica like every other limiter here (behind N replicas
the effective cap is N×). The slot is released when the response stream closes, including a client
disconnect (the route passes its `@Res({ passthrough: true })`). A lease older than 10 minutes counts
as free, a backstop for a close event that never arrives. A refused export (cap, 429) writes no audit
row; a refusal by the cap still counts toward the rate.

### 7. The audit trail (D2)

Every export appends one immutable `DataExportLog` row ([[data-export-log]]): the actor — a user or a
service account, at most one (CHECK, INV-SA-4) — the resource, the filters sanitized to flat JSON, the
pre-count and the time. It is written **before** the first byte, so an export the client abandons is
still recorded. `resource` is plain text holding a `DATA_EXPORT_RESOURCES` label, not a Postgres enum:
a resource added in a later phase needs no migration, and a build that predates it still reads the
row. There is no update or delete path; unlike `ai_action_log` there is no trigger, matching the other
three security audit logs.

The log is the fourth source of Reports › Audit (§ amendment to [[0081-audit-log-read-surface]]).

### 8. CSV conventions (D4)

- **UTF-8 BOM on every file.** The asset importer already strips one ([[0069-migrator-import]]), so the
  round trip is safe.
- **CRLF** line endings (RFC-4180).
- **Typed formula guard.** `text` cells get a leading `'` when they start with `=` `+` `-` `@` tab, CR,
  LF or the full-width `＝ ＋ － ＠`, then RFC-4180 quoting. `number`, `date` and `money` cells skip the
  guard only when the value is a strict number (`-?digits[.digits]`) or an ISO-8601 date or timestamp,
  so `-5` stays `-5`; anything else in such a column is guarded like text. The helpers are `csvCell()` /
  `guardCsvFormula()` in `@lazyit/shared`. The legacy `escapeCsvCell()` and the browser row
  serializers it guarded were removed with the "export visible page" buttons (phase 1d); `@lazyit/shared`
  keeps only the asset, activity and audit header constants the API pins.
- **The `# lazyit` provenance stamp** ([[0083-versioning-and-releases]]) only on a file an importer reads
  back, today the asset inventory. Activity and audit exports drop it: no importer consumes it there and
  it pushes the header to row 2.
- **Scope is "every row matching my filters"**: not the visible page, not the visible columns, not the
  on-screen sort. A stable column schema and order is what scripts and the importer need. The
  client-side "export visible page" buttons are retired.

### 9. Phases

| Phase | Content |
| --- | --- |
| 0 + 1a | This ADR and its amendments; the engine; `DataExportLog` and the `export` audit source; the typed guard. |
| 1b | Assets, activity (view `sourceKey`) and audit move onto the engine; all three gain the cap, the audit row and the BOM. The asset column contract and stamp stay. |
| 1c | Users, access grants (global and per application), consumables, purchases. |
| 1d | The web `<ExportButton>` on those seven screens (the user and application records export their grants), the "Exports" audit source on screen, the Manual. |
| 2 | Applications, locations, suppliers, pending units, access requests, servers, consumable movements and deliveries, the KB article index (metadata only, folder ACL tests mandatory). |

### 10. Filters follow the list (2026-10-21, #1660)

The per-application grant export follows the paged Access tab's filters — `status`, `accessLevel` /
`noAccessLevel` and the person `q` — through the same `where` as
`GET /applications/:id/access-grants/page`, so "export what I see" holds once the tab filters
server-side. The older `activeOnly` / `includeExpired` pair is still accepted for clients that send
it; mixing the two families is a `400`. The audit row records the filters that were sent:
`activeOnly` / `includeExpired` only when `status` is absent, and `noAccessLevel: true` for a no-level
export (a `null` level would otherwise be dropped by the audit sanitizer and read as "any level").

## Consequences

- One export path with one set of guarantees: no duplicated rows, a refusal instead of a silent
  truncation, an audit row per export, Excel-safe encoding.
- **Behaviour changes operators will see** (release notes and the Manual): files gain a BOM; activity
  and audit files lose the stamp line; an export above 100,000 rows now fails with 422 and asks for a
  narrower filter; a sixth export in a minute, or a second one in parallel, gets a 429; the "export
  visible page" buttons disappear.
- **Cost:** every resource export is a route plus a column set to write and test, rather than one
  registry entry. A forgotten field gate in a column set is a leak, so each resource pins its header in
  a test and asserts the export returns the same id set as the list for the same principal and filters.
- **Cost:** the count runs on every export, a second query over the same `where`.
- **Ceiling:** the limiter is per replica, and the concurrency slot is in memory: a restart frees it,
  and two replicas allow two parallel exports per principal.
- **Ceiling:** the recorded `rowCount` is the count at start, not the number of rows actually sent.
- **Deliberately not built:** XLSX or JSON files, background or emailed exports, scheduled exports,
  column pickers, sort-respecting exports, flattened asset `specs` or custom fields (#872), detail-page
  exports beyond the listed ledgers, any server-side secret export.

## References

- Epic #1597 and its proposal. [[data-export-log]] · [[INVARIANTS]] INV-EXP-1.
- [[0030-list-pagination-contract]] · [[0044-recent-activity-view]] · [[0081-audit-log-read-surface]] ·
  [[0083-versioning-and-releases]] · [[0069-migrator-import]] · [[0048-service-accounts]] ·
  [[0061-secret-manager-zero-knowledge]] · [[0098-consumable-delivery-targets]] ·
  [[0099-purchases-scope-model-and-optionality]] · [[0100-money-as-64-bit-minor-units]] ·
  [[0074-server-reporting-agent]] §8 (the in-memory limiter posture).
