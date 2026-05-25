import type { CreateLocation, Location, UpdateLocation } from "@lazyit/shared";
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

export const getLocations = locations.list;
export const getLocation = locations.get;
export const createLocation = locations.create;
export const updateLocation = locations.update;
export const deleteLocation = locations.remove;
