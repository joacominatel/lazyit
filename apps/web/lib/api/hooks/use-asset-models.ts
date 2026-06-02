import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateAssetModel, UpdateAssetModel } from "@lazyit/shared";
import {
  createAssetModel,
  deleteAssetModel,
  getAssetModels,
  updateAssetModel,
} from "../endpoints/asset-models";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset models. */
export const assetModelKeys = createQueryKeys("asset-models");

/** List all asset models (asset form's model select + the Settings → Taxonomies table). */
export function useAssetModels() {
  return useQuery({
    queryKey: assetModelKeys.lists(),
    queryFn: getAssetModels,
  });
}

/** Create an asset model (inline "+ New model" + Settings); invalidates the model list. */
export function useCreateAssetModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAssetModel) => createAssetModel(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetModelKeys.all }),
  });
}

/** Update an asset model; invalidates the model list. */
export function useUpdateAssetModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAssetModel }) =>
      updateAssetModel(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetModelKeys.all }),
  });
}

/** Soft-delete an asset model; invalidates the model list. */
export function useDeleteAssetModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAssetModel(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetModelKeys.all }),
  });
}
