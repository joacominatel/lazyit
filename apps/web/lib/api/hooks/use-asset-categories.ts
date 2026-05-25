import { useQuery } from "@tanstack/react-query";
import { getAssetCategories } from "../endpoints/asset-categories";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset categories (read-only in the current scope). */
export const assetCategoryKeys = createQueryKeys("asset-categories");

/** List all asset categories (for the asset list's category filter). */
export function useAssetCategories() {
  return useQuery({
    queryKey: assetCategoryKeys.lists(),
    queryFn: getAssetCategories,
  });
}
