---
title: "SSR server-prefetch recipe (apply the ADR-0067 mold to a new route)"
tags: [development, frontend, ssr, tanstack-query, nextjs]
status: accepted
created: 2026-06-23
updated: 2026-06-30
---

# SSR server-prefetch recipe

How to make a route's first paint server-prefetched instead of skeleton → hydrate → fetch.
The decision and rationale are [[0067-server-prefetch-ssr-strategy]]; this is the **operating
manual** for copying the mold onto a new route. It is a uniform, mechanical change — favour
consistency with the existing converted routes over per-route cleverness.

## The mold (copy this verbatim)

A route's `page.tsx` becomes a **thin `async` Server Component** that prefetches the route's
**primary** read, dehydrates it, and hydrates the existing interactive client view:

```tsx
// page.tsx — NO "use client"
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getThing } from "@/lib/api/endpoints/things";
import { thingKeys } from "@/lib/api/hooks/use-things";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ThingView } from "./_components/thing-view";

export default async function ThingPage({
  params,
}: {
  params: Promise<{ id: string }>; // Next 16: params is a Promise — await it
}) {
  const { id } = await params;
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: thingKeys.detail(id),
    queryFn: () => getThing(id, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ThingView id={id} />
    </HydrationBoundary>
  );
}
```

The original `"use client"` page body moves **verbatim** into a co-located
`_components/<name>-view.tsx` (a named export, `"use client"`). Its `useQuery`/`useXxx` hooks are
unchanged — on first paint they hit the dehydrated cache and render immediately.

## Step by step

1. **Find the primary read.** The one record/list the page renders first (`useThing(id)` →
   `getThing`, or `useThings(filters)` → `getThings`). Prefetch **only** the primary read — leave
   secondary reads (related panels, lookups, joins) client-fetched. Prefetching every sub-read adds
   churn for little visible benefit; add one later only if it removes a *visible* waterfall.
2. **Thread the token into the endpoint getter.** SSR has no browser session-token store, so the
   getter needs an optional trailing `token?: string` passed into `apiFetch(..., { token })`. The
   shared `createCrudEndpoints` factory's `get(id, token?)` already does this (so
   `getApplication`/`getConsumable`/`getLocation`/`getUser` are ready); hand-written getters
   (`getAsset`, `getArticles`, `getArticleBySlug`, `getDashboardActivity`, `getConfigStatus`, …)
   each gained the param. Client callers omit it — it stays optional, behaviour unchanged.
   Reference implementation: `getAssets` in `apps/web/lib/api/endpoints/assets.ts`.
3. **Move the body to `_components/<name>-view.tsx`.** Keep everything byte-identical. The one
   exception: a client view that read `useParams<{ id }>()` should take an `id` prop instead and
   drop the `useParams` import — the server page already has the param and passes it down. Fix the
   relative import paths that shift when the file moves one directory deeper.
4. **Match the key EXACTLY.** The `queryKey` you prefetch must be byte-identical to the one the
   child hook builds, or the dehydrated entry misses and the client refetches (a double-fetch that
   silently defeats the prefetch). Build it from the **same key factory** the hook uses
   (`thingKeys.detail(id)` / `thingKeys.list(DEFAULT_FILTERS)`). TanStack hashes keys
   deterministically (object property order doesn't matter), but the **set of keys and their
   values** must match.
5. **For list pages, prefetch the CURRENT URL — via the shared derivation, not a bespoke copy.**
   Don't hand-roll a `DEFAULT_FILTERS` const or re-map the URL in the page — that risks silent key
   drift. Instead reuse the ONE mapping the client hook uses (see *Filtered/paged/searched first paint*
   below): a co-located non-`"use client"` module (`_components/<entity>-list-query.ts`) exports the
   `useListParams` options and a pure `derive<Entity>Filters(state, opts)`; the page derives the
   view-state with `deriveListState(toURLSearchParams(await searchParams), OPTIONS)`, maps it with the
   same `derive<Entity>Filters`, and prefetches that key. A no-param URL yields the same first-paint key
   the unfiltered prefetch produced. See the assets route (`page.tsx` + `_components/assets-list-query.ts`)
   for the canonical shape.

## The `queryFn` wrap gotcha

Hooks that pass the getter **bare** as `queryFn` (`queryFn: getThing`) break once the getter gains
a `token?` param: TanStack forwards its `QueryFunctionContext` as the first arg, which then lands in
`token`. Always wrap: `queryFn: () => getThing()` (or `({ signal }) => getThing(filters, signal)`).
Most hooks already wrap; watch for the ones that didn't (`use-config-status`,
`use-permissions-config` needed it).

## Two `QueryClient` lifetimes (don't confuse them)

