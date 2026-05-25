import { useQuery } from "@tanstack/react-query";
import {
  type AssetFilters,
  getAsset,
  getAssetAssignments,
  getAssets,
} from "../endpoints/assets";

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

/** List assets, optionally filtered by category / location / status. */
export function useAssets(filters: AssetFilters = {}) {
  return useQuery({
    queryKey: assetKeys.list(filters),
    queryFn: () => getAssets(filters),
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
