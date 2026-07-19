import { useMutation } from "@tanstack/react-query";
import type {
  AcknowledgeAssignment,
  CreateAssetAssignment,
  ReleaseAssetAssignment,
  UpdateAssetAssignmentNotes,
} from "@lazyit/shared";
import {
  acknowledgeAssetAssignment,
  createAssetAssignment,
  releaseAssetAssignment,
  updateAssetAssignmentNotes,
} from "../endpoints/asset-assignments";
import { useInvalidateAssets } from "./use-assets";

/**
 * Write hooks for asset ownership. Each invalidates `assetKeys.all` (so the asset
 * detail and its assignment lists — owners + history — refetch) AND the dashboard
 * via the SHARED `useInvalidateAssets` helper: assigning / releasing an asset moves
 * the summary's `assets.assigned` count and appends an `AssetAssignment` row to the
 * unified activity feed, both DERIVED reads that would otherwise stay stale up to the
 * global 60s `staleTime` (issue #499). Reusing the one helper keeps these in lockstep
 * with the Asset CRUD write path. These are bespoke (assign / release / notes) —
 * another reason the Asset hooks stay hand-written rather than coming from a fixed
 * factory (ADR-0020).
 */

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

/**
 * Acknowledge receipt of the caller's OWN active assignment (ADR-0089 Part B, #1029). Self-service and
 * set-once; a 409 (already acknowledged / released / not yours) is surfaced by the caller. Invalidates
 * the shared asset cache so the owners panel repaints its acknowledged state and the asset's activity
 * log picks up the ACKNOWLEDGED event.
 */
export function useAcknowledgeAssignment() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: AcknowledgeAssignment }) =>
      acknowledgeAssetAssignment(id, data),
    onSuccess: invalidate,
  });
}
