import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreateAccessRequest, DenyAccessRequest } from "@lazyit/shared";
import {
  type AccessRequestFilters,
  approveAccessRequest,
  createAccessRequest,
  denyAccessRequest,
  getAccessRequests,
  getMyAccessRequests,
} from "../endpoints/access-requests";
import { accessGrantKeys } from "./use-access-grants";
import { applicationKeys } from "./use-applications";
import { invalidateDashboard } from "./use-dashboard";
import { userKeys } from "./use-users";

/**
 * Query keys + hooks for AccessRequest (the request→approve/deny→grant flow, ADR-0085). The estate
 * queue (`list`) is `accessRequest:read` (ADMIN+MEMBER); `mine` is the self-scope read (any human).
 * Writes invalidate the request lists; approve also invalidates the grant/application/user/dashboard
 * caches, because approving CREATES an AccessGrant through the existing grant path.
 */
export const accessRequestKeys = {
  all: ["access-requests"] as const,
  list: (filters: AccessRequestFilters) =>
    [...accessRequestKeys.all, "list", filters] as const,
  /** The caller's OWN requests (`GET /access-requests/mine`) — the self-service tracking read. */
  mine: () => [...accessRequestKeys.all, "mine"] as const,
};

/**
 * The estate-wide access-request queue (`GET /access-requests`, `accessRequest:read`). Filtered and
 * paged; `keepPreviousData` holds the current page while a filter/page query resolves. `enabled` lets
 * a caller skip the fetch when it would only 403 (a VIEWER lacks `accessRequest:read`).
 */
export function useAccessRequests(
  filters: AccessRequestFilters = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: accessRequestKeys.list(filters),
    queryFn: () => getAccessRequests(filters),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The caller's OWN access requests (`GET /access-requests/mine`) — pending + decided. A SELF-SCOPE
 * read (any authenticated human, no `accessRequest:read`), so a VIEWER can still track their own
 * requests. `limit` gathers the whole history in one page. `enabled` skips the fetch where it isn't
 * needed (e.g. an admin who grants directly on application detail).
 */
export function useMyAccessRequests({
  limit = 200,
  enabled = true,
}: { limit?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: accessRequestKeys.mine(),
    queryFn: () => getMyAccessRequests({ limit }),
    enabled,
  });
}

/** Invalidate the request lists (queue + mine) after any decision or a new request. */
function useInvalidateRequests() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: accessRequestKeys.all });
}

/** Raise a request for access to an application. 409 if a PENDING request already exists. */
export function useCreateAccessRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (data: CreateAccessRequest) => createAccessRequest(data),
    onSuccess: invalidate,
  });
}

/**
 * Approve a request — creates a grant + closes the request in one transaction. Invalidates the request
 * lists AND the grant/application/user/dashboard caches (the new grant derives those), matching the
 * direct-grant write's invalidation set.
 */
export function useApproveAccessRequest() {
  const queryClient = useQueryClient();
  const invalidateRequests = useInvalidateRequests();
  return useMutation({
    mutationFn: (id: string) => approveAccessRequest(id),
    onSuccess: () => {
      invalidateRequests();
      queryClient.invalidateQueries({ queryKey: accessGrantKeys.all });
      queryClient.invalidateQueries({ queryKey: applicationKeys.all });
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      invalidateDashboard(queryClient);
    },
  });
}

/** Deny a request (a reason is required). Invalidates the request lists. */
export function useDenyAccessRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: DenyAccessRequest }) =>
      denyAccessRequest(id, data),
    onSuccess: invalidate,
  });
}
