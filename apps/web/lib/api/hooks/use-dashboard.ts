import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  type DashboardActivityFilters,
  getDashboardActivity,
  getDashboardSummary,
} from "../endpoints/dashboard";

/** Page size for the dashboard's compact recent-activity panel (the API caps at 200). */
const ACTIVITY_PAGE_SIZE = 20;

/**
 * Wider page size for the full Reports/Informes screen. The Reports timeline pages with "Load more"
 * and the Reports table pages server-side — a roomy first window keeps both scannable. Stays well
 * under the API's 200 cap.
 */
export const REPORTS_ACTIVITY_PAGE_SIZE = 50;

/** No filters → omit the filter key segment entirely so the unfiltered cache entry is stable. */
const NO_ACTIVITY_FILTERS: DashboardActivityFilters = {};

/**
 * Canonicalize the activity filters into a deterministic, stable cache-key segment: keys sorted, and
 * an all-empty object collapsed to `null`. This keeps the dashboard panel's (unfiltered) key
 * identical to before — `[...,"activity",pageSize,null]` is structurally equal across renders — and
 * gives every distinct filter combination its OWN cache entry (so a filter change is a fresh query,
 * never a stale clobber). React Query hashes the key deterministically, but sorting here keeps the
 * segment readable in devtools and order-insensitive.
 */
function activityFilterKey(
  filters: DashboardActivityFilters,
): Record<string, string> | null {
  const entries = Object.entries(filters).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  if (entries.length === 0) return null;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Query keys for the read-only dashboard aggregation. There are no dashboard mutations — the
 * summary and the activity feed are derived from the other resources — so these are standalone read
 * keys: `summary` is parameterized by the `expiringWithinDays` window so a different window is a
 * distinct cache entry; `activity` is parameterized by page size AND the active filters so the
 * dashboard's 20-row panel, the Reports timeline's 50-row window, and every distinct Reports filter
 * combination are all DISTINCT cache entries (they never clobber each other). The unfiltered key
 * carries a `null` filter segment, so the dashboard panel's key is unchanged by the filter epic.
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (expiringWithinDays?: number) =>
    [...dashboardKeys.all, "summary", expiringWithinDays ?? null] as const,
  activity: (
    pageSize: number = ACTIVITY_PAGE_SIZE,
    filters: DashboardActivityFilters = NO_ACTIVITY_FILTERS,
  ) =>
    [
      ...dashboardKeys.all,
      "activity",
      pageSize,
      activityFilterKey(filters),
    ] as const,
  /** A single server-paginated activity window (the Reports table): page size, filters AND offset. */
  activityPage: (
    pageSize: number,
    offset: number,
    filters: DashboardActivityFilters = NO_ACTIVITY_FILTERS,
  ) =>
    [
      ...dashboardKeys.all,
      "activity-page",
      pageSize,
      offset,
      activityFilterKey(filters),
    ] as const,
};

/**
 * Fetch the dashboard summary (assets by status, active/expiring/critical grants, consumable
 * low-stock, articles published vs draft). The figures are a point-in-time snapshot; this is a
 * one-shot read with the default cache behaviour (no polling).
 */
export function useDashboardSummary(expiringWithinDays?: number) {
  return useQuery({
    queryKey: dashboardKeys.summary(expiringWithinDays),
    queryFn: () => getDashboardSummary(expiringWithinDays),
  });
}

/**
 * Paginated unified recent-activity feed (`GET /dashboard/activity`), newest first — the
 * cross-pillar stream merging AssetHistory, AssetAssignment, AccessGrant and ConsumableMovement
 * (backed by the `recent_activity` view). Offset pagination per ADR-0030: each page asks for the
 * next window; another page exists while `offset + items.length < total`.
 *
 * `filters` (issue #181 / DEBT-1) are the OPTIONAL server-side narrowing params; they are sent to
 * the API AND folded into the query key, so each distinct filter combination is its own infinite
 * cache (a filter change resets to its first page, never reusing another filter's pages). The
 * dashboard panel calls this with no filters, so its cache key and behaviour are unchanged.
 *
 * This "Load more" infinite shape backs the Reports TIMELINE (and the dashboard panel). The Reports
 * TABLE uses {@link useReportsActivityPage} for true prev/next server-side paging over the same
 * filtered feed.
 */
export function useDashboardActivity(
  pageSize: number = ACTIVITY_PAGE_SIZE,
  filters: DashboardActivityFilters = NO_ACTIVITY_FILTERS,
) {
  return useInfiniteQuery({
    queryKey: dashboardKeys.activity(pageSize, filters),
    queryFn: ({ pageParam }) =>
      getDashboardActivity({ ...filters, limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.items.length;
      return next < lastPage.total ? next : undefined;
    },
  });
}

/**
 * A SINGLE server-side page of the filtered activity feed — true offset/limit paging for the Reports
 * TABLE view. Unlike {@link useDashboardActivity} (an infinite "Load more" stream), this fetches just
 * the `[offset, offset + pageSize)` window and returns the envelope's filtered `total`, so the
 * `Pagination` prev/next controls are backed by the real server count, not a client slice. `filters`
 * is folded into the key alongside `offset`; `keepPreviousData` holds the current page while the
 * next window resolves so paging/filtering doesn't flash the skeleton.
 */
export function useReportsActivityPage(
  pageSize: number,
  offset: number,
  filters: DashboardActivityFilters = NO_ACTIVITY_FILTERS,
) {
  return useQuery({
    queryKey: dashboardKeys.activityPage(pageSize, offset, filters),
    queryFn: () =>
      getDashboardActivity({ ...filters, limit: pageSize, offset }),
    placeholderData: keepPreviousData,
  });
}
