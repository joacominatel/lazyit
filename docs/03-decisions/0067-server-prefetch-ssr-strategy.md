---
title: "ADR-0067: Server-prefetch + hydration rendering strategy for high-traffic routes"
tags: [adr, frontend, rendering, ssr, tanstack-query, nextjs]
status: proposed
created: 2026-06-16
updated: 2026-06-16
deciders: [Joaquín Minatel]
---

# ADR-0067: Server-prefetch + hydration rendering strategy for high-traffic routes

## Status

**proposed** — 2026-06-16 (CTO recommendation; awaiting CEO ratification before implementation
begins). Issue #500. Implementation is deferred to a separate, ratified wave.

## Context

Issue #500 audited `apps/web` and found that **36 of 44 `page.tsx` files are Client Components**
(`"use client"`). Every list and detail page fetches its data client-side on first paint through
`useQuery` hooks (ADR-0020). No page uses `prefetchQuery`, `dehydrate`, or `<HydrationBoundary>`.
There is no `loading.tsx` in any segment, and a **single `(app)/error.tsx`** covers the entire
authenticated tree.

The practical consequence is a **skeleton → hydrate → fetch waterfall** on first load:

1. The browser receives an HTML shell with loading skeletons (no meaningful content).
2. React hydrates the Client Component tree.
3. TanStack Query fires `useQuery` — the network request goes out.
4. Data arrives; the skeleton is replaced.

For a self-hosted internal tool serving 5–20 people this is tolerable today. But it leaves the
App Router's server data-fetching capabilities entirely unused, it accrues architectural debt
(ADR-0020 explicitly noted this as a real fork to revisit once auth landed), and it produces
a degraded first-paint experience on every navigation to a list page.

**The auth prerequisite is now met.** ADR-0039 §6a established that `app/(app)/layout.tsx` is
a Server Component that resolves the session via `await auth()` before rendering the tree. A
server-side `access_token` is therefore available at render time without any additional
client/server round-trip. The session-seeding fix in issue #498 (on `stage` via PR #530) also
normalizes the provider/session boundary that this strategy builds on; that fix must land before
this strategy is implemented.

**What the App Router server-prefetch pattern looks like** (TanStack Query v5 + Next.js App Router):

```ts
// A page.tsx kept as a Server Component
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";

export default async function AssetsPage() {
  const session = await auth();
  const queryClient = new QueryClient();

  await queryClient.prefetchQuery({
    queryKey: assetKeys.lists(),
    queryFn: () => getAssets({ token: session.accessToken }),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AssetsListClient />
    </HydrationBoundary>
  );
}
```

The child `AssetsListClient` is a `"use client"` component that calls `useQuery` exactly as it
does today. On first paint, TanStack Query finds the query already in the dehydrated cache and
renders the data immediately — no skeleton flash. On subsequent navigations the client cache
takes over as before. The three-layer data path from ADR-0020 (`endpoints/` → `hooks/` → pages)
is preserved; only the page shell changes.

Each such page gets a per-request `QueryClient` (never a shared singleton) so server-rendered
state cannot bleed across users — a hard requirement for a multi-user internal tool.

## Considered options

### Option A — Status quo: pure client-side fetch via `useQuery` (current)

All 44 pages remain Client Components. TanStack Query fetches after hydration. No changes to the
rendering model.

**Rejected.** Tolerable today but consciously deferred debt (ADR-0020 noted it explicitly).
Leaves the App Router's server capabilities unused. Delivers a universally degraded first-paint
on all list and detail pages. The auth prerequisite that originally justified deferral is now
resolved.

### Option B — Full RSC migration: convert all 44 pages to Server Components

Move all data fetching to Server Components using `fetch` / direct endpoint calls. Remove or
reduce TanStack Query to mutations only.

**Rejected.** Large, disruptive change with low ROI for a 5–20-person internal tool:

- 44 pages, many with complex interactive state (dialogs, filters, optimistic updates), would
  all need to be restructured simultaneously.
- TanStack Query's client cache (stale-while-revalidate, optimistic mutations, invalidation)
  provides real UX value on an interaction-heavy CRUD tool; ripping it out is a net regression
  for interactive pages.
- The ADR-0020 three-layer data path (`endpoints/` → `hooks/` → pages) is a proven, consistent
  convention in use across all entity screens. A full RSC migration would split that convention
  inconsistently across the codebase mid-build.
- The implementation cost dwarfs the benefit at this scale.

### Option C — Targeted pilot: server-prefetch on high-traffic routes only (recommended)

Adopt the `prefetchQuery` + `dehydrate` + `<HydrationBoundary>` pattern **only on routes that
users hit on every session** (dashboard, entity list pages). Keep TanStack Query as the client
cache. Keep interactive child components as Client Components. Defer detail and edit pages.

**Chosen.** Delivers the most meaningful first-paint improvement (the pages people see first,
every time), with minimal structural churn, while preserving the ADR-0020 layering convention
and the full TanStack Query client cache.

## Decision

Adopt **Option C: targeted server-prefetch on high-traffic routes**, with the following scope
and rules.

### 1. In-scope routes (server-prefetch pilot)

The following routes become thin **Server Component** pages that prefetch their primary list
query before sending HTML to the browser:

- `/dashboard` — the landing page every user sees after login
- `/assets` — the primary inventory view
- `/applications` — application/access management list
- `/consumables` — consumables list
- `/users` — team members list
- `/locations` — locations list

These six routes cover the first-paint paths that every user traverses in a normal session.
Together they represent the highest ROI for the server-prefetch pattern.

### 2. Out-of-scope routes (deferred, remain client-fetched)

