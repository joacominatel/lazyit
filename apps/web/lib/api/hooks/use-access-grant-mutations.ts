import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  BatchRevokeGrants,
  CreateAccessGrant,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from "@lazyit/shared";
import {
  batchRevokeGrants,
  createAccessGrant,
  revokeAccessGrant,
  updateAccessGrantExpiry,
  updateAccessGrantNotes,
} from "../endpoints/access-grants";
import { accessGrantKeys } from "./use-access-grants";
import { applicationKeys } from "./use-applications";
import { invalidateDashboard } from "./use-dashboard";
import { userKeys } from "./use-users";

/**
 * Grant / revoke / edit writes. Each invalidates the grant lists, the applications cache AND the
 * users cache: the Access list shows per-application active-grant counts + avatars, the application
 * detail shows the grant panels, and the user detail shows that user's grants — all of which derive
 * from grant state. Also invalidates the dashboard, whose active/expiring/critical-grant tallies
 * derive from the same state (issue #499).
 */
function useInvalidateGrants() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accessGrantKeys.all });
    queryClient.invalidateQueries({ queryKey: applicationKeys.all });
    queryClient.invalidateQueries({ queryKey: userKeys.all });
    invalidateDashboard(queryClient);
  };
}

export function useGrantAccess() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: (data: CreateAccessGrant) => createAccessGrant(data),
    onSuccess: invalidate,
  });
}

export function useRevokeGrant() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RevokeAccessGrant }) =>
      revokeAccessGrant(id, data),
    onSuccess: invalidate,
  });
}

/**
 * Bulk revoke active grants (ADMIN, #104). Returns a `BatchResult` so the caller can toast the
 * `{ succeeded, skipped }` outcome; invalidates the same caches as a single revoke on settle.
 */
export function useBatchRevokeGrants() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: ({
      ids,
      notes,
    }: {
      ids: string[];
      notes?: BatchRevokeGrants["notes"];
    }) => batchRevokeGrants(ids, notes),
    onSuccess: invalidate,
  });
}

/** Edit a grant's notes (`null` clears). Metadata edit — identity stays immutable (ADR-0023). */
export function useUpdateGrantNotes() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAccessGrantNotes }) =>
      updateAccessGrantNotes(id, data),
    onSuccess: invalidate,
  });
}

/** Edit a grant's expiry (`null` makes it permanent). Informative only — never auto-revokes. */
export function useUpdateGrantExpiry() {
  const invalidate = useInvalidateGrants();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAccessGrantExpiry }) =>
      updateAccessGrantExpiry(id, data),
    onSuccess: invalidate,
  });
}
