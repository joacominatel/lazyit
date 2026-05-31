# UX/UI — asset, consumable & location screens

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Frontend / UX**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The inventory screens are clean but desktop-only and one-shot: no mobile/floor experience, no pagination/sort/bulk/saved-views, split server/client filters that break at scale, and no location detail — solid foundations that don't yet scale to the platform the CEO wants.

## Findings (10)

### 1. No mobile / on-the-floor experience — the app shell is desktop-only

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | medium | high |

- **Location:** `apps/web/app/(app)/layout.tsx:25; components/sidebar-nav.tsx`
- **Why it matters:** The brief explicitly calls out a technician moving through a building, and inventory work is physical, but the sidebar is hidden below md with no hamburger/drawer and the 9-column tables overflow on a phone — the most physical pillar is unusable where it's most needed.
- **Recommendation:** Drop SidebarNav into the existing unused components/ui/sheet.tsx behind a hamburger in the topbar; add a responsive table→card layout for all three lists under md; ensure 44px tap targets.

### 2. Lists never paginate, sort, or virtualize — every row rendered unbounded

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | large | high |

- **Location:** `components/resource-table.tsx:67-118; assets/page.tsx:250-294; assets.service.ts:54-76`
- **Why it matters:** The CEO wants a large platform; assets is the table most likely to reach thousands of rows, yet ResourceTable maps the full array with fixed server sort, no column sorting, no pagination, no virtualization. ADR-0030's Page<T> contract is unimplemented (SEC-007). grep for sort/virtuali/bulk/density across the web app returned zero matches.
- **Recommendation:** Implement deferred ADR-0030 on GET /assets first (front+back, split per workflow); add sortable column headers; near-term ship client-side column sorting of the loaded array as a quick win.

### 3. Filtering is split inconsistently between server and client — silently breaks under pagination

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| bug | medium | medium | high |

- **Location:** `assets/page.tsx:99-125; consumables/page.tsx:69-101; consumables.service.ts:42-52`
- **Why it matters:** Assets ownership filter and consumables search+category are applied client-side over server results, while assets q/status/category and consumables lowStock are server-side. This is only coherent because lists are unbounded; the moment ADR-0030 caps a page at 50, client-side filters will filter only the visible page and return wrong results.
- **Recommendation:** Move all filters server-side as part of the ADR-0030 work (add ownership to AssetFilters, q/categoryId to ConsumableFilters); until then keep filters client-side consistently and document the constraint.

### 4. Asset detail shows ownership three times and is a narrow single column

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | small | high |

- **Location:** `assets/[id]/page.tsx:189-282; asset-history-timeline.tsx:80-105`
- **Why it matters:** The brief asks for a rich at-a-glance object view, but the detail page renders an Owners panel, an Activity timeline that already emits ASSIGNED/RELEASED, and a separate Ownership history panel — redundant ownership data, two assignment queries, all in a max-w-4xl single column that reads like a form.
- **Recommendation:** Reorganize into a two-column object view (sticky identity/specs summary + one unified activity stream); replace the Owners panel with a compact owner chip-row and drop the standalone Ownership history panel (timeline already carries it).

### 5. No location detail / 'assets here' view, and the RACK type has no visual payoff

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | medium | high |

- **Location:** `apps/web/app/(app)/locations/ (no [id]/); global-search.tsx:198-205; schema.prisma:58-86`
- **Why it matters:** Location is a core Inventory entity but is list+dialog only: no locations/[id] route, location names aren't links, global search dumps you on the list, and despite a RACK location type and a location.assets relation nothing surfaces what lives at a location. 'What's in this rack / on this floor' is a primary IT question for walk-throughs.
- **Recommendation:** Add locations/[id] with an assets-at-location table reusing the existing locationId server filter; make names links; PROPOSAL: a rack-elevation view for RACK locations (needs a small schema add — flag to CTO/CEO).

### 6. Stock movements ledger has end-to-end filtering the UI never exposes

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | quick-win | high |

