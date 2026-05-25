import { useQuery } from "@tanstack/react-query";
import { getLocation, getLocations } from "../endpoints/locations";

/**
 * Query-key factory for the Location resource, centralized so the read hooks and
 * the mutation hooks (which invalidate them) can never drift. Copy this shape for
 * every new entity (`userKeys`, `assetKeys`, …):
 *
 * - `all`        → `["locations"]`            — root/prefix for the whole resource
 * - `lists()`    → `["locations", "list"]`    — the list query
 * - `detail(id)` → `["locations", "detail", id]` — a single record
 *
 * Mutations invalidate `all`; being the common prefix, it refetches lists + details.
 */
export const locationKeys = {
  all: ["locations"] as const,
  lists: () => [...locationKeys.all, "list"] as const,
  detail: (id: string) => [...locationKeys.all, "detail", id] as const,
};

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
