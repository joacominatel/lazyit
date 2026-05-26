import { useQuery } from "@tanstack/react-query";
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

/** List grants, filtered (e.g. all active grants for the Access list's counts/avatars). */
export function useAccessGrants(filters: AccessGrantFilters = {}) {
  return useQuery({
    queryKey: accessGrantKeys.list(filters),
    queryFn: () => getAccessGrants(filters),
  });
}
