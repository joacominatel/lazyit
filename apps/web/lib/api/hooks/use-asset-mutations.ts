import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BatchAssetStatus, CreateAsset, UpdateAsset } from "@lazyit/shared";
import {
  batchDeleteAssets,
  batchRestoreAssets,
  batchSetAssetStatus,
  createAsset,
  deleteAsset,
  restoreAsset,
  updateAsset,
} from "../endpoints/assets";
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

/** Restore one soft-deleted asset (ADMIN). Invalidates the asset cache so the archived list updates. */
export function useRestoreAsset() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (id: string) => restoreAsset(id),
    onSuccess: invalidate,
  });
}

/**
 * Bulk asset actions (ADMIN, #104) — each returns a `BatchResult` so the caller can toast the
 * `{ succeeded, skipped }` outcome, and each invalidates the asset cache on settle.
 */
export function useBatchDeleteAssets() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (ids: string[]) => batchDeleteAssets(ids),
    onSuccess: invalidate,
  });
}

export function useBatchRestoreAssets() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (ids: string[]) => batchRestoreAssets(ids),
    onSuccess: invalidate,
  });
}

export function useBatchSetAssetStatus() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({
      ids,
      status,
    }: {
      ids: string[];
      status: BatchAssetStatus["status"];
    }) => batchSetAssetStatus(ids, status),
    onSuccess: invalidate,
  });
}
