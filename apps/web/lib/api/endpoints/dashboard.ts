import type {
  ActivityEntityType,
  DashboardSummary,
  RecentActivityActorFilter,
  RecentActivityAction,
  RecentActivityPage,
} from "@lazyit/shared";
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
 *
 * Since issue #181 (DEBT-1) the feed is **server-side filterable** (and gated on `logs:read`): the
 * optional `entityType` / `entityId` / `actorId` / `action` / `from` / `to` / `q` query params narrow
 * the stream, and the returned `total` reflects the SAME filtered count. With no filter the feed
 * behaves exactly as before. The shared `RecentActivityQuerySchema` is the contract; this data layer
 * just serializes the optional filters next to `limit`/`offset`.
 */

const BASE = "/dashboard";

/**
 * Fetch the dashboard summary. `expiringWithinDays` (1-365, default 30 on the API) sets the
 * look-ahead window for the "grants expiring soon" count; omit to use the server default.
 */
export function getDashboardSummary(
  expiringWithinDays?: number,
  // Optional Bearer override for SSR server-prefetch (ADR-0067): a Server Component passes
  // `session.accessToken` from `await auth()`, since the client-side token store is browser-only.
  // Client callers omit it and `apiFetch` falls back to the session-token store, unchanged.
  token?: string,
): Promise<DashboardSummary> {
  const qs =
    expiringWithinDays !== undefined
      ? `?expiringWithinDays=${expiringWithinDays}`
      : "";
  return apiFetch<DashboardSummary>(`${BASE}/summary${qs}`, { token });
}

/**
 * The OPTIONAL server-side filters for the recent-activity feed (issue #181 / DEBT-1) as the data
 * layer consumes them — the `RecentActivityFiltersSchema` shape, less the parts the pagination
 * window already owns. Every field is optional; an empty object asks for the unfiltered feed. `from`
 * / `to` are ISO-8601 datetimes (a closed-open `[from, to)` window over `occurredAt`). `actorId`
 * accepts either a concrete user uuid or the literal `"me"` (the API resolves `"me"` to the caller).
 */
export interface DashboardActivityFilters {
  /** Restrict to one pillar (asset | application | consumable). */
  entityType?: ActivityEntityType;
  /** Restrict to one affected entity's id (exact match; pairs with `entityType`). */
  entityId?: string;
  /** A concrete user uuid, or the literal `"me"` (resolved to the caller server-side). */
  actorId?: RecentActivityActorFilter;
  /** One known activity verb (validated against the closed allowlist server-side). */
  action?: RecentActivityAction;
  /** Inclusive lower bound (ISO-8601) of the `occurredAt` window. */
  from?: string;
  /** Exclusive upper bound (ISO-8601) of the `occurredAt` window. */
  to?: string;
  /** Free text matched against `summary` + the resolved actor name. */
  q?: string;
}

/**
 * Window + optional filters for the recent-activity feed (ADR-0030 paging + issue #181 filters).
 * Omit everything for the server defaults / unfiltered feed.
 */
export interface DashboardActivityParams extends DashboardActivityFilters {
  /** Page size (1-200). Omit for the server default (50). */
  limit?: number;
  /** Zero-based window offset. Omit for the first page. */
  offset?: number;
}

/**
 * Fetch one page of the unified recent-activity feed (`GET /dashboard/activity`), newest first.
 * Returns the whole `Page<RecentActivityItem>` envelope (`items` + `total`/`limit`/`offset`) so the
 * caller can compute "has more". Any provided filter is serialized as its own query param next to
 * `limit`/`offset`; an omitted filter is left off entirely, so the no-filter call is byte-for-byte
 * the historical request.
 */
export function getDashboardActivity(
  {
    limit,
    offset,
    entityType,
    entityId,
    actorId,
    action,
    from,
    to,
    q,
  }: DashboardActivityParams = {},
): Promise<RecentActivityPage> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  if (entityType) params.set("entityType", entityType);
  if (entityId) params.set("entityId", entityId);
  if (actorId) params.set("actorId", actorId);
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (q) params.set("q", q);
  const qs = params.toString();
  return apiFetch<RecentActivityPage>(
    qs ? `${BASE}/activity?${qs}` : `${BASE}/activity`,
  );
}
