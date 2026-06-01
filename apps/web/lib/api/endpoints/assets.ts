import type {
  Asset,
  AssetAssignmentWithUser,
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
 * label fields) and `getAssets` returns the whole envelope so the table can render
 * pagination controls (`total`/`limit`/`offset`). The nested assignments route
 * still inlines the full `user`. See `@lazyit/shared` `asset-expanded.ts` /
 * `asset-list.ts`.
 */

const BASE = "/assets";

// Writes return the raw asset row; reads (get/list) are expanded — see below.
const crud = createCrudEndpoints<Asset, CreateAsset, UpdateAsset>(BASE);
export const createAsset = crud.create;
export const updateAsset = crud.update;
export const deleteAsset = crud.remove;

/**
 * Server-side filters for the asset list. `q` matches name / serial / assetTag;
 * `status`/`categoryId`/`locationId` scope the result set. `sort` is allowlisted to
 * `name|assetTag|serial|status|createdAt|updatedAt` (unknown → 400). The ownership filter is NOT a
 * server param — the screen applies it client-side over the page. `limit`/`offset` thread the
 * pagination window (ADR-0030); omit for the defaults (page size 50, offset 0).
 */
export interface AssetFilters {
  q?: string;
  categoryId?: string;
  locationId?: string;
  status?: AssetStatus;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * List non-deleted assets (lean), optionally filtered, sorted and paged. `GET /assets`
 * returns a paginated `Page<AssetListItem>` envelope (ADR-0030); we return the
 * whole envelope (`items` + `total`/`limit`/`offset`) so the list can render
 * pagination controls. `limit`/`offset` are echoed by the server.
 */
export function getAssets(filters: AssetFilters = {}): Promise<AssetListPage> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.locationId) params.set("locationId", filters.locationId);
  if (filters.status) params.set("status", filters.status);
  if (filters.sort) {
    params.set("sort", filters.sort);
    if (filters.dir) params.set("dir", filters.dir);
  }
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<AssetListPage>(qs ? `${BASE}?${qs}` : BASE);
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
