import type { LocationType } from "@lazyit/shared";
import type { LocationListParams } from "@/lib/api/endpoints/locations";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * The SINGLE source for the locations list's URL→query mapping — a framework-agnostic module (no
 * "use client") imported by BOTH the client `LocationsListView` and the server `page.tsx` prefetch, so
 * their `locationKeys.list(...)` keys can't drift (ADR-0067 / #733). See
 * `docs/04-development/ssr-prefetch-recipe.md`.
 */

/**
 * URL filter defaults. `type` maps to the server `type` param (#824 — scopes the whole result set);
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL.
 */
export const LOCATION_FILTER_DEFAULTS = { type: "ALL", archived: "ALL" } as const;

/** `useListParams` config for the locations list, shared client/server. */
export const LOCATION_LIST_OPTIONS = {
  filters: LOCATION_FILTER_DEFAULTS,
  defaultSort: "updatedAt",
  defaultDir: "desc" as const,
};

/**
 * Map the URL-derived list state to the server `LocationListParams`. `isAdmin` gates the archived
 * (`deleted=only`) slice exactly as the client does (API keeps it ADMIN-only); `type` collapses
 * "ALL" → `undefined`.
 */
export function deriveLocationParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): LocationListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  return {
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    type: filters.type !== "ALL" ? (filters.type as LocationType) : undefined,
    limit,
    offset,
    deleted: opts.isAdmin && filters.archived === "only" ? "only" : undefined,
  };
}
