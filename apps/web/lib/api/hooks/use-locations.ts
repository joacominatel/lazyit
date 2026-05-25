import { useQuery } from "@tanstack/react-query";
import { getLocation, getLocations } from "../endpoints/locations";
import { createQueryKeys } from "../query-keys";

/**
 * Query-key factory for the Location resource (shape from `createQueryKeys`, see
 * ADR-0020): `all` → `["locations"]`, `lists()` → `["locations", "list"]`,
 * `detail(id)` → `["locations", "detail", id]`. Mutations invalidate `all`.
 */
export const locationKeys = createQueryKeys("locations");

/** List all (non-soft-deleted) locations. */
export function useLocations() {
  return useQuery({
    queryKey: locationKeys.lists(),
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
