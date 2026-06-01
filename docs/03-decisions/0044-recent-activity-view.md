---
title: "ADR-0044: Dashboard recent-activity feed backed by a unified DB view"
tags: [adr, api, dashboard, database]
status: accepted
created: 2026-06-01
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0044: Dashboard recent-activity feed backed by a unified DB view

## Status

accepted — 2026-06-01. Decided by the CEO directly: *"En el dashboard tenemos que manejar un
historial de recent activity, podemos hacerlo con una view."* Additive feature on top of the
read-only dashboard ([[02-domain/entities/recent-activity|recent-activity]], dashboard from PR #61);
the **only** migration in its change. Builds on the pagination contract
([[0030-list-pagination-contract]]) and the soft-delete posture ([[0032-soft-delete-middleware]]).

## Context

The dashboard needs a **single chronological "what happened across the IT estate" feed**, not four
separate per-area lists. The append-only activity already exists in four tables:

- `asset_history` — discrete asset state changes ([[0033-asset-history-event-model]]).
- `asset_assignments` — ownership opened (`assignedAt`) / closed (`releasedAt`).
- `access_grants` — access opened (`grantedAt`) / closed (`revokedAt`) ([[0023-access-management-design]]).
- `consumable_movements` — stock IN / OUT / ADJUSTMENT ([[0034-consumables-design]]).

The pre-existing `DashboardSummary.recentActivity` was an **AssetHistory-only** slice (it never even
rendered on the web). We want one merged stream, newest first, paginated.

## Considered options

1. **A Postgres VIEW (`recent_activity`) `UNION ALL`ing the four sources**, read with a typed
   `$queryRaw`. *(chosen — the CEO asked for a view explicitly.)*
2. Compose the four lists in the service (four `findMany`s + an in-memory merge/sort). More app code,
   no single orderable/paginable source, and pagination across four merged lists is awkward.
3. Enable Prisma's `views` preview feature and model the view in PSL. Adds a preview-feature flag and
   still cannot express the `UNION` body (Prisma would only *introspect* a hand-written view) — so it
   buys nothing over option 1 while widening the schema surface.

## Decision

- Add a Postgres **VIEW `recent_activity`** that `UNION ALL`s the four sources into one normalized row:
  `{ occurredAt timestamptz, actorId uuid?, entityType text, entityId text, action text, summary text }`,
  newest-first when ordered by `occurredAt`. Prisma **cannot express a UNION view in PSL**, so the
  view lives as **raw SQL in a migration** (`recent_activity_view`), the same "SQL Prisma can't
  represent" pattern as the partial unique indexes ([[prisma-migrations]] §3). It is purely
  **derived**: no table changes, nothing writes to it, and Prisma neither emits nor flags it as drift.
- **Soft delete:** the soft-delete query extension ([[0032-soft-delete-middleware]]) does NOT
  touch raw SQL, so the view filters deleted parents itself — every branch joins to its parent
  (`assets` / `applications` / `consumables`) and keeps only `deletedAt IS NULL` rows, matching the
  rest of the dashboard. The four log/join tables are append-only (no `deletedAt`), so only the
  parent's soft-delete is relevant.
- **Read strategy:** a typed `$queryRaw` in `DashboardService.getActivity` — **not** the Prisma
  `views` preview feature (option 3 bought nothing). Offset-paginated per [[0030-list-pagination-contract]]
  (default page size 50; the web requests ~20), with the page slice and `COUNT(*)` over the view in
  one `$transaction` so `total` can't drift. The actor **display name** is resolved with a `LEFT JOIN`
  to `users` in the read (lightly — `firstName || ' ' || lastName`); `actorId`/`actorName` are null
  for a system/unknown actor or a deleted actor whose audit FK was set null.
- **Contract:** `RecentActivityItemSchema` + `RecentActivityPageSchema` (a `Page<T>`) in
  `@lazyit/shared`, exposed at **`GET /dashboard/activity`** and consumed by the web data layer
  ([[0020-frontend-data-layer]]) as a "Recent activity" panel (endpoint → `useDashboardActivity`
  infinite query → `RecentActivityPanel`), with loading / empty / error states.

## Consequences

- **Positive:** one orderable, paginable source of truth for cross-pillar activity; the merge/sort is
  the database's job, the API just pages and shapes it. New activity sources (e.g. a future Ticket or
  Article log) extend the feed by adding a `UNION ALL` branch to the view — no API change.
- **`action` / `summary` are server-built, not localized.** `action` is a stable machine verb
  (`created`, `assigned`, `granted`, `stock_in`, …); `summary` is a terse English sentence. The web
  maps `entityType` to an icon + a link target. Richer per-event detail (e.g. status from→to) is **not**
  carried — the feed is a headline stream; the per-asset history timeline still owns full detail.
- **`DashboardSummary.recentActivity` is now redundant** (superseded by this feed) but kept on the
  summary contract for backward compatibility; the web dashboard no longer renders it. Removing it is
  a future cleanup.
- **Residual:** the view re-derives soft-delete filtering in SQL (it can't reuse the Prisma
  extension) — a documented duplication to keep in step if the soft-delete columns ever move.
  Offset pagination's deep-page cost is accepted at this scale ([[0030-list-pagination-contract]]).

## References

- [[02-domain/entities/recent-activity]] (entity note) · [[0030-list-pagination-contract]] ·
  [[0032-soft-delete-middleware]] · [[0033-asset-history-event-model]] ·
  [[0023-access-management-design]] · [[0034-consumables-design]] ·
  [[0018-api-documentation-swagger]] · [[0020-frontend-data-layer]] · [[prisma-migrations]] §3.