- **Location:** `consumables/[id]/page.tsx:65,213-273; consumables.service.ts:143-162; use-consumables.ts`
- **Why it matters:** The backend listMovements supports type + date-range filters and the web hook already threads a query arg, but the consumable detail calls it with no query and renders the whole ledger with no filters and no running-balance column — the capability is built and simply unsurfaced.
- **Recommendation:** Add a type segmented control + optional date range wired to the existing query arg, plus a client-computed running-balance column. Frontend-only.

### 7. Stock adjust requires drilling into the detail page; no quick-adjust from the list

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | medium | high |

- **Location:** `consumables/page.tsx:225-234; consumables/[id]/page.tsx:146-167; stock-movement-dialog.tsx`
- **Why it matters:** Restocking is the highest-frequency consumable action and is an at-the-shelf task, but Add/Remove/Adjust live only on the detail Stock panel; the list RowActions offers Edit/Delete only, so even a low-stock-flagged item takes two navigations to restock.
- **Recommendation:** Add Add/Remove/Adjust (or an inline +/- control) to the consumable row RowActions, opening the existing StockMovementDialog from the list; add a one-click Restock affordance in the low-stock view. Reuses existing dialog+mutation.

### 8. No faceted search, saved views, or quick filters — discovery is one-shot

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | medium |

- **Location:** `assets/page.tsx:176-243; consumables/page.tsx:148-183`
- **Why it matters:** The filter bar is single-select dropdowns with no result counts, no chips, no clear-all, and no way to persist a combination. Operators re-ask the same queries; saved views are the ServiceNow-grade capability the positioning promises minus the complexity.
- **Recommendation:** Sequence: active-filter chips + Clear (quick UI) → URL-state serialization for shareable views (free) → facet counts (needs backend aggregates) → named per-user views. Depends on pagination landing.

### 9. No bulk actions / multi-select anywhere

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | medium | large | high |

- **Location:** `components/resource-table.tsx:121-154; assets/page.tsx; consumables/page.tsx`
- **Why it matters:** ResourceTable has no selection column; every op is per-row Edit/Delete. Real inventory work is batch (relocate a closed office, retire 30 EOL machines, set 10 new arrivals to In Storage). One-row-at-a-time grind is what pushes teams back to spreadsheets.
- **Recommendation:** Add an optional selection column + a bulk action bar (Set status / Relocate / Delete with count-confirm). Needs batch backend endpoints; gate bulk-destructive ops behind RBAC maturing (currently every user is equal).

### 10. Asset specs render as raw key/value JSON and cannot be edited in the UI

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | high |

- **Location:** `assets/[id]/page.tsx:172-187; asset-form.tsx:46-56`
- **Why it matters:** Flexible jsonb specs (ADR-0007) are a central feature, but the detail page prints raw keys and JSON.stringify of non-string values, and asset-form.tsx has no specs field at all — so the richest part of an asset is display-only and shown as {"foo":["a","b"]}.
- **Recommendation:** Render specs from the per-category zod schema (humanized labels, units, chips); add a schema-driven specs editor to asset-form.tsx (larger, front+back+shared). Near-term: Title-Case keys and render arrays as chips.

## Quick wins

- Expose the consumable movements filter (type segmented control + date range) using the already-supported query arg, and add a running-balance column — backend already supports it
- Add Add/Remove/Adjust to the consumables list RowActions opening the existing StockMovementDialog (quick-adjust without leaving the list)
- Make ResourceTable column headers clickable to client-side sort the already-loaded array (Name/Updated/Stock) — no backend
- Render active filters as removable chips with a Clear-all above the asset/consumable tables
- Add a mobile nav drawer: drop SidebarNav into the existing unused components/ui/sheet.tsx behind a topbar hamburger below md
- Make location names link to a pre-filtered assets list (/assets?locationId=…) — the locationId server filter already exists
- Format asset specs keys (camelCase→Title Case) and render arrays as chips instead of JSON.stringify
- Add a non-color 'Low'/'Out' textual companion to the StockBadge for colorblind accessibility (WCAG 1.4.1)

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
