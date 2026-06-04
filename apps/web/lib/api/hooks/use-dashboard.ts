import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  getDashboardActivity,
  getDashboardSummary,
} from "../endpoints/dashboard";

/** Page size for the dashboard's compact recent-activity panel (the API caps at 200). */
const ACTIVITY_PAGE_SIZE = 20;

/**
 * Wider page size for the full Reports/Informes screen. The Reports filters run CLIENT-SIDE over the
 * loaded window (v1), so a bigger first page makes those filters meaningfully complete before the
 * user has to "Load more". Stays well under the API's 200 cap.
 */
export const REPORTS_ACTIVITY_PAGE_SIZE = 50;

/**
 * Query keys for the read-only dashboard aggregation. There are no dashboard mutations — the
 * summary and the activity feed are derived from the other resources — so these are standalone read
 * keys: `summary` is parameterized by the `expiringWithinDays` window so a different window is a
 * distinct cache entry; `activity` is parameterized by page size so the dashboard's 20-row panel
 * and the Reports screen's 50-row window are DISTINCT cache entries (they never clobber each other).
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (expiringWithinDays?: number) =>
    [...dashboardKeys.all, "summary", expiringWithinDays ?? null] as const,
  activity: (pageSize: number = ACTIVITY_PAGE_SIZE) =>
    [...dashboardKeys.all, "activity", pageSize] as const,
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
 */
export function useDashboardActivity(pageSize: number = ACTIVITY_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: dashboardKeys.activity(pageSize),
    queryFn: ({ pageParam }) =>
      getDashboardActivity({ limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.items.length;
      return next < lastPage.total ? next : undefined;
    },
  });
}
