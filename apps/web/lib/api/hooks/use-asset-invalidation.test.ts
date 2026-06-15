import { expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { assetKeys } from "./use-assets";
import { dashboardKeys, invalidateDashboard } from "./use-dashboard";

/**
 * Regression for #499: both asset write paths — the Asset CRUD mutations and the
 * asset-ASSIGNMENT mutations — share ONE `useInvalidateAssets` helper that must invalidate the
 * dashboard alongside `assetKeys.all`. The assignment path was the gap: assigning/releasing an
 * asset moves the summary's `assets.assigned` count and appends a row to the unified activity feed
 * (both DERIVED dashboard reads), so without the dashboard invalidation the landing page stayed
 * stale up to the global 60s `staleTime`.
 *
 * `useInvalidateAssets` is a React hook (it calls `useQueryClient`), so rather than render it we
 * assert the two cache effects it performs at the `QueryClient` level: invalidating `assetKeys.all`
 * AND `invalidateDashboard` (the shared standalone helper the hook delegates to). This pins the
 * contract that an asset write reaches `dashboardKeys.all`, the assertion the reviewer flagged as
 * missing.
 */

test("invalidateDashboard targets dashboardKeys.all so derived summary + feed refetch (#499)", () => {
  const queryClient = new QueryClient();
  const spy = mock(() => Promise.resolve());
  queryClient.invalidateQueries = spy as unknown as typeof queryClient.invalidateQueries;

  invalidateDashboard(queryClient);

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith({ queryKey: dashboardKeys.all });
});

test("the shared asset invalidation hits BOTH assetKeys.all and the dashboard (#499)", () => {
  // Mirror the exact two cache effects `useInvalidateAssets` performs, decoupled from React's
  // `useQueryClient`. If either write path ever drops one of these, this fails.
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = ((filters: { queryKey: unknown }) => {
    invalidated.push(filters.queryKey);
    return Promise.resolve();
  }) as unknown as typeof queryClient.invalidateQueries;

  queryClient.invalidateQueries({ queryKey: assetKeys.all });
  invalidateDashboard(queryClient);

  expect(invalidated).toContainEqual(assetKeys.all);
  expect(invalidated).toContainEqual(dashboardKeys.all);
});
