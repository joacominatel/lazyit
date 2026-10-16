import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateAssetCategory,
  DeleteResolution,
  UpdateAssetCategory,
} from "@lazyit/shared";
import {
  createAssetCategory,
  deleteAssetCategory,
  getAssetCategories,
  getAssetCategoryDeleteImpact,
  updateAssetCategory,
} from "../endpoints/asset-categories";
import { createQueryKeys } from "../query-keys";
import { assetModelKeys } from "./use-asset-models";
import { assetKeys } from "./use-assets";

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
    mutationFn: ({ id, resolution }: { id: string; resolution?: DeleteResolution }) =>
      deleteAssetCategory(id, resolution),
    onSuccess: (_category, { resolution }) => {
      queryClient.invalidateQueries({ queryKey: assetCategoryKeys.all });
      // A resolution re-filed the models, and their assets show the category through them.
      if (resolution) {
        queryClient.invalidateQueries({ queryKey: assetModelKeys.all });
        queryClient.invalidateQueries({ queryKey: assetKeys.all });
      }
    },
  });
}

export function useAssetCategoryDeleteImpact(id: string | undefined) {
  return useQuery({
    queryKey: [...assetCategoryKeys.all, "delete-impact", id ?? ""],
    queryFn: () => getAssetCategoryDeleteImpact(id as string),
    enabled: Boolean(id),
    staleTime: 0,
  });
}
