import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateAsset, UpdateAsset } from "@lazyit/shared";
import { createAsset, deleteAsset, updateAsset } from "../endpoints/assets";
import { assetKeys } from "./use-assets";

/**
 * Write hooks for the Asset resource. Each invalidates `assetKeys.all` on success
 * (the common prefix → lists, detail and nested assignments all refetch). Toasts,
 * navigation and dialog state are owned by the calling component.
 */

function useInvalidateAssets() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: assetKeys.all });
}

export function useCreateAsset() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (data: CreateAsset) => createAsset(data),
    onSuccess: invalidate,
  });
}

export function useUpdateAsset() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAsset }) =>
      updateAsset(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteAsset() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (id: string) => deleteAsset(id),
    onSuccess: invalidate,
  });
}
