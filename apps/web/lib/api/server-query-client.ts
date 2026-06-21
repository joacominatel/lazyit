/**
 * Server-side `QueryClient` helper for the ADR-0067 server-prefetch pilot.
 *
 * This is the SECOND of the two `QueryClient` lifetimes the codebase now reasons about (ADR-0067
 * §Consequences). It is **distinct** from the client-side `QueryClient` wired in `app/providers.tsx`:
 *
 *   - `providers.tsx` owns the long-lived BROWSER cache (and the #600 401 auth-expiry reaction wired
 *     into its QueryCache/MutationCache). On the server it makes a fresh client per request too, but
 *     that client is only the React tree's provider — it is NOT what we prefetch into.
 *   - This helper owns the PER-REQUEST client a Server Component `page.tsx` prefetches into, then
 *     `dehydrate()`s. The dehydrated state is handed to `<HydrationBoundary>`, which re-hydrates it
 *     into the browser client on first paint — so the child `useQuery` finds the data already cached
 *     and renders immediately (no skeleton → hydrate → fetch waterfall).
 *
 * `cache()` scopes the instance per request (React's request memoization), so prefetching the same
 * query from several Server Components in one request reuses one client and one fetch — and no state
 * leaks across concurrent requests/users (a hard requirement for this multi-user internal tool).
 *
 * The `staleTime` matches the client provider's (60s) so freshly dehydrated data is NOT immediately
 * considered stale on the client — otherwise the child `useQuery` would refetch on mount and we'd
 * double-fetch, defeating the prefetch. No QueryCache/MutationCache `onError` here: prefetch errors
 * are intentionally swallowed (TanStack Query design), so a server-side API failure degrades to an
 * empty dehydrated cache and the client `useQuery` simply refetches on mount (ADR-0067 §Negative).
 * The 401 auth-expiry handler therefore still lives only on the client provider, unchanged.
 *
 * Server Components that prefetch must pass the Bearer token explicitly (`token: session.accessToken`
 * from `await auth()`) — the client-side `session-token` store is browser-only and intentionally
 * returns `undefined` on the server (see `lib/api/session-token.ts`).
 */

import { QueryClient } from "@tanstack/react-query";
import { cache } from "react";

/**
 * The per-request server-side `QueryClient`, memoized for the lifetime of one request via React's
 * `cache()`. Call it inside an `async` Server Component, `prefetchQuery` into it, then
 * `dehydrate()` it for a `<HydrationBoundary>`.
 */
export const getServerQueryClient = cache(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          // Mirror the client provider's staleTime so dehydrated data isn't stale-on-arrival (which
          // would trigger an immediate client refetch and a double-fetch). See module doc above.
          staleTime: 60 * 1000,
        },
      },
    }),
);
