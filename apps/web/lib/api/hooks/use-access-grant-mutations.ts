import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CreateAccessGrant,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from "@lazyit/shared";
import {
  createAccessGrant,
  revokeAccessGrant,
  updateAccessGrantExpiry,
  updateAccessGrantNotes,
} from "../endpoints/access-grants";
import { accessGrantKeys } from "./use-access-grants";
import { applicationKeys } from "./use-applications";
import { userKeys } from "./use-users";

/**
 * Grant / revoke / edit writes. Each invalidates the grant lists, the applications cache AND the
 * users cache: the Access list shows per-application active-grant counts + avatars, the application
 * detail shows the grant panels, and the user detail shows that user's grants — all of which derive
 * from grant state.
 */
function useInvalidateGrants() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accessGrantKeys.all });
    queryClient.invalidateQueries({ queryKey: applicationKeys.all });
    queryClient.invalidateQueries({ queryKey: userKeys.all });
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
