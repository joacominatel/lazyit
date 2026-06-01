import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  getDashboardActivity,
  getDashboardSummary,
} from "../endpoints/dashboard";

/** Page size for the recent-activity feed (the API caps at 200; the dashboard shows ~20 at a time). */
const ACTIVITY_PAGE_SIZE = 20;

/**
 * Query keys for the read-only dashboard aggregation. There are no dashboard mutations — the
 * summary and the activity feed are derived from the other resources — so these are standalone read
 * keys: `summary` is parameterized by the `expiringWithinDays` window so a different window is a
 * distinct cache entry; `activity` is a single infinite-query key.
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (expiringWithinDays?: number) =>
    [...dashboardKeys.all, "summary", expiringWithinDays ?? null] as const,
  activity: () => [...dashboardKeys.all, "activity"] as const,
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
export function useDashboardActivity() {
  return useInfiniteQuery({
    queryKey: dashboardKeys.activity(),
    queryFn: ({ pageParam }) =>
      getDashboardActivity({ limit: ACTIVITY_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.items.length;
      return next < lastPage.total ? next : undefined;
    },
  });
}
