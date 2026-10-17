import type { ApplicationListParams } from "@/lib/api/endpoints/applications";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * The SINGLE source for the applications list's URL→query mapping — a framework-agnostic module (no
 * "use client") imported by BOTH the client `ApplicationsListView` and the server `page.tsx` prefetch,
 * so their `applicationKeys.list(...)` keys can't drift (ADR-0067 / #733). See
 * `docs/04-development/ssr-prefetch-recipe.md`.
 */

/**
 * URL filter defaults. `category` ("ALL" | a category cuid) drives the server `?categoryId=`;
 * `criticality` ("ALL" | "CRITICAL" | "NORMAL") drives `?isCritical=` (#1631).
 */
export const APPLICATION_FILTER_DEFAULTS = {
  category: "ALL",
  criticality: "ALL",
} as const;

/** `useListParams` config for the applications list, shared client/server. */
export const APPLICATION_LIST_OPTIONS = {
  filters: APPLICATION_FILTER_DEFAULTS,
  defaultSort: "name",
  defaultDir: "asc" as const,
};

/**
 * Map the URL-derived list state to the server `ApplicationListParams`, so every filtered/paged/searched
 * URL is prefetchable and matches the client's `useApplicationList(...)` key.
 */
export function deriveApplicationParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
): ApplicationListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  return {
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    limit,
    offset,
    categoryId: filters.category && filters.category !== "ALL" ? filters.category : undefined,
    isCritical:
      filters.criticality === "CRITICAL"
        ? true
        : filters.criticality === "NORMAL"
          ? false
          : undefined,
  };
}
