# UX/UI — overall design language, brand, navigation & information architecture

> Status snapshot — **2026-05-30** (`status_may_2026`). Team: **Frontend / UX**.
> Produced by a senior-analyst pass in the CTO multi-agent review fleet. Findings below are this analyst's structured digest (top findings, highest priority first).

**Headline:** The web app is functionally solid but reads as an unbranded wireframe: zero brand color, a desktop-only nav, a placeholder dashboard, dead links, and no first-run experience — the design language doesn't yet deliver the "modern, IT-native, anti-ServiceNow" mandate.

## Findings (11)

### 1. No brand, no color — the entire palette is grayscale (chroma 0), so the product reads as a wireframe

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | medium | high |

- **Location:** `apps/web/app/globals.css:53-120`
- **Why it matters:** "Modern, opinionated, IT-native, anti-ServiceNow" cannot land with zero brand color — a pure-grayscale UI with near-black buttons is indistinguishable from a shadcn starter, exactly the generic-AI look the mandate rejects. Color is also the cheapest hierarchy tool; with no accent, the primary action, status badges, and body text compete on the same value axis.
- **Recommendation:** Introduce ONE disciplined brand accent on the neutral canvas (e.g. deep indigo ~oklch(0.55 0.18 275) or signal teal ~oklch(0.62 0.13 195)); wire it to --primary/--ring/--sidebar-primary; add --success/--warning/--info semantic tokens (only --destructive exists today; amber 'Expired' is a hardcoded inline className) and a real chart ramp. Remove the dead, dark-only, unused --sidebar-primary blue orphan. Treat explicitly as a PROPOSAL to amend ADR-0011's 'neutral, not flashy' stance.

### 2. App is desktop-only by construction — sidebar is hidden md:flex with no mobile/tablet navigation

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | small | high |

- **Location:** `apps/web/app/(app)/layout.tsx:25`
- **Why it matters:** Below 768px the sidebar is removed and never replaced — no hamburger, no drawer. A Sheet primitive is vendored but imported nowhere. An IT generalist checking an asset or granting access from a phone at a rack has no way to navigate except typing URLs or ⌘K. This is the most visible 'unfinished' signal for a self-hosted, field-operable tool.
- **Recommendation:** Wire the existing components/ui/sheet.tsx into a md:hidden hamburger in the topbar that opens a Sheet containing the already-extracted SidebarNav. ~1-2h.

### 3. Dashboard (the post-login landing page) is a hardcoded placeholder showing '—' and advertises unbuilt Tickets

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | high | medium | high |

