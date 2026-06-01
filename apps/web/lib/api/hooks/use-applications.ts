import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ApplicationGrantsOptions,
  type ApplicationListParams,
  getApplication,
  getApplicationGrants,
  getApplications,
} from "../endpoints/applications";

/**
 * Query keys for the Application resource. Hand-written (not `createQueryKeys`) so an application's
 * grants nest under its detail — invalidating the detail (or `all`) also refetches the grants. A
 * parameterized `list(params)` keys the paginated Access list distinctly. Application and grant
 * mutations both invalidate `all`.
 */
export const applicationKeys = {
  all: ["applications"] as const,
  lists: () => [...applicationKeys.all, "list"] as const,
  list: (params: ApplicationListParams) =>
    [...applicationKeys.all, "list", params] as const,
  detail: (id: string) => [...applicationKeys.all, "detail", id] as const,
  grants: (id: string, options: ApplicationGrantsOptions) =>
    [...applicationKeys.all, "detail", id, "grants", options] as const,
};

/**
 * The full application directory as a flat `Application[]` — for screens that join applications
 * client-side (e.g. a user's grants on the user detail). Paginated server-side (ADR-0030), so this
 * requests the hard-max page (200); the **Access list page** uses {@link useApplicationList} for real
 * paging. Returns just `items`, so existing `Application[]` consumers are unchanged.
 */
export function useApplications() {
  return useQuery({
    queryKey: applicationKeys.lists(),
    queryFn: () => getApplications({ limit: MAX_PAGE_LIMIT }),
    select: (page) => page.items,
  });
}

/**
 * The Access (applications) list page: a single page with server-side `q`/`sort` and paging (returns
 * the `Page<Application>` envelope). Category + criticality are filtered client-side over the page
 * (no server params). `keepPreviousData` holds the current page while the next resolves.
 */
export function useApplicationList(params: ApplicationListParams = {}) {
  return useQuery({
    queryKey: applicationKeys.list(params),
    queryFn: () => getApplications(params),
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single application by id; idle until an id is provided. */
export function useApplication(id: string | undefined) {
  return useQuery({
    queryKey: applicationKeys.detail(id ?? ""),
    queryFn: () => getApplication(id as string),
    enabled: Boolean(id),
  });
}

/** An application's grants (active by default; pass `activeOnly: false` for the full history). */
export function useApplicationGrants(
  id: string | undefined,
  options: ApplicationGrantsOptions = {},
) {
  return useQuery({
    queryKey: applicationKeys.grants(id ?? "", options),
    queryFn: () => getApplicationGrants(id as string, options),
    enabled: Boolean(id),
  });
}
