import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getDashboardSummary } from "@/lib/api/endpoints/dashboard";
import { dashboardKeys } from "@/lib/api/hooks/use-dashboard";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { DashboardView } from "./_components/dashboard-view";

/**
 * Dashboard — the landing page every user sees after login, and so the highest-value target for the
 * ADR-0067 server-prefetch pilot. This thin Server Component resolves the session, prefetches the
 * dashboard summary into a per-request `QueryClient`, dehydrates it, and hands it to the client
 * `DashboardView` via `<HydrationBoundary>`. The child's `useDashboardSummary()` finds the query
 * already in cache on first paint — no skeleton → hydrate → fetch waterfall.
 *
 * The prefetched key (`dashboardKeys.summary(undefined)`) and queryFn (`getDashboardSummary()` with
 * no `expiringWithinDays`) MUST match the child hook's defaults exactly, or the dehydrated entry
 * won't hit and the client would refetch. The 401 auth-expiry handler (#600) stays on the CLIENT
 * provider, untouched; a server-side prefetch failure degrades to an empty cache (the client just
 * refetches on mount), per ADR-0067.
 */
export default async function DashboardPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: dashboardKeys.summary(),
    queryFn: () => getDashboardSummary(undefined, session?.accessToken),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <DashboardView />
    </HydrationBoundary>
  );
}
