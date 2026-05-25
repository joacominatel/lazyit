import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from "@lazyit/shared";
import {
  createAssetAssignment,
  releaseAssetAssignment,
  updateAssetAssignmentNotes,
} from "../endpoints/asset-assignments";
import { assetKeys } from "./use-assets";

/**
 * Write hooks for asset ownership. Each invalidates `assetKeys.all` so the asset
 * detail and its assignment lists (owners + history) refetch. These are bespoke
 * (assign / release / notes) — another reason the Asset hooks stay hand-written
 * rather than coming from a fixed factory (ADR-0020).
 */

function useInvalidateAssets() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: assetKeys.all });
}

export function useAssignUser() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (data: CreateAssetAssignment) => createAssetAssignment(data),
    onSuccess: invalidate,
  });
}

export function useReleaseAssignment() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: ReleaseAssetAssignment }) =>
      releaseAssetAssignment(id, data),
    onSuccess: invalidate,
  });
}

export function useUpdateAssignmentNotes() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateAssetAssignmentNotes;
    }) => updateAssetAssignmentNotes(id, data),
    onSuccess: invalidate,
  });
}
