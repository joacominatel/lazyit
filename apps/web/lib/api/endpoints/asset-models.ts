import type {
  AssetModel,
  AssetModelListPage,
  CreateAssetModel,
  UpdateAssetModel,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Asset models. The list read backs the asset form's model select + the
 * Settings → Taxonomies table (via the flat `useAssetModels` hook) AND the searchable picker (via
 * the paged `useAssetModelList` hook); `create` also powers the inline "+ New model" flow.
 * `update`/`remove` back the Settings management screen (ADMIN-only in the UI; the API gates writes).
 * Routes mirror apps/api/src/asset-models.
 */

const BASE = "/asset-models";

/**
 * Server-side params for the asset-model list (issue #199). `q` matches name/manufacturer/sku;
 * `categoryId` scopes to one category; `sort` is allowlisted to
 * `name|manufacturer|sku|createdAt|updatedAt` (unknown → 400). `limit`/`offset` thread the
 * pagination window (ADR-0030). `deleted: "only"` is the ADMIN-only archived view.
 */
export interface AssetModelListParams {
  q?: string;
  categoryId?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
}

/**
 * List asset models, paged. `GET /asset-models` returns a `Page<AssetModel>` envelope (migrated off
 * the raw array — issue #199); we return the whole envelope so a caller can page or read `items` for
 * the flat consumers. Only server-supported params are forwarded.
 */
export function getAssetModels(
  params: AssetModelListParams = {},
): Promise<AssetModelListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.categoryId) qs.set("categoryId", params.categoryId);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  const search = qs.toString();
  return apiFetch<AssetModelListPage>(search ? `${BASE}?${search}` : BASE);
}

/** Fetch a single asset model by id — resolves the picker's selected-model label on edit. */
export function getAssetModel(id: string): Promise<AssetModel> {
  return apiFetch<AssetModel>(`${BASE}/${id}`);
}

/** Create an asset model (inline "+ New model" from the asset form, and Settings). */
export function createAssetModel(data: CreateAssetModel): Promise<AssetModel> {
  return apiFetch<AssetModel>(BASE, { method: "POST", body: data });
}

export function updateAssetModel(
  id: string,
  data: UpdateAssetModel,
): Promise<AssetModel> {
  return apiFetch<AssetModel>(`${BASE}/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an asset model (returns the now-archived record). */
export function deleteAssetModel(id: string): Promise<AssetModel> {
  return apiFetch<AssetModel>(`${BASE}/${id}`, { method: "DELETE" });
}
