"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { useMounted } from "@/lib/hooks/use-mounted";

/**
 * The result a never-prefetched query has on the SERVER render: no data, `pending`, and `idle`
 * (React Query never starts a fetch during SSR). Pure, so it is unit-tested on its own.
 *
 * Only `refetch` is carried over from the live result. Everything else is fixed, so the value is
 * identical on the server and on the hydrating client whatever the client cache holds. `promise` is
 * left out: nothing consumes it from these hooks.
 */
export function serverPendingResult<TData, TError>(
  live: Pick<UseQueryResult<TData, TError>, "refetch">,
): UseQueryResult<TData, TError> {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: "idle",
    isEnabled: true,
    isError: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: true,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: false,
    refetch: live.refetch,
    status: "pending",
  } as unknown as UseQueryResult<TData, TError>;
}

/**
 * Hydration-safe view of a query the server NEVER prefetches — the caller's own `/users/me` and
 * `/config/my-permissions` (#1448).
 *
 * Why: those queries are always cold on the server, but on the client the app shell (top bar,
 * sidebar) hydrates first and starts fetching them. A page segment that hydrates later (it sits in a
 * streamed Suspense boundary) can then find the cache already warm, so a permission-gated control
 * ("Show archived", an import button, `AdminGate`'s content) renders on the client but was absent
 * from the server HTML → React #418 and a client re-render of the whole segment. Timing-dependent,
 * so it appears on some loads and not others.
 *
 * During hydration this returns {@link serverPendingResult} — exactly what the server rendered — and
 * the real result from the next render on. A component that mounts after hydration (client-side
 * navigation) gets the real result on its first render, so a warm cache still paints at once.
 *
 * Do NOT wrap a query a route prefetches in its shared hook: there the server HAS the data, and
 * masking it during hydration would create the mismatch. `/config/status` is prefetched on
 * `/settings/instance`, so it has a separate opt-in variant (`useClientOnlyConfigStatus`) for every
 * other route.
 */
export function useClientOnlyQuery<TData, TError>(
  result: UseQueryResult<TData, TError>,
): UseQueryResult<TData, TError> {
  const mounted = useMounted();
  // Reading only `refetch` off the tracked result during hydration is deliberate: the
  // post-hydration render reads the real fields, which is when React Query starts tracking them.
  return mounted ? result : serverPendingResult(result);
}
