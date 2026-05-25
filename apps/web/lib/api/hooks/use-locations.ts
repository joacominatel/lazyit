import { useQuery } from "@tanstack/react-query";
import { getLocation, getLocations } from "../endpoints/locations";

/**
 * Query keys for the Location resource, centralized so the read hooks and the
 * mutation hooks (which invalidate them) can never drift. Copy this shape for
 * each new entity: `all` for the list, `detail(id)` for a single record.
 */
export const locationKeys = {
  all: ["locations"] as const,
  detail: (id: string) => ["locations", id] as const,
};

/** List all (non-soft-deleted) locations. */
export function useLocations() {
  return useQuery({
    queryKey: locationKeys.all,
    queryFn: getLocations,
  });
}

/** Fetch a single location by id; idle until an id is provided. */
export function useLocation(id: string | undefined) {
  return useQuery({
    queryKey: locationKeys.detail(id ?? ""),
    queryFn: () => getLocation(id as string),
    enabled: Boolean(id),
  });
}
