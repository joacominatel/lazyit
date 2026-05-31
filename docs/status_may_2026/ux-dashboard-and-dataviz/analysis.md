# UX/UI — the dashboard (currently a placeholder) & operational data viz

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Frontend / UX**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The dashboard is a dead placeholder advertising a non-pillar (tickets) with no backend to feed it — every "needs attention" signal (warranties, lost/maintenance assets, low stock, expiring critical-app grants) already lives in the schema and just needs one composed /dashboard/summary endpoint plus a unified activity feed.

## Findings (9)

### 1. Dashboard is a dead placeholder advertising a non-existent pillar (tickets)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | medium | high |

- **Location:** `apps/web/app/(app)/dashboard/page.tsx:9,25,28; layout.tsx:28; sidebar-nav.tsx:21`
- **Why it matters:** The default landing route (sidebar logo + first nav item both point to /dashboard) shows three hardcoded cards with literal '—' and 'No data yet', and one card is 'Open tickets' — Tickets are explicitly NOT a pillar and not even a model in schema.prisma. The first screen every operator sees on every login is empty and signals scope creep, contradicting the 'ServiceNow-grade, at-a-glance' promise.
- **Recommendation:** Replace with a real asset-centric dashboard; immediately drop the 'Open tickets' card. Full build depends on the summary endpoint (F2).

### 2. No metrics/aggregation endpoint exists — the dashboard has nothing to call

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | large | high |

- **Location:** `apps/api/src/app.module.ts:30-58; packages/shared/src/index.ts`
- **Why it matters:** None of the 18 modules expose stats; @lazyit/shared has no dashboard contract. A dashboard on the current list endpoints would download every asset/grant/consumable/history row and count client-side (worse with SEC-007 no-pagination). The soft-delete extension already filters count/aggregate/groupBy (soft-delete.extension.ts:32-39), so server-side aggregates are safe.
- **Recommendation:** Add a DashboardModule with one read-only GET /dashboard/summary returning a single typed DashboardSummary (zod in shared, createZodDto per ADR-0018) composing cheap count/groupBy aggregates. One round-trip; it is the keystone backend ask.

### 3. 'Needs attention' signals exist in the data but are never surfaced

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | medium | high |

- **Location:** `schema.prisma:144,138,163-170,435-437,381-383,347; consumables.service.ts:48-54; access-grants.service.ts:41`
- **Why it matters:** Asset.warrantyEnd, Asset.status (IN_MAINTENANCE/LOST/UNKNOWN), Consumable lowStock (working filter in consumables.service.ts:48-54), AccessGrant.expiresAt/revokedAt, and Application.isCritical all exist and are partly queryable already — but nothing aggregates them onto a landing screen. 'What needs my attention today' is the #1 IT-generalist question and these are vanity-free, actionable signals.
- **Recommendation:** A top 'Needs attention' zone: warrantyExpiringSoon/Expired, assets groupBy status in {maintenance,lost,unknown}, lowStockCount, grantsExpiringSoon/Expired (+ criticalGrantsExpiring joined to isCritical). Each returns count + 3-5 row preview + deep-link into the pre-filtered pillar list.

### 4. No unified activity feed; AssetHistory is locked to a single asset

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | high |

- **Location:** `apps/api/src/asset-history/asset-history.service.ts:62-71; assets.controller.ts:138-153; schema.prisma:212,228`
- **Why it matters:** AssetHistory.list is scoped to one assetId and only reachable via GET /assets/:id/history; there's no org-wide feed and no analog for AccessGrant/ConsumableMovement. The polished vertical-timeline component already exists but renders one asset only. AssetHistory is indexed (assetId,id) with no global id/createdAt index, so an org-wide 'newest 20' query isn't index-backed. 'What changed recently' is the second daily question and the asset-centric 'history is automatic' promise is only half-delivered.
- **Recommendation:** Add GET /dashboard/activity returning ~20 newest events org-wide pre-joined to asset name + actor; add a global index on AssetHistory (index-only migration, respects ADR-0006). Reuse the timeline generalized to take pre-resolved rows; later fold in grant/movement events as a typed ActivityEvent union.

### 5. No charting/data-viz library installed — distribution viz needs a deliberate choice

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| infra | medium | small | high |

