---
title: "Status May 2026 — UX, Design Language & IA"
tags: [status, ux, frontend]
status: draft
created: 2026-05-30
updated: 2026-05-30
---

# UX, Design Language & Information Architecture — Status

> This folder belongs to the May 2026 22-analyst review. The narrative analysis was
> drafted separately; this file carries the Round 1 implementation log for the
> frontend UX-foundation work so the PR is self-contained.

## Round 1 implementation (CTO proposal)

Branch `feat/web-ux-foundation` — schema-free, `apps/web/**` only. Implements the
CTO's frontend UX-foundation proposal (modern, anti-ServiceNow; no backend
dependency).

1. **Brand & color (`app/globals.css`).** Replaced the pure-grayscale palette
   (which read as a wireframe) with a single disciplined deep-indigo accent
   (`oklch(0.55 0.18 275)` light, a lighter `0.62 0.17 275` for contrast in dark)
   wired to `--primary`, `--ring` and `--sidebar-primary` in both themes via a
   shared `--brand` token. Added semantic `--success` / `--warning` / `--info`
   tokens (each with a paired foreground) and a brand-anchored categorical chart
   ramp (`--chart-1..5`). Removed the dead dark-only orphan blue that the previous
   `.dark --sidebar-primary` carried (never visible because dark `--primary` was
   grayscale).

2. **Mobile / on-the-floor nav.** New `components/mobile-nav.tsx` wires the
   already-vendored `ui/sheet.tsx` into a `md:hidden` hamburger in the topbar that
   opens a left Sheet containing the existing `SidebarNav`, making the app usable
   below 768px. The trigger is a 44px tap target (`size-11`); nav rows get
   `min-h-11` on touch (`md:min-h-9` keeps desktop density); the sheet auto-closes
   on navigation.

3. **Killed dead UI.** Removed the `/tickets` and `/settings` sidebar links (no
   such routes; lazyit is not a ticketing system — ADR-0016) and the disabled
   Profile/Settings items from the user menu. Reframed the dashboard around the
   three pillars (Inventory / Access / Knowledge) with static deep links into each
   area — no metrics endpoint is called (that is a separate PR). Reframed the
   marketing landing: dropped "Coming soon" and "tickets", led with
   "self-hosted · no telemetry" and three pillar cards.

4. **Security (SEC-003).** Hardened `components/markdown-view.tsx` with
   `rehype-sanitize` against a strict allow-list derived from `defaultSchema`
   (drops `<script>`/`<style>`, event-handler attributes and `javascript:` URLs;
   keeps GFM tables/task-lists; permits `target`/`rel` on links). This closes the
   stored-XSS vector in KB Markdown **by construction** — verified against a worst
   case with `rehype-raw` enabled: `<script>`, `onerror` and `javascript:` are all
   stripped while GFM markup survives. Added `rehype-sanitize@^6` to
   `apps/web/package.json`.

5. **Data-layer polish.** Added `placeholderData: keepPreviousData` to the four
   list hooks (`use-assets`, `use-consumables`, `use-articles`,
   `use-access-grants`), matching the pattern already in `use-search.ts`, so
   changing a filter no longer flashes the table skeleton.

6. **Resilience + a11y.** Added `app/not-found.tsx` (branded global 404) and
   `app/global-error.tsx` (root error boundary that renders its own document).
   Added `aria-live="polite"` to the command-palette result list and to the table
   empty/error regions (`ResourceTable` filtered-empty cell, `EmptyState`,
   `ErrorState`), plus a skip-to-content link as the first focusable element in the
   app shell jumping to `#main-content`.

**Verification.** `bunx tsc --noEmit` clean; `bun run build` succeeds (16 routes,
including the new `/_not-found`); the sanitizer behavior was confirmed with an
ad-hoc pipeline check (not committed — `apps/web` has no test runner per ADR-0012,
which defers frontend unit tests).

**Out of scope / deferred.** No schema or migration changes (Round 2). Dashboard
metrics, URL-param-driven list filters (so deep links can pre-filter), and a
frontend test runner are follow-ups.
