import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AuditLogSource } from "@lazyit/shared";
import {
  type AuditLogClientFilters,
  getAuditLogFilters,
  getAuditLogs,
} from "../endpoints/audit";

/**
 * React Query hooks for the security audit-log READ surface (issue #871, ADR-0081) — the reader for the
 * three security audit logs. Mirrors `hooks/use-dashboard.ts` (the Reports mold): a key factory, a
 * server-paginated page hook (true prev/next with `keepPreviousData`), and the distinct-actor filter
 * menu. Read-only — the audit logs are append-only and never mutated from the UI, so there are no
 * invalidations. Every read is `logs:read`-gated server-side.
 */

/** Roomy default page for the audit ledger (well under the API's 200 cap). */
export const AUDIT_PAGE_SIZE = 25;

const NO_FILTERS: AuditLogClientFilters = {};

/**
 * Canonicalize the filters into a stable, order-insensitive cache-key segment (empty → null), so every
 * distinct filter combination gets its OWN cache entry and a filter change is a fresh query, never a
 * stale clobber. Mirrors the dashboard's `activityFilterKey`.
 */
function auditFilterKey(
  filters: AuditLogClientFilters,
): Record<string, string> | null {
  const entries = Object.entries(filters).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  if (entries.length === 0) return null;
  entries.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Query keys for the audit-log reads — parameterized by source, page size, offset AND filters. */
export const auditKeys = {
  all: ["audit"] as const,
  logs: (
    source: AuditLogSource,
    pageSize: number,
    offset: number,
    filters: AuditLogClientFilters = NO_FILTERS,
  ) =>
    [
      ...auditKeys.all,
      "logs",
      source,
      pageSize,
      offset,
      auditFilterKey(filters),
    ] as const,
  filters: (source: AuditLogSource) =>
    [...auditKeys.all, "filters", source] as const,
};

/**
 * A single server-side page of one audit source — true offset/limit paging for the ledger. `filters`
 * is folded into the key alongside `source`/`offset`; `keepPreviousData` holds the current page while
 * the next window resolves so paging/filtering doesn't flash the skeleton. Mirrors
 * `useReportsActivityPage`.
 */
export function useAuditLogsPage(
  source: AuditLogSource,
  pageSize: number,
  offset: number,
  filters: AuditLogClientFilters = NO_FILTERS,
) {
  return useQuery({
    queryKey: auditKeys.logs(source, pageSize, offset, filters),
    queryFn: () => getAuditLogs({ source, limit: pageSize, offset, ...filters }),
    placeholderData: keepPreviousData,
  });
}

/**
 * The distinct human actors present for a source — the actor select's menu. Fetched once per source;
 * the action options are NOT fetched here (they come from the shared enum, enum-driven). Mirrors
 * `useReportsActivityFilters`.
 */
export function useAuditLogFilters(source: AuditLogSource) {
  return useQuery({
    queryKey: auditKeys.filters(source),
    queryFn: () => getAuditLogFilters(source),
  });
}