- **Location:** `apps/web/package.json (dependencies); asset-status-badge.tsx:11-15; asset-history-timeline.tsx:153-163`
- **Why it matters:** apps/web has heroicons/lucide/radix/markdown/cmdk/sonner/react-query/Tailwind but no recharts/visx/nivo/d3. Existing 'viz' is pure CSS (status dots, hand-rolled timeline, tabular-nums). A heavy charting lib conflicts with the boring/durable/self-hosted/small ethos; hand-rolling everything is inconsistent.
- **Recommendation:** For v1 use CSS/SVG primitives, no new dep: status distribution as a horizontal stacked segmented bar reusing the status tone palette; a ~30-LOC SVG polyline Sparkline helper; Card + tabular-nums KPIs. Adopt a lib only later via ADR if interactive charts are wanted.

### 6. Pillar health (Inventory/Access/Knowledge) is computable but the contract must avoid N round-trips

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `schema.prisma:163-170,306-309,368-399,347; assets/page.tsx:119-123`
- **Why it matters:** Each pillar has a natural groupBy/count health summary (assets by status / unassigned / no location; active grants, grants on critical apps, orphan apps; articles by DRAFT/PUBLISHED, never-published), all auto-excluding soft-deleted. Surfacing Access health up front matters given the RBAC gap (only place with app-level authZ today).
- **Recommendation:** Fold three compact pillar-health cards (headline count + segmented bar + 1-2 cleanup hints + deep-link) into the same /dashboard/summary response; do not add per-pillar dashboard endpoints (re-introduces the N-round-trip problem).

### 7. Drill-downs blocked: list pages don't initialize filters from the URL (and no pagination)

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | medium | small | medium |

- **Location:** `apps/web/app/(app)/assets/page.tsx:99-107; assets.controller.ts:60-90`
- **Why it matters:** The dashboard's value depends on 'View all →' landing on a pre-filtered list, but assets/page.tsx reads filters from React state only — a link like /assets?status=LOST won't pre-select. The API already accepts ?status/categoryId/locationId/q and /access-grants and /consumables?lowStock, so only the frontend gap remains. SEC-007 (ADR-0030 unimplemented) means big filtered lists still load everything.
- **Recommendation:** When building the dashboard, also init destination list filters from searchParams (small per-page change, fits ADR-0020). Treat ADR-0030 pagination as a parallel dependency, not a v1 blocker given small-org sizes.

### 8. No 'empty estate' onboarding story; the dashboard is the natural home for it

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | medium |

- **Location:** `apps/web/app/(app)/dashboard/page.tsx (whole file); assets/page.tsx:160-173`
- **Why it matters:** List pages have thoughtful first-run EmptyState CTAs ('Create your first…'), but the dashboard shows three 'No data yet' cards with no next step. For a self-hosted one-command-setup tool aimed at IT generalists, the first five minutes drive adoption and the landing screen is where a setup checklist belongs.
- **Recommendation:** When /dashboard/summary reports ~0 assets, render a setup-checklist card (reuse EmptyState styling) following the documented build order (Location → AssetModel/Category → Asset → …); swap to real widgets once data exists. No extra call — the summary carries the counts.

### 9. Sidebar links to unbuilt routes (/tickets, /settings) — don't deepen the dead-link debt

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | quick-win | high |

- **Location:** `apps/web/components/sidebar-nav.tsx:23,29`
- **Why it matters:** sidebar-nav lists Tickets→/tickets and Settings→/settings; neither route exists, and Tickets is a non-pillar given a top-level slot. Shipping a polished dashboard next to dead nav links undercuts the 'ServiceNow-grade' feel; the dashboard is the hub these radiate from.
- **Recommendation:** Out of dashboard scope to fix, but recommend the frontend lane hide/implement /tickets and /settings; and do not add dashboard tiles linking to unbuilt routes.

## Quick wins

- Drop the 'Open tickets' card from dashboard/page.tsx:9 — it advertises a non-pillar that isn't even in the schema (one-line change, stops scope-creep signaling on the landing screen).
- Wire the three placeholder count cards to real numbers via existing hooks (useAssets/useUsers/useConsumables({lowStock:true})) showing .length instead of '—' as an interim until /dashboard/summary lands.
- Add a ~30-LOC pure zero-dep Sparkline SVG helper under apps/web/components/ to unblock every trend viz without a charting-dependency decision.
- Generalize AssetHistoryTimeline into a reusable ActivityTimeline taking pre-resolved events — reuses the existing event tone map + relative-time/absolute-title tooltip; pure refactor.
- URL-sync the assets list filters from searchParams so dashboard 'View all →' drill-downs land pre-filtered (the API already accepts the query params).

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
