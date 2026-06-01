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
const locations = createCrudEndpoints<Location, CreateLocation, UpdateLocation>(
  "/locations",
);

// `GET /locations` is paginated (ADR-0030 amendment): unwrap the `Page<Location>`
// envelope to its `items` for the current array-based screen. The list-chain wave
// will consume the full envelope + server-side params.
export const getLocations = (): Promise<Location[]> =>
  apiFetch<Page<Location>>("/locations").then((page) => page.items);
export const getLocation = locations.get;
export const createLocation = locations.create;
export const updateLocation = locations.update;
export const deleteLocation = locations.remove;
