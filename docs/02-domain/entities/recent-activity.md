---
title: RecentActivity
tags: [domain, entity, view]
status: accepted
created: 2026-06-01
updated: 2026-06-01
---

# RecentActivity

> 🟢 implemented · Area: Dashboard (derived) · see [[0044-recent-activity-view]]

## Purpose

A **derived, read-only** unified activity feed for the dashboard — one chronological "what happened
across the IT estate?" stream, newest first. Not a table: it is a **Postgres VIEW**
(`recent_activity`) that `UNION ALL`s the four append-only activity sources. Nothing writes to it; it
has no id, no timestamps of its own, no soft delete. Requested by the CEO directly ("podemos hacerlo
con una view"). See [[0044-recent-activity-view]].

## Sources merged

| Source | Maps to | `entityType` | `action`(s) |
| --- | --- | --- | --- |
| [[asset-history]] | the event row | `asset` | the lowercased `eventType` (`created`, `status_changed`, …) |
| [[asset-assignment]] | open / close | `asset` | `assigned` (`assignedAt`) · `released` (`releasedAt`) |
| [[access-grant]] | open / close | `application` | `granted` (`grantedAt`) · `revoked` (`revokedAt`) |
| [[consumable-movement]] | each movement | `consumable` | `stock_in` / `stock_out` / `stock_adjustment` |

## Normalized row (`RecentActivityItem`)

- `occurredAt` — `timestamptz`; when the event happened. The feed is ordered by this, desc.
- `actorId` — the acting [[user]]'s id (uuid), or `null` for a system/unknown actor or a deleted
  actor whose audit FK was set null.
- `actorName` — the actor's display name (`firstName || ' ' || lastName`), resolved with a `LEFT JOIN`
  to `users` in the API read (lightly); `null` when there is no resolvable actor.
- `entityType` — `asset` · `application` · `consumable` (the pillar the affected entity belongs to).
- `entityId` — the affected entity's id (a cuid).
- `action` — a stable machine verb (see the table above).
- `summary` — a terse, server-built English sentence for the feed line.

The schema lives in `@lazyit/shared` (`schemas/recent-activity.ts`): `RecentActivityItemSchema` +
`RecentActivityPageSchema` (a `Page<T>` envelope — [[0030-list-pagination-contract]]).

## Business rules

- **Soft delete:** the view filters out rows whose **parent** entity (asset / application /
  consumable) is soft-deleted — it joins each branch to its parent on `deletedAt IS NULL`, since the
  Prisma soft-delete extension ([[0032-soft-delete-middleware]]) does not touch raw SQL. The four
  log/join tables are themselves append-only (no `deletedAt`).
- **Read-only & derived:** there is no persisted RecentActivity entity; the figures come straight
  from the four sources. New sources extend the feed by adding a `UNION ALL` branch to the view.
- **Headline, not full detail:** `summary` is a one-line headline; richer per-event detail (e.g. a
  status `from → to`) is NOT carried here — the per-asset [[asset-history]] timeline still owns that.

## Exposure

`GET /dashboard/activity` — paginated (offset, default 50; the web requests ~20), newest first,
read with a typed `$queryRaw` in `DashboardService.getActivity`. The web renders it as the
dashboard's "Recent activity" panel via the data layer ([[0020-frontend-data-layer]]):
`useDashboardActivity` (infinite query) → `RecentActivityPanel`.

> [!warning] Access: the dashboard panel is ADMIN-only at the UI level (issue #179)
> The feed is the cross-pillar "who-did-what" stream, so it is treated as sensitive. The web only
> renders `RecentActivityPanel` (on the dashboard and on the Reports/Informes screen) when the
> caller holds `logs:read` ([[0046-roles-permissions-v2]]), which is ADMIN-only — fail-closed, so a
> non-admin never sees it. **This is a v1 UI-LEVEL gate only:** the endpoint itself still authorises
> on `dashboard:read` (visible to every role), so a non-admin can still reach the data directly. A
> dedicated `logs:read`-gated endpoint is tracked debt (DEBT-1), shared with the Informes screen.

> [!note] Supersedes the old AssetHistory-only slice
> The earlier `DashboardSummary.recentActivity` field (AssetHistory only, never rendered) is
> superseded by this unified feed. It is kept on the summary contract for backward compatibility but
> is no longer used by the web; removing it is a future cleanup.

Related: [[0044-recent-activity-view]] · [[asset-history]] · [[asset-assignment]] · [[access-grant]] ·
[[consumable-movement]] · [[0030-list-pagination-contract]] · [[0032-soft-delete-middleware]] ·
[[0020-frontend-data-layer]].
