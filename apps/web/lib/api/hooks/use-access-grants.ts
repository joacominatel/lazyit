import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type AccessGrantFilters,
  getAccessGrants,
} from "../endpoints/access-grants";

/**
 * Query keys for AccessGrant lists. Read-only here (the writes live in use-access-grant-mutations
 * and invalidate this `all` prefix plus the applications cache).
 */
export const accessGrantKeys = {
  all: ["access-grants"] as const,
  list: (filters: AccessGrantFilters) =>
    [...accessGrantKeys.all, "list", filters] as const,
};

/**
 * List grants, filtered and paged (e.g. all active grants for the Access list's
 * counts/avatars, fetched with a large `limit`). Returns the `Page<AccessGrant>`
 * envelope (`items` + `total`/`limit`/`offset`). `keepPreviousData` holds the
 * current page while a new filter/page query resolves, avoiding a skeleton flash.
 */
export function useAccessGrants(filters: AccessGrantFilters = {}) {
  return useQuery({
    queryKey: accessGrantKeys.list(filters),
    queryFn: () => getAccessGrants(filters),
    placeholderData: keepPreviousData,
  });
}
