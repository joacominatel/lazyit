import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { auth } from "@/auth";
import { getDashboardActivity } from "@/lib/api/endpoints/dashboard";
import { dashboardKeys } from "@/lib/api/hooks/use-dashboard";
import { getServerQueryClient } from "@/lib/api/server-query-client";
import { ReportsGate } from "./_components/reports-gate";

/**
 * Reports (issue #177) — the estate-wide, filterable activity history at `/reports`. An ADR-0067
 * server-prefetch route: this thin Server Component prefetches the first-paint activity page so the
 * client `ReportsScreen` (rendered inside the `logs:read` gate) hydrates with data already in cache,
 * skipping the skeleton → hydrate → fetch waterfall.
 *
 * The prefetched key MUST match `ReportsScreen`'s first-paint `useReportsActivityPage(...)` args:
 * `useListParams({ defaultLimit: 25 })` → limit 25, offset 0, and the all-default filter set
 * (tab "all", actor/action "ALL", no date range, no search) collapses to an EMPTY filter object — so
 * the canonical key is `dashboardKeys.activityPage(25, 0, {})`. A filtered/paged URL misses and the
 * client fetches it. The `logs:read` gate stays client-side in {@link ReportsGate}: a caller without
 * the permission triggers a swallowed prefetch error (the API gates the feed) and never sees data
 * (the #600 401 handler stays on the client provider). See the applications page for the full mold.
 */
const FIRST_PAINT_PAGE_SIZE = 25;

export default async function ReportsPage() {
  const session = await auth();
  const queryClient = getServerQueryClient();

  await queryClient.prefetchQuery({
    queryKey: dashboardKeys.activityPage(FIRST_PAINT_PAGE_SIZE, 0, {}),
    queryFn: () =>
      getDashboardActivity(
        { limit: FIRST_PAINT_PAGE_SIZE, offset: 0 },
        session?.accessToken,
      ),
  });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ReportsGate />
    </HydrationBoundary>
  );
}
