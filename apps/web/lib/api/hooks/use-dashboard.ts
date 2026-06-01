import { useQuery } from "@tanstack/react-query";
import { getDashboardSummary } from "../endpoints/dashboard";

/**
 * Query keys for the read-only dashboard aggregation. There are no dashboard mutations — the
 * summary is derived from the other resources — so this is a standalone read key, parameterized by
 * the `expiringWithinDays` window so a different window is a distinct cache entry.
 */
export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (expiringWithinDays?: number) =>
    [...dashboardKeys.all, "summary", expiringWithinDays ?? null] as const,
};

/**
 * Fetch the dashboard summary (assets by status, active/expiring/critical grants, consumable
 * low-stock, articles published vs draft, recent activity). The figures are a point-in-time
 * snapshot; this is a one-shot read with the default cache behaviour (no polling).
 */
export function useDashboardSummary(expiringWithinDays?: number) {
  return useQuery({
    queryKey: dashboardKeys.summary(expiringWithinDays),
    queryFn: () => getDashboardSummary(expiringWithinDays),
  });
}
