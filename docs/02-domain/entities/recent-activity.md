---
title: RecentActivity
tags: [domain, entity, view]
status: accepted
created: 2026-06-01
updated: 2026-06-04
---

# RecentActivity

> 🟢 implemented · Area: Dashboard (derived) · see [[0044-recent-activity-view]]

## Purpose

A **derived, read-only** unified activity feed for the dashboard — one chronological "what happened
across the IT estate?" stream, newest first. Not a table: it is a **Postgres VIEW**
(`recent_activity`) that `UNION ALL`s the **five** append-only activity sources. Nothing writes to it;
it has no id, no timestamps of its own, no soft delete. Requested by the CEO directly ("podemos hacerlo
con una view"). See [[0044-recent-activity-view]] and [[0050-user-history-and-activity-user-entity]]
(the fifth source).

## Sources merged

| Source | Maps to | `entityType` | `action`(s) |
| --- | --- | --- | --- |
| [[asset-history]] | the event row | `asset` | the lowercased `eventType`: `created` · `status_changed` · `assigned` · `released` · `location_changed` · `model_changed` · `specs_changed` · `deleted` · `restored` |
| [[asset-assignment]] | open / close | `asset` | `assigned` (`assignedAt`) · `released` (`releasedAt`) |
| [[access-grant]] | open / close | `application` | `granted` (`grantedAt`) · `revoked` (`revokedAt`) |
| [[consumable-movement]] | each movement | `consumable` | `stock_in` / `stock_out` / `stock_adjustment` |
| [[user-history]] (DEBT-2, #185) | the event row | `user` | the lowercased `eventType`: `created` · `updated` · `role_changed` · `deleted` · `restored` · `password_reset_sent` |

The full closed verb set is the single source of truth for the `action` filter's allowlist
(`RECENT_ACTIVITY_ACTIONS` in `@lazyit/shared`). An unknown verb on the filter is a 400, never a
silent no-match. Keep it in sync with the view if a new source verb is added.

## Normalized row (`RecentActivityItem`)

- `occurredAt` — `timestamptz`; when the event happened. The feed is ordered by this, desc.
- `actorId` — the acting [[user]]'s id (uuid), or `null` for a system/unknown actor or a deleted
  actor whose audit FK was set null.
- `actorName` — the actor's display name (`firstName || ' ' || lastName`), resolved with a `LEFT JOIN`
  to `users` in the API read (lightly); `null` when there is no resolvable actor.
- `entityType` — `asset` · `application` · `consumable` · `user` (the pillar the affected entity
  belongs to; `user` added by DEBT-2 — [[0050-user-history-and-activity-user-entity]]).
- `entityId` — the affected entity's id (a cuid for asset/application/consumable; a uuid for `user`).
- `action` — a stable machine verb (see the table above).
- `summary` — a terse, server-built English sentence for the feed line.

The schema lives in `@lazyit/shared` (`schemas/recent-activity.ts`): `RecentActivityItemSchema` +
`RecentActivityPageSchema` (a `Page<T>` envelope — [[0030-list-pagination-contract]]). The filterable
query is `RecentActivityQuerySchema` (the optional filters intersected with the pagination contract).

## Business rules

- **Soft delete:** the view filters out rows whose **parent** entity (asset / application /
  consumable / **user**) is soft-deleted — it joins each branch to its parent on `deletedAt IS NULL`,
  since the Prisma soft-delete extension ([[0032-soft-delete-middleware]]) does not touch raw SQL. The
  five log/join tables are themselves append-only (no `deletedAt`). **Consequence for `user`:** a
  `deleted` (offboard) row never appears in the feed (its subject is now soft-deleted) — the offboarding
  still surfaces via the released/revoked asset+access branches; a `restored` row *does* appear (the
  subject is live again). The full `deleted` event stays on the per-user [[user-history]] timeline.
- **Read-only & derived:** there is no persisted RecentActivity entity; the figures come straight
  from the five sources. New sources extend the feed by adding a `UNION ALL` branch to the view.
- **Headline, not full detail:** `summary` is a one-line headline; richer per-event detail (e.g. a
  status `from → to`) is NOT carried here — the per-asset [[asset-history]] timeline still owns that.

## Exposure

`GET /dashboard/activity` — gated on **`logs:read`** (issue #181), paginated (offset, default 50;
the web requests ~20), newest first, read with a typed `$queryRaw` in
`DashboardService.getActivity`. The web renders it as the dashboard's "Recent activity" panel via the
data layer ([[0020-frontend-data-layer]]): `useDashboardActivity` (infinite query) →
`RecentActivityPanel`, and the Reports/Informes screen.

### Filters (issue #181 / DEBT-1)

All OPTIONAL and additive — with none supplied the feed behaves exactly as before. Each is applied
server-side as a **parameterized** `WHERE` clause over the view (never string-concatenated; the
injection guard), and the page `total` reflects the SAME filtered count (the page read and the count
share one WHERE in a single `$transaction`, so they can't drift):

- `entityType` — one pillar (`asset` | `application` | `consumable`).
- `entityId` — one affected entity's id (exact match; pairs naturally with `entityType`).
- `actorId` — a user uuid **or** the literal `"me"`. `"me"` is resolved to the caller's own id
  **server-side** (from the authenticated principal) — the client is never trusted for the actor; a
  non-human caller asking for `"me"` is a 400 (it has no actor identity in this feed).
- `action` — one known verb from the closed `RECENT_ACTIVITY_ACTIONS` allowlist; an unknown verb → 400.
- `from` / `to` — a closed-open `[from, to)` window over `occurredAt` (ISO-8601 datetimes).
- `q` — free text matched case-insensitively (`ILIKE`) against `summary` **and** the resolved actor
  name; trimmed and capped at 200 chars.

> [!note] Access: the feed is ADMIN-only, now enforced at the endpoint (issue #181, DEBT-1 resolved)
> The feed is the cross-pillar "who-did-what" stream, so it is treated as sensitive. Both surfaces
> (the dashboard `RecentActivityPanel` and the Reports/Informes screen) are UI-gated on `logs:read`
> ([[0046-roles-permissions-v2]]) — ADMIN-only, fail-closed (issue #179). As of issue #181 the
> **endpoint** authorises on `logs:read` too, closing the earlier v1 gap where the data was reachable
> on `dashboard:read`; the UI and API gates now match.

> [!note] Supersedes the old AssetHistory-only slice
> The earlier `DashboardSummary.recentActivity` field (AssetHistory only, never rendered) is
> superseded by this unified feed. It is kept on the summary contract for backward compatibility but
> is no longer used by the web; removing it is a future cleanup.

Related: [[0044-recent-activity-view]] · [[asset-history]] · [[asset-assignment]] · [[access-grant]] ·
[[consumable-movement]] · [[0030-list-pagination-contract]] · [[0032-soft-delete-middleware]] ·
[[0020-frontend-data-layer]].
