import type { ConsumableListParams } from "@/lib/api/endpoints/consumables";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * The SINGLE source for the consumables list's URL→query mapping — a framework-agnostic module (no
 * "use client") imported by BOTH the client `ConsumablesListView` and the server `page.tsx` prefetch,
 * so their `consumableKeys.list(...)` keys can't drift (ADR-0067 / #733). See
 * `docs/04-development/ssr-prefetch-recipe.md`.
 */

/**
 * URL filter defaults. `lowStock` is a server filter ("true"); `category` is the server-side category
 * filter (#824 — a category cuid, "ALL" = unset). `archived` ("ALL" | "only") drives the ADMIN-only
 * `deleted=only` view via the URL.
 */
export const CONSUMABLE_FILTER_DEFAULTS = {
  lowStock: "",
  category: "ALL",
  archived: "ALL",
} as const;

/** `useListParams` config for the consumables list, shared client/server. */
export const CONSUMABLE_LIST_OPTIONS = {
  filters: CONSUMABLE_FILTER_DEFAULTS,
  defaultSort: "updatedAt",
  defaultDir: "desc" as const,
};

/**
 * Map the URL-derived list state to the server `ConsumableListParams`. `isAdmin` gates the archived
 * (`deleted=only`) slice exactly as the client does (API keeps it ADMIN-only). `lowStock` is a boolean
 * (default `false`, always present); `category` collapses "ALL" → `undefined`.
 */
export function deriveConsumableParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): ConsumableListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  return {
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    lowStock: filters.lowStock === "true",
    category: filters.category !== "ALL" ? filters.category : undefined,
    limit,
    offset,
    deleted: opts.isAdmin && filters.archived === "only" ? "only" : undefined,
  };
}
