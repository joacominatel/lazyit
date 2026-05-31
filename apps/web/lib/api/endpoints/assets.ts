import type {
  Asset,
  AssetAssignmentWithUser,
  AssetListItem,
  AssetListPage,
  AssetStatus,
  AssetWithRelations,
  CreateAsset,
  UpdateAsset,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for the Asset resource. Writes use the raw `Asset` shape (CRUD via
 * `createCrudEndpoints`); the detail read returns the **expanded**
 * `AssetWithRelations` (model + nested category, location, and active owners with
 * their user inline). The list read is **lean and paginated** (ADR-0030): the API
 * returns a `Page<AssetListItem>` envelope (`specs` omitted; relations trimmed to
 * label fields) and `getAssets` unwraps `.items` so callers keep an array. The
 * nested assignments route still inlines the full `user`. See `@lazyit/shared`
 * `asset-expanded.ts` / `asset-list.ts`.
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

/**
 * List non-deleted assets (lean), optionally filtered. `GET /assets` returns a
 * paginated `Page<AssetListItem>` envelope (ADR-0030); we unwrap `.items` so the
 * table keeps consuming an array. The default page size (50) applies — the UI
 * does not yet page, so for now only the first page is shown.
 */
export async function getAssets(
  filters: AssetFilters = {},
): Promise<AssetListItem[]> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.locationId) params.set("locationId", filters.locationId);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  const page = await apiFetch<AssetListPage>(qs ? `${BASE}?${qs}` : BASE);
  return page.items;
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
