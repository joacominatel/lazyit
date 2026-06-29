import type {
  CreateLocation,
  Location,
  LocationType,
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
 * `sort` is allowlisted to `name|type|createdAt|updatedAt` (unknown → 400). `type` is the
 * server-side location-type filter, scoping the whole result set (#824). `limit`/`offset` thread
 * the pagination window (ADR-0030). `deleted: "only"` is the ADMIN-only archived view.
 */
export interface LocationListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  /** Server-side location-type filter; scopes the whole result set (#824). */
  type?: LocationType;
  limit?: number;
  offset?: number;
  deleted?: "only";
}

/**
 * List locations, paged. `GET /locations` returns a `Page<Location>` envelope; we return
 * the whole envelope (`items` + `total`/`limit`/`offset`) so the list can paginate. Only
 * server-supported params are forwarded (extra client-only filter keys are ignored). Default is
 * active-only; pass `deleted: "only"` (ADMIN) for the archived view.
 */
export function getLocations(
  params: LocationListParams = {},
  signal?: AbortSignal,
  // Optional Bearer override for SSR server-prefetch (ADR-0067) — see `getAssets`.
  token?: string,
): Promise<Page<Location>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.type) qs.set("type", params.type);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  const search = qs.toString();
  return apiFetch<Page<Location>>(
    search ? `${BASE}?${search}` : BASE,
    { signal, token },
  );
}
export const getLocation = locations.get;
export const createLocation = locations.create;
export const updateLocation = locations.update;
export const deleteLocation = locations.remove;

/**
 * Restore one soft-deleted location (`POST /locations/:id/restore`, ADMIN). Clears `deletedAt` and
 * returns the restored row.
 */
export function restoreLocation(id: string): Promise<Location> {
  return apiFetch<Location>(`${BASE}/${id}/restore`, { method: "POST" });
}
