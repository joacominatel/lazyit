import type {
  Asset,
  AssetAssignment,
  AssetStatus,
  CreateAsset,
  UpdateAsset,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for the Asset resource. CRUD bodies come from `createCrudEndpoints`;
 * the list (server-side filters) and the nested assignments route are bespoke.
 *
 * NOTE (interim): the API currently returns raw asset rows (FK ids, no inline
 * relations). An expanded read (`AssetWithRelations` — model/category/location/
 * owners inline) is being added on the backend; when it lands, the list/detail
 * return types widen to it and the screens drop the client-side joins. The
 * function shapes here stay the same. See the assets-expanded request.
 */

const BASE = "/assets";

const crud = createCrudEndpoints<Asset, CreateAsset, UpdateAsset>(BASE);
export const getAsset = crud.get;
export const createAsset = crud.create;
export const updateAsset = crud.update;
export const deleteAsset = crud.remove;

/** Server-side filters for the asset list (search is client-side for now). */
export interface AssetFilters {
  categoryId?: string;
  locationId?: string;
  status?: AssetStatus;
}

/** List non-deleted assets, optionally filtered by category / location / status. */
export function getAssets(filters: AssetFilters = {}): Promise<Asset[]> {
  const params = new URLSearchParams();
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.locationId) params.set("locationId", filters.locationId);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  return apiFetch<Asset[]>(qs ? `${BASE}?${qs}` : BASE);
}

/**
 * List an asset's ownership assignments. `activeOnly` defaults to true on the
 * API; pass `false` to include released ones (the full history).
 */
export function getAssetAssignments(
  assetId: string,
  activeOnly = true,
): Promise<AssetAssignment[]> {
  return apiFetch<AssetAssignment[]>(
    `${BASE}/${assetId}/assignments?activeOnly=${activeOnly}`,
  );
}
