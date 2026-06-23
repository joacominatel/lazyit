---
title: "SSR server-prefetch recipe (apply the ADR-0067 mold to a new route)"
tags: [development, frontend, ssr, tanstack-query, nextjs]
status: accepted
created: 2026-06-23
updated: 2026-06-23
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
5. **For list pages, replicate the first-paint filter object.** Build a `DEFAULT_FILTERS`/
   `DEFAULT_PARAMS` const that matches what the child's `useThings({...})` call yields on a load
   with **no URL params** — every `"ALL"`/empty filter → `undefined`, the `useListParams`
   defaults (`limit` 50, `offset` 0, the page's `defaultSort`/`defaultDir`). See the assets page
   for the canonical doc comment.

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

## Deliberately deferred — filtered/paged/searched first paint

Only the **unfiltered** first paint of a list is prefetched. A filtered/paged/searched URL
(`?status=ACTIVE&category=…&offset=50`) misses the dehydrated cache and the client fetches it. To
prefetch the filtered key you would read `searchParams` on the server and rebuild the exact filter
object the client's `useListParams` derives — but that derivation is **per-page bespoke** (URL
filter names map to different API params: `category`→`categoryId`, `archived`→`deleted`; `ownership`
is client-only; KB multi-value filters are comma-encoded). Duplicating that mapping in each server
page risks silent key drift → cache-miss double-fetches. The lazy-correct call is to keep the
graceful client-fetch fallback for the lower-frequency filtered case; revisit only if the
param-derivation is first extracted into a single pure function shared by client and server.
