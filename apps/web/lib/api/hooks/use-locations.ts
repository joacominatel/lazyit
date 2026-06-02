import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getLocation,
  getLocations,
  type LocationListParams,
} from "../endpoints/locations";
import { createQueryKeys } from "../query-keys";

/**
 * Query-key factory for the Location resource (shape from `createQueryKeys`, see
 * ADR-0020): `all` → `["locations"]`, `lists()` → `["locations", "list"]`,
 * `detail(id)` → `["locations", "detail", id]`. A parameterized `list(params)` keys the paginated
 * list page distinctly. Mutations invalidate `all`.
 */
const baseLocationKeys = createQueryKeys("locations");
export const locationKeys = {
  ...baseLocationKeys,
  list: (params: LocationListParams) =>
    [...baseLocationKeys.all, "list", params] as const,
};

/**
 * The full location directory as a flat `Location[]` — for the screens that pick a location from a
 * dropdown (the asset form, the asset list's location filter). Paginated server-side (ADR-0030), so
 * this requests the hard-max page (200) to materialize the whole directory; the **Locations list
 * page** uses {@link useLocationList} for real paging. Returns just `items`, so existing
 * `Location[]` consumers are unchanged.
 */
export function useLocations() {
  return useQuery({
    queryKey: locationKeys.lists(),
    queryFn: () => getLocations({ limit: MAX_PAGE_LIMIT }),
    select: (page) => page.items,
  });
}

/**
 * The Locations list page: a single page with server-side `q`/`sort` and paging (returns the
 * `Page<Location>` envelope). `keepPreviousData` holds the current page while the next resolves.
 */
export function useLocationList(params: LocationListParams = {}) {
  return useQuery({
    queryKey: locationKeys.list(params),
    queryFn: () => getLocations(params),
    placeholderData: keepPreviousData,
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
