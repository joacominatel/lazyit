import { useQuery } from "@tanstack/react-query";
import { getAssetModels } from "../endpoints/asset-models";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset models (read-only in the current scope). */
export const assetModelKeys = createQueryKeys("asset-models");

/** List all asset models (for the asset form's model select). */
export function useAssetModels() {
  return useQuery({
    queryKey: assetModelKeys.lists(),
    queryFn: getAssetModels,
  });
}