All detail pages (`/[entity]/[id]`), edit pages (`/[entity]/[id]/edit`), clone pages, the
Knowledge Base routes, the Secret Manager routes, and all setup/admin pages **remain fully
client-side** for this wave. They are lower-traffic and more interaction-heavy; the effort/reward
ratio does not justify the disruption now.

### 3. Mechanism: `prefetchQuery` + `dehydrate` + `<HydrationBoundary>`

Each in-scope `page.tsx` is converted from a Client Component to an `async` Server Component.
It:

1. Resolves the Auth.js session via `await auth()` to obtain `accessToken` (already available
   from the `(app)/layout.tsx` pattern established in ADR-0039 §6a).
2. Allocates a **per-request `QueryClient`** (never a module-level singleton — a singleton would
   leak state across concurrent requests on the server).
3. Calls `await queryClient.prefetchQuery({ queryKey, queryFn })` using the existing endpoint
   function from `lib/api/endpoints/`. The `queryKey` is the same key the child `useQuery` uses
   (from the `createQueryKeys` factory per ADR-0020) — this is what makes the dehydrated state
   hit on the client without a second fetch.
4. Returns `<HydrationBoundary state={dehydrate(queryClient)}>` wrapping the interactive child
   Client Component that contains the existing `useQuery` call.

The child Client Component is unchanged. On first paint it finds the query populated in the
dehydrated cache and renders data immediately. On subsequent navigations (client-side routing)
TanStack Query's in-memory cache takes over; the server-prefetch only benefits first/hard loads.

### 4. `loading.tsx` and `error.tsx` coverage

As part of this wave:

- A **group-level `app/(app)/loading.tsx`** is added, providing a fallback Suspense skeleton
  for the entire authenticated tree. Individual segments may override it.
- Per-segment `error.tsx` files are added to the `(auth)`, `(marketing)`, `(print)`, and
  `setup` route groups, so error handling is scoped rather than falling through to a single
  root boundary.

### 5. What does NOT change

- The ADR-0020 three-layer data path (`endpoints/` → `hooks/` → components) is fully preserved.
- The `QueryClient` used in `<QueryClientProvider>` (the client-side provider in the app
  providers tree) is unchanged — it is distinct from the per-request server-side `QueryClient`.
- The `useSession()` + `SessionProvider` client-side session model (ADR-0039) is unchanged.
- TanStack Query remains the client cache for all routes. No reads are moved to Server Actions
  or `fetch`-in-RSC without a `QueryClient`.
- Mutations (`useMutation`, invalidation) are unchanged.

### 6. Sequencing constraint

This strategy **must sequence after issue #498** (the first-paint session-seeding fix, on
`stage` via PR #530). Issue #498 normalizes how the session is threaded through the providers
and `apiFetch`; the server-prefetch pattern passes the `accessToken` from `auth()` into the
same `apiFetch` + endpoint functions — both touch the same session boundary. Implementing this
before #498 is merged would create merge conflicts and risk double-patching the session flow.

The `(app)/layout.tsx` belt-and-suspenders `auth()` call (ADR-0039 §6a) is the server-side
session resolution this pattern builds on; it is already in place.

## Consequences

### Positive

- **Elimination of the skeleton → hydrate → fetch waterfall** on the six highest-traffic routes.
  Users land on a populated list immediately on first paint.
- **Minimal disruption.** The ADR-0020 layering convention, all endpoint functions, all hooks,
  and all interactive child components are unchanged. Only the top-level `page.tsx` shells for
  six routes change shape.
- **No new dependencies.** `@tanstack/react-query` (already installed) exports
  `prefetchQuery`/`dehydrate`/`HydrationBoundary`. No new packages.
- **Composable.** Later waves can extend server-prefetch to detail pages or related sub-reads
  by adding `prefetchQuery` calls to the same page — no architectural rework needed.
- **Resolves the deferred debt noted in ADR-0020.** That ADR called out client-side-only
  fetching as a real architectural fork to revisit once auth landed. Auth has landed.

### Negative / trade-offs

- **Two `QueryClient` lifetimes to reason about.** The per-request server-side `QueryClient`
  (used only for `prefetchQuery` + `dehydrate`) and the global client-side `QueryClient` (in
  the providers tree) are distinct. The dehydrated state bridges them at render time. This is
  the standard TanStack Query SSR pattern but it is a new concept in the codebase; it must be
  documented in `docs/04-development/` for the next developer.
- **Server errors in `prefetchQuery` silently produce an empty cache** (TanStack Query swallows
  prefetch errors by design, so the Client Component's `useQuery` refetches on mount). This is
  the correct degraded-mode behaviour for an internal tool but means server-side API errors
  during SSR are invisible unless explicitly logged or surfaced in `loading.tsx`.
- **Out-of-scope routes remain client-fetched.** Detail and edit pages continue to show a
  skeleton flash. Accepted: they are lower-traffic and more complex; they are a follow-up.
- **Access token in per-request server context only.** The `accessToken` from `await auth()` is
  available on the server but must be passed explicitly into `prefetchQuery`'s `queryFn` (the
  Option A pattern of ADR-0039 §6a). This is already the convention for server-side reads.

### Follow-ups

- **Ratify this ADR** (proposed → accepted, CEO sign-off) before any implementation begins.
- **Implementation wave** tracked in a separate issue (to be opened after ratification): convert
  the six page shells, add `loading.tsx` + `error.tsx` coverage, add a short ADR-0020 amendment
  noting the server-prefetch extension.
- **Per-segment loading skeletons** for high-traffic detail pages are a natural next wave once
  the list pilot proves out.
- **Documentation update**: add a server-prefetch recipe note to `docs/04-development/` as part
  of the implementation wave.

**Related:** #500 · [[0020-frontend-data-layer]] · [[0039-authjs-v5-frontend-oidc]] ·
[[0010-nextjs-frontend]] · #498
