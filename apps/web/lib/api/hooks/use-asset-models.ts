import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type CreateAssetModel,
  MAX_PAGE_LIMIT,
  type UpdateAssetModel,
} from "@lazyit/shared";
import {
  type AssetModelListParams,
  createAssetModel,
  deleteAssetModel,
  getAssetModel,
  getAssetModels,
  updateAssetModel,
} from "../endpoints/asset-models";
import { createQueryKeys } from "../query-keys";

/** Query keys for Asset models. */
const baseAssetModelKeys = createQueryKeys("asset-models");
export const assetModelKeys = {
  ...baseAssetModelKeys,
  /** A parameterized (search/paged) list page — distinct from the bare directory `lists()`. */
  list: (params: AssetModelListParams) =>
    [...baseAssetModelKeys.all, "list", params] as const,
};

/**
 * The full model directory as a flat `AssetModel[]` — for the asset form's model select and the
 * Settings → Taxonomies table. The list is paginated server-side (ADR-0030), so this requests the
 * hard-max page (200) to materialize the directory; the searchable picker uses {@link
 * useAssetModelList} for real `q`-driven paging. Returns just `items` so existing `AssetModel[]`
 * consumers are unchanged (issue #199).
 */
export function useAssetModels() {
  return useQuery({
    queryKey: assetModelKeys.lists(),
    queryFn: () => getAssetModels({ limit: MAX_PAGE_LIMIT }),
    select: (page) => page.items,
  });
}

/**
 * A single page of asset models with server-side `q` search and paging (returns the
 * `AssetModelListPage` envelope) — backs the searchable model Combobox. `keepPreviousData` holds the
 * current page while the next query resolves so searching doesn't flash an empty list.
 */
export function useAssetModelList(params: AssetModelListParams = {}) {
  return useQuery({
    queryKey: assetModelKeys.list(params),
    queryFn: () => getAssetModels(params),
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single asset model by id; idle until an id is provided (resolves the picker's label). */
export function useAssetModel(id: string | undefined) {
  return useQuery({
    queryKey: assetModelKeys.detail(id ?? ""),
    queryFn: () => getAssetModel(id as string),
    enabled: Boolean(id),
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
