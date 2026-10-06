import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateAssetStatusLabel,
  UpdateAssetStatusLabel,
} from "@lazyit/shared";
import {
  type AssetStatusLabelReassign,
  createAssetStatusLabel,
  deleteAssetStatusLabel,
  getAssetStatusLabels,
  restoreAssetStatusLabel,
  updateAssetStatusLabel,
} from "../endpoints/asset-status-labels";
import { assetStatusLabelKeys } from "../query-keys";
import { useInvalidateAssets } from "./use-assets";
import { useCan } from "@/lib/hooks/use-permissions";

/**
 * Custom asset statuses (ADR-0101, #1524). The list is small and unpaged; every picker (asset form, bulk
 * status, receive dialog, list filter) and the Settings → Taxonomies → Statuses tab read the same cached
 * list. Toasts and dialog state stay with the caller.
 */

/**
 * Every live custom status. Idle without `category:read` (the API would 403): the pickers then offer the
 * built-in statuses only, exactly as before custom statuses existed.
 */
export function useAssetStatusLabels() {
  const canRead = useCan("category:read");
  return useQuery({
    queryKey: assetStatusLabelKeys.lists(),
    queryFn: ({ signal }) => getAssetStatusLabels({}, signal),
    enabled: canRead,
  });
}

/** The archived custom statuses — ADMIN-only on the API (ADR-0041); enable it only for an admin. */
export function useArchivedAssetStatusLabels(enabled: boolean) {
  return useQuery({
    queryKey: assetStatusLabelKeys.archived(),
    queryFn: ({ signal }) => getAssetStatusLabels({ deleted: "only" }, signal),
    enabled,
  });
}

export function useCreateAssetStatusLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAssetStatusLabel) => createAssetStatusLabel(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetStatusLabelKeys.all }),
  });
}

/**
 * Update a custom status. Invalidates the assets as well as the custom statuses (`useInvalidateAssets`
 * covers both): a rename changes the name every asset read inlines.
 */
export function useUpdateAssetStatusLabel() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAssetStatusLabel }) =>
      updateAssetStatusLabel(id, data),
    onSuccess: invalidate,
  });
}

/**
 * Archive a custom status, moving its assets to `target` (see `deleteAssetStatusLabel`). The moved assets
 * and the dashboard refresh with the custom statuses.
 */
export function useDeleteAssetStatusLabel() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({
      id,
      target,
    }: {
      id: string;
      target: AssetStatusLabelReassign;
    }) => deleteAssetStatusLabel(id, target),
    onSuccess: invalidate,
  });
}

export function useRestoreAssetStatusLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreAssetStatusLabel(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetStatusLabelKeys.all }),
  });
}
