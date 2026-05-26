import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateAccessGrant, RevokeAccessGrant } from "@lazyit/shared";
import {
  createAccessGrant,
  revokeAccessGrant,
} from "../endpoints/access-grants";
import { accessGrantKeys } from "./use-access-grants";
import { applicationKeys } from "./use-applications";

/**
 * Grant / revoke writes. Each invalidates both the grant lists and the applications cache: the
 * Access list shows per-application active-grant counts + avatars, and the detail shows the grant
 * panels — all of which derive from grant state.
 */
function useInvalidateGrants() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: accessGrantKeys.all });
    queryClient.invalidateQueries({ queryKey: applicationKeys.all });
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