- **Location:** `apps/web/app/(app)/dashboard/page.tsx:9-34`
- **Why it matters:** The default destination after login renders three cards (Assets / Open tickets / Users) whose value is a literal em-dash and body is 'No data yet.' One card is for Tickets — an unbuilt, non-pillar feature. The first screen every user sees shows no real data and advertises something that doesn't exist, making the whole product feel half-built.
- **Recommendation:** Reframe around the three pillars (Inventory/Access/Knowledge) with deep links into filtered lists; drop the Open tickets card until Tickets ship; until a stats endpoint exists (backend's lane) show an honest first-steps/activity dashboard instead of dead '—' cards.

### 4. No first-run / onboarding experience for a fresh self-hosted instance

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| feature | high | large | high |

- **Location:** `apps/web/app/(app)/dashboard/page.tsx + per-screen EmptyState in components/resource-table.tsx:157-180`
- **Why it matters:** The headline promise is one-command setup, but setup ends at a blank, orderless app: dead dashboard, no setup checklist, no guided first-asset flow, and no hint of the required domain order (Locations -> Categories/Models -> Assets), so the first 'New asset' attempt hits empty selects. With no sales engineer, the product itself is the only onboarding — the biggest lever on perceived completeness.
- **Recommendation:** Design a first-run setup checklist on the dashboard (Add locations -> categories/models -> first asset -> apps -> first article), each item linking into the create flow and checking off when >=1 record exists (derivable from existing list hooks). Optional one-time welcome modal naming the three pillars.

### 5. Sidebar IA is a flat 9-item list with two dead links and no pillar grouping; won't scale

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | small | high |

- **Location:** `apps/web/components/sidebar-nav.tsx:20-30`
- **Why it matters:** NAV is a flat array of 9 items; /tickets and /settings route nowhere (no directory under app/(app)/), so clicking them hits the error boundary/404. The three pillars are the product's organizing principle but the nav doesn't reflect them — Inventory entities, Access, Knowledge, a dead Tickets, and a dead Settings all sit at the same level. As the platform grows this sprawls.
- **Recommendation:** Remove the dead /tickets and /settings links now (5-min quick win), then group nav by pillar (INVENTORY: Assets/Consumables/Locations/Users; ACCESS: Applications; KNOWLEDGE: KB) with Dashboard pinned and admin at the bottom, using shadcn's grouped sidebar.

### 6. Marketing landing says 'Coming soon' for a product that is shipping/self-hostable today, and lists unbuilt Tickets

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | medium | quick-win | high |

- **Location:** `apps/web/app/(marketing)/page.tsx:5-7,11`
- **Why it matters:** The operator is already running the product when they see the public page, so 'Coming soon' is incoherent and undercuts trust. The hero also lists 'tickets' as a feature (unbuilt non-pillar) and offers anonymous visitors a Dashboard link that just bounces to /login.
- **Recommendation:** Drop 'Coming soon'; reframe the hero around the three pillars + differentiators (self-hosted, no telemetry, exportable, one-command setup); remove 'tickets' or label as roadmap; fix the anonymous Dashboard nav link. ~1h.

### 7. Inconsistent list design language: every entity uses ResourceTable except KB, which forks its own card list/skeleton/empty states

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | high |

- **Location:** `apps/web/app/(app)/kb/page.tsx:140-142,159-210 vs assets/page.tsx & applications/page.tsx`
- **Why it matters:** Assets/Applications/Consumables/Users/Locations share ResourceTable with consistent skeleton/empty/filtered-empty behavior; KB hand-rolls a card <ul>, its own SkeletonCards, and an inline filtered-empty <p> instead of the EmptyState component. The state system is forked and the visual rhythm differs. Cards are defensible for prose, but the divergence makes the product feel assembled rather than designed.
- **Recommendation:** Keep cards for KB but extract a shared CardList + CardListSkeleton and reuse the same EmptyState/filtered-empty components; document the rule (tables for records, cards for content).

### 8. Panel/Detail layout components and the detail-page skeleton are copy-pasted verbatim across 3 detail pages

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| code-quality | low | quick-win | high |

- **Location:** `apps/web/app/(app)/assets/[id]/page.tsx:303-331 ; applications/[id]/page.tsx:319-348 ; consumables/[id]/page.tsx`
- **Why it matters:** Panel and Detail are defined byte-for-byte in assets/[id], applications/[id], and consumables/[id]; the loading skeleton and not-found branch are duplicated too. Three copies guarantee drift — the moment one detail page gets a brand-accent or spacing tweak, the others fall behind, eroding the cross-screen consistency that is a core design goal (and the project already follows define-then-reuse per ADR-0020).
- **Recommendation:** Promote Panel, Detail, a DetailPageHeader, and DetailNotFound into components/ (e.g. detail-layout.tsx). Mechanical, no behavior change, ~1h — and the single place to later apply brand accents to panel headings.

### 9. No motion/density point of view: library-default animations, single radius, zero prefers-reduced-motion handling

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | high |

- **Location:** `apps/web/app/globals.css:1-2,77`
- **Why it matters:** Motion is entirely delegated to tw-animate-css defaults with no custom keyframes or motion tokens, and no prefers-reduced-motion/motion-reduce guard exists anywhere — both a missed 'modern, opinionated' opportunity (feel = whatever shadcn ships) and a real vestibular-accessibility gap once any animation is added.
- **Recommendation:** Define motion tokens (2-3 durations + one easing), standardize entrance/hover/press on them, add a global @media (prefers-reduced-motion: reduce), and pick a deliberate radius point of view (nudge tighter for a technical IT feel) to pair with the button's existing active press.

### 10. Shell wayfinding/a11y gaps: no skip-link, no breadcrumbs, no route-level loading/404, dead Profile/Settings menu items

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | small | high |

- **Location:** `apps/web/app/(app)/layout.tsx ; components/user-menu.tsx:66-67 ; missing loading.tsx/not-found.tsx ; assets/[id]/page.tsx:100`
- **Why it matters:** No skip-to-content link (keyboard/SR users tab the whole sidebar every nav); the user menu exposes permanently-disabled Profile/Settings (dead affordances like the dead sidebar links); no loading.tsx (no route-transition fallback) and no not-found.tsx (bad URLs/dead links fall to the generic error boundary); deep pages rely on a single back-button with no breadcrumb trail. These are the cumulative signals separating 'designed' from 'scaffolded' for a keyboard-first operator.
- **Recommendation:** Add a visually-hidden skip-link targeting <main>, a root not-found.tsx, an app-segment loading.tsx, and a shadcn breadcrumb on detail/edit pages; implement or remove the disabled Profile/Settings items.

### 11. ⌘K palette is search-only — the strongest IT-native surface is underused as a command bar

| Category | Severity | Effort | Confidence |
|---|---|---|---|
| frontend-ux | low | medium | medium |

- **Location:** `apps/web/components/global-search.tsx:58-242`
- **Why it matters:** The palette is excellent as search (server-side filter, scope chips, debounce, keyboard model, a11y) but has no actions or navigation mode, while cmdk is built for exactly that. A keyboard-first IT operator is the precise audience that lives in a command palette; turning ⌘K into a true command bar (create-X, navigate, toggle theme) is the signature 'modern, anti-ServiceNow' interaction and doubly mitigates the mobile-nav and wayfinding gaps.
- **Recommendation:** Add a command mode: when the query is empty/no-match, show a static action+navigation list (create each entity, go to each pillar, toggle theme, sign out) plus recents, grouped Actions / Navigate / entity results, reusing existing dialog/cmdk plumbing.

## Quick wins

- Remove the dead /tickets and /settings sidebar links and the disabled Profile/Settings menu items (sidebar-nav.tsx:23,29; user-menu.tsx:66-67) — eliminates broken navigation, ~10 min.
- Fix the marketing landing: drop 'Coming soon', remove 'tickets' from the feature list, reframe around the three pillars + self-hosted/no-telemetry ((marketing)/page.tsx), ~1h.
- Drop the 'Open tickets' dashboard card so the first screen doesn't advertise an unbuilt non-pillar; relabel the rest and add deep links (dashboard/page.tsx:9), ~30 min.
- Wire the existing Sheet primitive into a md:hidden hamburger nav reusing SidebarNav so the app is usable below 768px ((app)/layout.tsx), ~1-2h.
- Extract Panel/Detail/DetailPageHeader into components/ and import from the three detail pages to kill triplicate drift, ~1h.
- Add a skip-to-content link and a root not-found.tsx — cheap a11y + wayfinding wins, ~45 min.
- Set a single brand accent token in light and dark (--primary/--ring/--sidebar-primary) and remove the dead dark-only orphan blue (globals.css:53-120) — transforms the wireframe perception, ~1-2h.

---

_Note: this document was materialized from the analyst's structured digest. The four analyses with full long-form write-ups on disk (backend-completeness-gaps, backend-observability-ops, backend-search-subsystem, infra-ops-reliability) include extra Method / Strategic-recommendations / Open-questions sections; the rest carry the digest above._
