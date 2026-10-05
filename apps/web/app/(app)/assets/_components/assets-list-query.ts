import {
  type AssetStatus,
  AssetStatusSchema,
  type AssetWarrantyFilter,
  AssetWarrantyFilterSchema,
} from "@lazyit/shared";
import type { AssetFilters } from "@/lib/api/endpoints/assets";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * The SINGLE source for the assets list's URL→query mapping — a framework-agnostic module (no
 * "use client") imported by BOTH the client `AssetsListView` and the server `page.tsx` prefetch, so
 * their `assetKeys.list(...)` keys are derived by the exact same code and cannot drift (ADR-0067 /
 * #733). Drift here would be a silent cache-miss double-fetch — worse than no prefetch — which is why
 * the mapping lives in one place instead of being re-implemented server-side. See
 * `docs/04-development/ssr-prefetch-recipe.md`.
 */

/**
 * URL filter defaults for the assets list. `status`/`category`/`model`/`location`/`company` map to
 * the server's `status`/`categoryId`/`modelId`/`locationId`/`company` (`model`, #943, is the EXACT
 * model deep-linked from the asset detail page's Model link — distinct from `category`, which maps to
 * the model's category); `owner` maps to `assignedToUserId` (a User uuid, "" = unset); `ownership`
 * (Has/None) maps to the server `ownership` filter (#824); `warranty` ("ALL" | "expiring90d" |
 * "expired") maps to the server `warranty` filter (#955, deep-linked from the dashboard tile);
 * `archived` ("ALL" | "only") drives the ADMIN-only `deleted=only` view via the URL. `statusLabel` maps to
 * the server's `statusLabelId` — ONE custom status (ADR-0101) — while `status` keeps filtering the built-in
 * status, which includes every custom status of that kind.
 */
export const ASSET_FILTER_DEFAULTS = {
  status: "ALL",
  statusLabel: "ALL",
  category: "ALL",
  model: "ALL",
  location: "ALL",
  company: "ALL",
  owner: "",
  ownership: "ALL",
  warranty: "ALL",
  archived: "ALL",
} as const;

/**
 * `useListParams` config for the assets list (defaults + first-paint sort), shared client/server.
 * `filterValidators` (#944) guards the enum-backed filters against a garbage/stale URL value (e.g. a
 * bookmarked `?status=INVENTADO` from a renamed status): an unrecognized value is dropped back to its
 * default at the SAME param-reading layer that derives `filters`/`query` — before it ever reaches a
 * translation call (`t(status)` → next-intl `MISSING_MESSAGE`) or the API (which would 400 on it).
 */
export const ASSET_LIST_OPTIONS = {
  filters: ASSET_FILTER_DEFAULTS,
  filterValidators: {
    status: AssetStatusSchema.options,
    ownership: ["HAS", "NONE"],
    warranty: AssetWarrantyFilterSchema.options,
    archived: ["only"],
  },
  defaultSort: "updatedAt",
  defaultDir: "desc" as const,
};

/**
 * Map the URL-derived list state to the server `AssetFilters` the list read is keyed by. `isAdmin`
 * gates the archived (`deleted=only`) slice exactly as the client does — the API keeps that view
 * ADMIN-only (`assertCanListDeleted`), so a non-admin never gets `deleted`. Everything at its
 * "ALL"/empty default collapses to `undefined` (dropped from the query key hash), so a no-param URL
 * yields the same first-paint key the unfiltered prefetch always used.
 */
export function deriveAssetFilters(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): AssetFilters {
  const { q, sort, dir, offset, limit, filters } = state;
  const archived = opts.isAdmin && filters.archived === "only";
  return {
    q: q || undefined,
    status: filters.status === "ALL" ? undefined : (filters.status as AssetStatus),
    statusLabelId: statusLabelFilterId(filters.statusLabel),
    categoryId: filters.category === "ALL" ? undefined : filters.category,
    modelId: filters.model === "ALL" ? undefined : filters.model,
    locationId: filters.location === "ALL" ? undefined : filters.location,
    company: filters.company === "ALL" ? undefined : filters.company,
    assignedToUserId: filters.owner || undefined,
    ownership:
      filters.ownership === "ALL" ? undefined : (filters.ownership as "HAS" | "NONE"),
    warranty:
      filters.warranty === "ALL"
        ? undefined
        : (filters.warranty as AssetWarrantyFilter),
    sort,
    dir: sort ? dir : undefined,
    limit,
    offset,
    deleted: archived ? "only" : undefined,
  };
}

/** A cuid as zod's `z.cuid()` (and so the API's `statusLabelId` param) accepts it. */
const CUID = /^[cC][^\s-]{8,}$/;

/**
 * The `statusLabel` URL value → the `statusLabelId` the API filters by. A custom status id is not an
 * enum, so `filterValidators` cannot guard it; a garbage or stale value (which the API would 400) is
 * dropped here instead, like the enum filters drop theirs.
 */
export function statusLabelFilterId(value: string | undefined): string | undefined {
  return value && value !== "ALL" && CUID.test(value) ? value : undefined;
}

/**
 * The status filter is ONE picker over two URL params (ADR-0101): a built-in status sets `status` (every
 * asset in it, labelled or not), a custom status sets `statusLabel`. Picking one clears the other, so the
 * two never narrow each other by accident. `null` clears both.
 */
export function statusFilterPatch(
  choice: { status: AssetStatus; labelId: string | null } | null,
): { status: string; statusLabel: string } {
  if (!choice) {
    return { status: ASSET_FILTER_DEFAULTS.status, statusLabel: ASSET_FILTER_DEFAULTS.statusLabel };
  }
  return choice.labelId
    ? { status: ASSET_FILTER_DEFAULTS.status, statusLabel: choice.labelId }
    : { status: choice.status, statusLabel: ASSET_FILTER_DEFAULTS.statusLabel };
}

/**
 * The picker's current choice from the URL filters: a custom status wins (its kind is resolved by the
 * picker from the options), then a built-in status, else none.
 */
export function statusFilterChoice(
  filters: { status?: string; statusLabel?: string },
  labelKind: (id: string) => AssetStatus | undefined,
): { status: AssetStatus; labelId: string | null } | null {
  const labelId = statusLabelFilterId(filters.statusLabel);
  if (labelId) {
    const kind = labelKind(labelId);
    if (kind) return { status: kind, labelId };
  }
  const parsed = AssetStatusSchema.safeParse(filters.status);
  return parsed.success ? { status: parsed.data, labelId: null } : null;
}
