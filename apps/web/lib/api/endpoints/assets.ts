import type {
  Asset,
  AssetAssignmentWithUser,
  AssetListPage,
  AssetStatus,
  AssetWithRelations,
  BatchAssetStatus,
  BatchIds,
  BatchResult,
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
 *
 * `deleted: "only"` is the ADMIN-only archived view: the API returns ONLY soft-deleted rows (same
 * `Page<T>` envelope). Omit it for the default active-only list.
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
  deleted?: "only";
}

/**
 * List assets (lean), optionally filtered, sorted and paged. `GET /assets`
 * returns a paginated `Page<AssetListItem>` envelope (ADR-0030); we return the
 * whole envelope (`items` + `total`/`limit`/`offset`) so the list can render
 * pagination controls. `limit`/`offset` are echoed by the server. By default only active rows are
 * returned; pass `deleted: "only"` (ADMIN) for the archived view of soft-deleted rows.
 */
export function getAssets(
  filters: AssetFilters = {},
  signal?: AbortSignal,
): Promise<AssetListPage> {
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
  if (filters.deleted) params.set("deleted", filters.deleted);
  const qs = params.toString();
  return apiFetch<AssetListPage>(qs ? `${BASE}?${qs}` : BASE, { signal });
}

/** A single expanded asset by id. */
export function getAsset(id: string): Promise<AssetWithRelations> {
  return apiFetch<AssetWithRelations>(`${BASE}/${id}`);
}

/**
 * Restore one soft-deleted asset (`POST /assets/:id/restore`, ADMIN). The API clears `deletedAt` and
 * emits a RESTORED history event; returns the restored row.
 */
export function restoreAsset(id: string): Promise<Asset> {
  return apiFetch<Asset>(`${BASE}/${id}/restore`, { method: "POST" });
}

/**
 * Batch (bulk) asset actions — ADMIN only, each runs in one transaction with PER-ENTITY history and
 * returns a {@link BatchResult} (`{ requested, succeeded, skipped }`) so a partial outcome can be
 * surfaced (#104, ADR-0030 amendment). `ids` is bounded by `MAX_BATCH_IDS`.
 */
export function batchDeleteAssets(ids: BatchIds["ids"]): Promise<BatchResult> {
  return apiFetch<BatchResult>(`${BASE}/batch/delete`, {
    method: "POST",
    body: { ids },
  });
}

/** Bulk restore soft-deleted assets (one RESTORED history event per item). */
export function batchRestoreAssets(ids: BatchIds["ids"]): Promise<BatchResult> {
  return apiFetch<BatchResult>(`${BASE}/batch/restore`, {
    method: "POST",
    body: { ids },
  });
}

/** Bulk set the status of many assets (one CHANGED history event per item). */
export function batchSetAssetStatus(
  ids: BatchAssetStatus["ids"],
  status: BatchAssetStatus["status"],
): Promise<BatchResult> {
  return apiFetch<BatchResult>(`${BASE}/batch/status`, {
    method: "POST",
    body: { ids, status },
  });
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
