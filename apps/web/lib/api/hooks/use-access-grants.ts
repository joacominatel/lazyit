import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type AccessGrantFilters,
  getAccessGrants,
  getMyGrants,
} from "../endpoints/access-grants";

/**
 * Query keys for AccessGrant lists. Read-only here (the writes live in use-access-grant-mutations
 * and invalidate this `all` prefix plus the applications cache).
 */
export const accessGrantKeys = {
  all: ["access-grants"] as const,
  list: (filters: AccessGrantFilters) =>
    [...accessGrantKeys.all, "list", filters] as const,
  /** The caller's OWN grants (`GET /access-grants/mine`, #947) — the self-service `/profile` read. */
  mine: () => [...accessGrantKeys.all, "mine"] as const,
};

/**
 * List grants, filtered and paged (e.g. all active grants for the Access list's
 * counts/avatars, fetched with a large `limit`). Returns the `Page<AccessGrant>`
 * envelope (`items` + `total`/`limit`/`offset`). `keepPreviousData` holds the
 * current page while a new filter/page query resolves, avoiding a skeleton flash.
 *
 * `enabled` lets a caller skip the fetch when it would only 403 — e.g. the Access list's grantee
 * column for a VIEWER who lacks `accessGrant:read` (issue #935): don't fire a doomed request.
 */
export function useAccessGrants(
  filters: AccessGrantFilters = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: accessGrantKeys.list(filters),
    queryFn: () => getAccessGrants(filters),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The caller's OWN access grants (`GET /access-grants/mine`, #947) — active + revoked history, for
 * the self-service `/profile` page. A SELF-SCOPE read: any authenticated human, no `accessGrant:read`
 * (a VIEWER lacks it, so this is the ONLY way they can see their own access). Returns the
 * `Page<AccessGrant>` envelope; the grant rows are lean (applicationId only), so the profile resolves
 * the application label from the applications catalog. `limit` gathers the whole history in one page.
 */
export function useMyGrants({ limit = 200 }: { limit?: number } = {}) {
  return useQuery({
    queryKey: accessGrantKeys.mine(),
    queryFn: () => getMyGrants({ limit }),
  });
}
