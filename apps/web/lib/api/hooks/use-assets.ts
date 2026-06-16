import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type AssetFilters,
  getAsset,
  getAssetAssignments,
  getAssets,
} from "../endpoints/assets";
import { invalidateDashboard } from "./use-dashboard";

/**
 * Query keys for the Asset resource. Hand-written (not `createQueryKeys`) for the
 * bespoke shapes: a filtered list, and an asset's assignments nested under its
 * detail so invalidating the detail (or `all`) also refetches them. Mutations —
 * asset writes and assignment writes — invalidate `all`.
 */
export const assetKeys = {
  all: ["assets"] as const,
  lists: () => [...assetKeys.all, "list"] as const,
  list: (filters: AssetFilters) => [...assetKeys.all, "list", filters] as const,
  detail: (id: string) => [...assetKeys.all, "detail", id] as const,
  assignments: (assetId: string, activeOnly: boolean) =>
    [...assetKeys.all, "detail", assetId, "assignments", activeOnly] as const,
};

/**
 * The single asset write-side cache-invalidation hook, shared by BOTH asset write paths — the
 * Asset CRUD mutations (`use-asset-mutations`) AND the ownership/assignment mutations
 * (`use-asset-assignment-mutations`). It invalidates `assetKeys.all` (the common prefix → lists,
 * detail and the nested assignment lists all refetch) AND the dashboard, whose summary
 * (`assets.assigned`) and unified activity feed are DERIVED from asset + assignment writes — so a
 * stale dashboard after assigning/releasing an asset is the exact bug class #499 targets. Living
 * next to `assetKeys` keeps it as the one source of truth so the two write paths can't drift apart.
 */
export function useInvalidateAssets() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: assetKeys.all });
    invalidateDashboard(queryClient);
  };
}

/**
 * List assets, optionally filtered by category / location / status and paged
 * (`limit`/`offset`). Returns the `Page<AssetListItem>` envelope (`items` +
 * `total`/`limit`/`offset`) so the list can render pagination controls.
 * `keepPreviousData` holds the last page on screen while a new filter/page query
 * resolves, so changing a filter or paging doesn't flash the table skeleton.
 */
export function useAssets(filters: AssetFilters = {}) {
  return useQuery({
    queryKey: assetKeys.list(filters),
    queryFn: ({ signal }) => getAssets(filters, signal),
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single asset by id; idle until an id is provided. */
export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: assetKeys.detail(id ?? ""),
    queryFn: () => getAsset(id as string),
    enabled: Boolean(id),
  });
}

/** An asset's ownership assignments (active by default; pass false for history). */
export function useAssetAssignments(
  assetId: string | undefined,
  activeOnly = true,
) {
  return useQuery({
    queryKey: assetKeys.assignments(assetId ?? "", activeOnly),
    queryFn: () => getAssetAssignments(assetId as string, activeOnly),
    enabled: Boolean(assetId),
  });
}
