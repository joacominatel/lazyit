import type { DashboardSummary, RecentActivityPage } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the read-only dashboard aggregation. `GET /dashboard/summary` (ADR-0030 sibling,
 * PR #61) composes cheap counts/groupBys across the three pillars (Inventory, Access, Knowledge)
 * plus a recent-activity slice into a single typed `DashboardSummary` envelope — there is no
 * persisted "dashboard" entity. The numbers are a point-in-time snapshot (`generatedAt`), never a
 * live subscription. See `@lazyit/shared` `schemas/dashboard.ts`.
 *
 * `GET /dashboard/activity` (CEO Round 2 / ADR-0043) is the unified, cross-pillar activity feed,
 * newest first and **offset-paginated** (ADR-0030). It is backed by the `recent_activity` Postgres
 * view, which merges AssetHistory, AssetAssignment, AccessGrant and ConsumableMovement into one
 * stream. Returns a `Page<RecentActivityItem>` envelope. See `@lazyit/shared` `schemas/recent-activity.ts`.
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

/** Window for the recent-activity feed (ADR-0030). Omit for the server defaults. */
export interface DashboardActivityParams {
  /** Page size (1-200). Omit for the server default (50). */
  limit?: number;
  /** Zero-based window offset. Omit for the first page. */
  offset?: number;
}

/**
 * Fetch one page of the unified recent-activity feed (`GET /dashboard/activity`), newest first.
 * Returns the whole `Page<RecentActivityItem>` envelope (`items` + `total`/`limit`/`offset`) so the
 * caller can compute "has more".
 */
export function getDashboardActivity(
  { limit, offset }: DashboardActivityParams = {},
): Promise<RecentActivityPage> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  const qs = params.toString();
  return apiFetch<RecentActivityPage>(
    qs ? `${BASE}/activity?${qs}` : `${BASE}/activity`,
  );
}
