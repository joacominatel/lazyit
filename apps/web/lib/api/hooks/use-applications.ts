import { useQuery } from "@tanstack/react-query";
import {
  type ApplicationGrantsOptions,
  getApplication,
  getApplicationGrants,
  getApplications,
} from "../endpoints/applications";

/**
 * Query keys for the Application resource. Hand-written (not `createQueryKeys`) so an application's
 * grants nest under its detail — invalidating the detail (or `all`) also refetches the grants.
 * Application and grant mutations both invalidate `all`.
 */
export const applicationKeys = {
  all: ["applications"] as const,
  lists: () => [...applicationKeys.all, "list"] as const,
  detail: (id: string) => [...applicationKeys.all, "detail", id] as const,
  grants: (id: string, options: ApplicationGrantsOptions) =>
    [...applicationKeys.all, "detail", id, "grants", options] as const,
};

/** List all applications (raw; the screen joins category + grants client-side). */
export function useApplications() {
  return useQuery({
    queryKey: applicationKeys.lists(),
    queryFn: getApplications,
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
