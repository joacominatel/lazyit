import type { CreateLocation, Location, UpdateLocation } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the Location resource. This is the ONLY place
 * that talks to `apiFetch` for locations — hooks (../hooks) wrap these in
 * TanStack Query, and pages/components consume the hooks. Nothing calls `fetch`
 * (or `apiFetch`) directly. This split is the template for every future entity.
 *
 * Routes mirror apps/api/src/locations (see the Location entity note + ADR-0018).
 * Timestamps come back as ISO strings, not `Date` instances.
 */

const BASE = "/locations";

export function getLocations(): Promise<Location[]> {
  return apiFetch<Location[]>(BASE);
}

export function getLocation(id: string): Promise<Location> {
  return apiFetch<Location>(`${BASE}/${id}`);
}

export function createLocation(data: CreateLocation): Promise<Location> {
  return apiFetch<Location>(BASE, { method: "POST", body: data });
}

export function updateLocation(
  id: string,
  data: UpdateLocation,
): Promise<Location> {
  return apiFetch<Location>(`${BASE}/${id}`, { method: "PATCH", body: data });
}

export function deleteLocation(id: string): Promise<Location> {
  // Soft delete on the backend; returns the now-archived record.
  return apiFetch<Location>(`${BASE}/${id}`, { method: "DELETE" });
}
