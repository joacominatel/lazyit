import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateAssetCategory,
  UpdateAssetCategory,
} from "@lazyit/shared";
import {
  createAssetCategory,
  deleteAssetCategory,
  getAssetCategories,
  updateAssetCategory,
} from "../endpoints/asset-categories";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset categories. */
export const assetCategoryKeys = createQueryKeys("asset-categories");

/** List all asset categories (asset list filter + the Settings → Taxonomies table). */
export function useAssetCategories() {
  return useQuery({
    queryKey: assetCategoryKeys.lists(),
    queryFn: getAssetCategories,
  });
}

/** Create an asset category; invalidates the list. Toasts/dialog state stay with the caller. */
export function useCreateAssetCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAssetCategory) => createAssetCategory(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetCategoryKeys.all }),
  });
}

/** Update an asset category; invalidates the list. */
export function useUpdateAssetCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAssetCategory }) =>
      updateAssetCategory(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetCategoryKeys.all }),
  });
}

/** Soft-delete an asset category; invalidates the list. */
export function useDeleteAssetCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAssetCategory(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetCategoryKeys.all }),
  });
}
