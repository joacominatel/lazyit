import type { DashboardSummary } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the read-only dashboard aggregation. `GET /dashboard/summary` (ADR-0030 sibling,
 * PR #61) composes cheap counts/groupBys across the three pillars (Inventory, Access, Knowledge)
 * plus a recent-activity slice into a single typed `DashboardSummary` envelope — there is no
 * persisted "dashboard" entity. The numbers are a point-in-time snapshot (`generatedAt`), never a
 * live subscription. See `@lazyit/shared` `schemas/dashboard.ts`.
 */

const BASE = "/dashboard";

/**
 * Fetch the dashboard summary. `expiringWithinDays` (1-365, default 30 on the API) sets the
 * look-ahead window for the "grants expiring soon" count; omit to use the server default.
 */
export function getDashboardSummary(
  expiringWithinDays?: number,
): Promise<DashboardSummary> {
  const qs =
    expiringWithinDays !== undefined
      ? `?expiringWithinDays=${expiringWithinDays}`
      : "";
  return apiFetch<DashboardSummary>(`${BASE}/summary${qs}`);
}
