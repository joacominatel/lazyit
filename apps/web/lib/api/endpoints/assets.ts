import type {
  Asset,
  AssetAssignmentWithUser,
  AssetStatus,
  AssetWithRelations,
  CreateAsset,
  UpdateAsset,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for the Asset resource. Writes use the raw `Asset` shape (CRUD via
 * `createCrudEndpoints`); reads return the **expanded** `AssetWithRelations`
 * (model + nested category, location, and active owners with their user inline),
 * so the list/detail render without client-side joins. The nested assignments
 * route also inlines `user`. See `@lazyit/shared` `asset-expanded.ts`.
 */

const BASE = "/assets";

// Writes return the raw asset row; reads (get/list) are expanded — see below.
const crud = createCrudEndpoints<Asset, CreateAsset, UpdateAsset>(BASE);
export const createAsset = crud.create;
export const updateAsset = crud.update;
export const deleteAsset = crud.remove;

/** Server-side filters for the asset list. `q` matches name / serial / assetTag. */
export interface AssetFilters {
  q?: string;
  categoryId?: string;
  locationId?: string;
  status?: AssetStatus;
}

/** List non-deleted assets (expanded), optionally filtered. */
export function getAssets(
  filters: AssetFilters = {},
): Promise<AssetWithRelations[]> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.locationId) params.set("locationId", filters.locationId);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  return apiFetch<AssetWithRelations[]>(qs ? `${BASE}?${qs}` : BASE);
}

/** A single expanded asset by id. */
export function getAsset(id: string): Promise<AssetWithRelations> {
  return apiFetch<AssetWithRelations>(`${BASE}/${id}`);
}

/**
 * An asset's ownership assignments, each with its `user` inline. `activeOnly`
 * defaults to true; pass `false` to include released ones (the full history).
 */
export function getAssetAssignments(
  assetId: string,
  activeOnly = true,
): Promise<AssetAssignmentWithUser[]> {
  return apiFetch<AssetAssignmentWithUser[]>(
    `${BASE}/${assetId}/assignments?activeOnly=${activeOnly}`,
  );
}
