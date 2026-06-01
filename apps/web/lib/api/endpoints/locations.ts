import type {
  CreateLocation,
  Location,
  Page,
  UpdateLocation,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Pure data-access functions for the Location resource — the ONLY place that
 * talks to `apiFetch` for locations. Hooks (../hooks) wrap these in TanStack
 * Query; pages/components consume the hooks. The standard CRUD bodies come from
 * `createCrudEndpoints`; they keep their named, per-resource signatures so the
 * hooks (and the docs in ADR-0020) are unchanged.
 *
 * Routes mirror apps/api/src/locations (see the Location entity note + ADR-0018).
 * Timestamps come back as ISO strings, not `Date` instances.
 */
const BASE = "/locations";
const locations = createCrudEndpoints<Location, CreateLocation, UpdateLocation>(
  BASE,
);

/**
 * Server-side params for the location list (#104). `q` matches name/address/floor/description;
 * `sort` is allowlisted to `name|type|createdAt|updatedAt` (unknown → 400). The location-type filter
 * is NOT a server param — the screen applies it client-side over the page. `limit`/`offset` thread
 * the pagination window (ADR-0030).
 */
export interface LocationListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * List non-deleted locations, paged. `GET /locations` returns a `Page<Location>` envelope; we return
 * the whole envelope (`items` + `total`/`limit`/`offset`) so the list can paginate. Only
 * server-supported params are forwarded (extra client-only filter keys are ignored).
 */
export function getLocations(
  params: LocationListParams = {},
): Promise<Page<Location>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const search = qs.toString();
  return apiFetch<Page<Location>>(search ? `${BASE}?${search}` : BASE);
}
export const getLocation = locations.get;
export const createLocation = locations.create;
export const updateLocation = locations.update;
export const deleteLocation = locations.remove;