- `app/providers.tsx` owns the long-lived **browser** cache (and the #600 401 auth-expiry handler).
- `getServerQueryClient()` (`apps/web/lib/api/server-query-client.ts`) is the **per-request** client
  a Server Component prefetches into, then `dehydrate()`s. `cache()` scopes it per request so no
  state leaks across users. Its `staleTime` matches the provider's (60s) so dehydrated data isn't
  stale-on-arrival (which would trigger an immediate client refetch). Prefetch errors are swallowed
  by design → an empty dehydrated cache → the client `useQuery` just refetches on mount. The 401
  handler therefore stays only on the client provider.

## When NOT to prefetch

- **No data read** (empty create forms: `*/new`) — nothing to prefetch.
- **Link hubs / tab shells with no single stable primary read** (`settings`, `settings/taxonomies`).
- **Wizards with no first-paint read** (`imports` — the session id only exists after upload).
- **Secret Manager (`/secrets`, `/secrets/[vaultId]`) — INV-10 / zero-knowledge.** Leave entirely
  client-fetched. These pages are intentionally `ssr: false` (ADR-0061) to keep the crypto/WASM
  graph out of the server bundle; the genuinely safe metadata reads (vault list, vault detail with
  member metadata) are inseparable in practice from the ciphertext/wrapped-key reads
  (`getMyKeypair`, `getItems`, `getMyMembership`) that feed client-side decryption and must NEVER be
  lifted toward the server. Do not weaken INV-10 to shave a skeleton flash on a low-traffic route.

Mark any deliberate skip with a `// ponytail:` comment (why + when to revisit).

## Filtered/paged/searched first paint (done — #733)

The **current** filtered/paged/searched URL is now prefetched on the five uniform CRUD list routes
(assets, applications, consumables, locations, users), keyed byte-identically to the client. The
precondition that makes this drift-proof: the URL→view-state derivation is a single **pure** function
`deriveListState(params, options)` in `apps/web/lib/hooks/list-params-url.ts`, shared by the client
hook (`useListParams` calls it) AND by Server Components. It reads params through a `.get()` interface,
so it takes the browser's `useSearchParams()` on the client and a `URLSearchParams` built from the
page's `searchParams` prop (`toURLSearchParams`, same module) on the server — one derivation, no
re-implementation to drift.

The per-page URL→API mapping (`category`→`categoryId`, `owner`→`assignedToUserId`, `archived`→
`deleted`, the boolean/multi-value collapses, etc.) also lives in ONE place per page — a co-located
non-`"use client"` module `_components/<entity>-list-query.ts` exporting the `useListParams` options
and a pure `derive<Entity>Filters(state, opts)` — imported by BOTH the client view (`useThings(...)`)
and the server page (prefetch). Same function on both sides ⇒ the keys **cannot** drift. TanStack
hashes keys via `JSON.stringify` with sorted object keys and drops `undefined` properties, so only the
set of *defined* keys and their values must agree (which the shared function guarantees).

**One deliberate skip:** the ADMIN-only archived slice (`?archived=only` → `deleted=only`) is gated
on the client by `isAdmin`; reproducing that key server-side would need the session's role, so the
page skips the prefetch when the archived sentinel is present and lets the client fetch it (a
low-frequency slice — graceful degrade, no key mismatch). Marked with `// ponytail:` in each page.

### Still deferred (diminishing returns — #733)

- **KB (`/kb`) and Reports (`/reports`) filtered prefetch.** Left on the unfiltered/first-paint
  prefetch. Their URL→query mappings are materially more bespoke (KB comma-encodes multi-value filters
  and derives `linked=only` implicitly from any narrowing entity; Reports maps a tab + actor/action +
  date-range into a filter object over a different hook), and both are lower-traffic than the CRUD
  lists. The shared `deriveListState` is in place, so adopting the same per-page-module pattern later
  is mechanical — do it if a filtered KB/Reports deep-link ever shows a *visible* skeleton flash.
- **Secondary reads (categories/locations lookups, the Access grants/directory join).** Still
  client-fetched. The primary read is prefetched, so no page is blank. The filter-dropdown lookups sit
  behind a popover (not first-paint-critical), and the applications access counts/avatars are a *minor
  derived shimmer* — prefetching that join would add two heavy server reads (grants at the 200 cap +
  the full user directory) to every applications SSR and needs an SSR `token?` threaded through
  `getAccessGrants`. Poor cost/benefit for a shimmer; revisit only if it becomes a visible blocking
  waterfall.
- **Per-segment detail skeletons.** The group-level `app/(app)/loading.tsx` (a list-shaped skeleton)
  already covers first-paint suspense for the piloted list routes. Detail routes prefetch their primary
  read, so their loading flash is brief; authoring a bespoke shape-matched `loading.tsx` per detail
  segment is gold-plating for a momentary mismatch. Add one only for a segment with a genuinely slow or
  janky first paint.
