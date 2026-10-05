---
title: "ADR-0101: Custom asset statuses — operator-named labels mapped to the built-in AssetStatus"
tags: [adr, assets, data-model, taxonomy, ai]
status: accepted
created: 2026-10-05
updated: 2026-10-05
deciders: [Joaquín Minatel]
---

# ADR-0101: Custom asset statuses — operator-named labels mapped to the built-in AssetStatus

## Status

**accepted** — 2026-10-05 (CEO product decisions, issue #1524). Builds on [[0033-asset-history-event-model]]
(the `STATUS_CHANGED` event gains label fields, additively), [[0041-soft-delete-reuse-and-restore]] (the live-only
partial unique name and the restore) and [[0046-roles-permissions-v2]] (no new permission). Leaves
[[0017-location-type-enum]] untouched: location types stay an enum.

## Context

`Asset.status` is a fixed enum — `OPERATIONAL`, `IN_MAINTENANCE`, `IN_STORAGE`, `RETIRED`, `LOST`, `UNKNOWN`
([[asset]]). Every rule reads it: the dashboard's counts, the list's `?status=` filter, the asset-from-stock
default (`IN_STORAGE`), the import, the reporting agent, the AI tools. Teams want their own words on top of
it: "In repair at vendor" and "On the bench" are both *in maintenance*; "Loaner pool" and "Awaiting
imaging" are both *in storage*. Today they put that in `notes` or `company`, where nothing can filter or
report on it.

Constraints: live instances upgrade in place over populated `assets` tables, so nothing may rewrite or
reclassify existing rows; the enum is load-bearing across api, web, agent and the AI; and the feature must
stay optional — a team that never configures it must see no change.

## Considered options

1. **Enum only (status quo)** — add enum values when asked. Every new word is a migration and a release,
   and one team's vocabulary becomes everyone's. Rejected: not self-service.
2. **Free-string status** — replace the enum with operator text. Maximal freedom, but every rule that
   branches on a status (the dashboard, the stock default, the agent, imports, the AI) loses its anchor,
   and typo-driven fragmentation ("In repair" / "in-repair") is unbounded. The column rewrite also breaks
   the upgrade rule. Rejected.
3. **A label table mapped to the enum (chosen).** A user-managed `AssetStatusLabel` row carries a name and
   exactly one built-in status, its `kind`. An asset may point at one label; its built-in `status` stays
   the source of truth and always equals the label's kind. This is Snipe-IT's model (custom *status labels*,
   each of one of a few fixed *types* — deployable, pending, archived, undeployable) and keeps every rule on
   the enum while giving teams their vocabulary.

## Decision

1. **Assets only.** `AssetStatusLabel` (`asset_status_labels`): `id` (cuid), `name` (unique among **live**
   labels — a raw-SQL partial unique index, case-sensitive like the category names), `kind`
   (`AssetStatus`), optional `color` (`#RRGGBB`, validated on write), `description`, `order`, timestamps and
   soft delete. `Asset.statusLabelId` is a nullable FK (`onDelete: SetNull`, indexed). `LocationType`
   ([[0017-location-type-enum]]) stays as is.
2. **Optional configuration.** No operator is forced to create one; an asset can keep a bare built-in status
   forever. Existing assets read `statusLabelId = NULL`.
3. **The invariant** — `asset.statusLabelId != null ⇒ asset.status == label.kind` — is enforced in the API on
   every write path (create, update, bulk status, bulk receive, receive from a purchase line): a label sets
   `status` to its kind; a `status` that disagrees with a given label is a 400; a missing or archived label
   is a 400; a `status` alone keeps the label when it maps to that status and clears it otherwise;
   `statusLabelId: null` clears the label and keeps the status. All logic keeps reading `Asset.status`.
4. **Changing a label's kind is blocked (409) while any asset — live or archived — carries it.** Its assets
   would silently change built-in status.
5. **Deleting a label in use requires a destination**: another live label (`reassignLabelId`) or a bare
   built-in status (`reassignStatus`). In **one transaction** every carrying asset (live and archived — so no
   asset ever points at an archived label) moves there, each with a `STATUS_CHANGED` history row, and the
   label is soft-deleted. A restored label comes back with no assets. This is deliberately the opposite of
   the bare soft delete of categories, models and locations, whose children keep pointing at an invisible
   parent (SEC-041): a label is part of the asset's status, so a dangling one would misreport it.
6. **Concurrency.** The invariant spans two tables, so the writes serialize on the label row: an asset write
   that sets a label locks it `FOR SHARE`; a kind change and a delete lock it `FOR UPDATE`.
7. **History.** `STATUS_CHANGED` is also written when only the label changes (same built-in status). Its
   payload keeps `{ from, to }` (built-in values) and, when either side carries a label, adds
   `fromLabel` / `toLabel` (`{ id, name }` or `null`). Events between two bare statuses keep the exact old
   shape, and readers treat absent label keys as "no label". See the amendment in
   [[0033-asset-history-event-model]].
8. **Permissions: none new.** Custom statuses are taxonomy data under the category permissions —
   `category:read` to list, `category:write` to create and edit, `category:delete` to archive and restore;
   listing the archived ones (`deleted=only`) is ADMIN-only like every archived list (ADR-0041). Setting a
   label on an asset is part of the asset write (`asset:write`).
9. **The AI assistant sees, understands and configures them**: `reference_lookup` kind `assetStatusLabel`;
   `asset_status_label_create` / `_update` / `_archive` / `_restore`; a `customStatus` reference on
   `asset_create`, `asset_create_batch`, `asset_update`, `asset_update_batch`; `asset_get` / `asset_search`
   show it, and the search filters by it. Tool descriptions and the domain primer explain that the built-in
   status drives every rule and a custom status names one.

## Consequences

- **Positive:** teams get their vocabulary without a release; every rule, report, default, import and the
  reporting agent keep working unchanged on the enum; the filter `?status=` naturally includes every label
  of that kind and `?statusLabelId=` narrows to one.
- **Cost — two sources of display truth.** A screen must show the label when there is one and the built-in
  status otherwise, everywhere a status appears (list, detail, quick view, AI cards). A surface that forgets
  shows the coarser built-in status — wrong-looking, never wrong.
- **Cost — a denormalized `status`.** `Asset.status` duplicates the label's kind for labelled assets. It is
  what keeps every reader on the enum, but it makes the invariant the API's job on every write path; a
  future write path that sets `statusLabelId` without going through `AssetsService` would break it. The kind
  is frozen while the label is in use for the same reason.
- **Cost — a heavier delete.** Archiving a label in use is a bulk move with history, not a flag flip; its
  transaction is as large as the label's asset count (bounded at small-team scale).
- **Not covered (deliberately):** the search index and the inventory CSV keep the built-in status only
  (adding the label to either needs a reindex on rename and a CSV column the migrator must accept);
  imports keep mapping the built-in status.
- **Upgrade path:** additive migration — one new table, one nullable column and its FK and index, no
  backfill. Every existing asset keeps its status and reads `statusLabelId = NULL`; every existing
  `STATUS_CHANGED` row keeps reading as before. An older web ignores the new read fields.

## Related

[[asset]] · [[asset-status-label]] · [[asset-history]] · [[asset-category]] · [[0006-soft-delete-and-auditing]] ·
[[0017-location-type-enum]] · [[0033-asset-history-event-model]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0046-roles-permissions-v2]] · [[0084-update-awareness-and-guided-update]] ·
[[0097-ai-assistant-mcp-and-headless-api]]
