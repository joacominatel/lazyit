import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateAssetModel } from "@lazyit/shared";
import { createAssetModel, getAssetModels } from "../endpoints/asset-models";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset models. */
export const assetModelKeys = createQueryKeys("asset-models");

/** List all asset models (for the asset form's model select). */
export function useAssetModels() {
  return useQuery({
    queryKey: assetModelKeys.lists(),
    queryFn: getAssetModels,
  });
}

/** Create an asset model (inline "+ New model"); invalidates the model list. */
export function useCreateAssetModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAssetModel) => createAssetModel(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: assetModelKeys.all }),
  });
}
