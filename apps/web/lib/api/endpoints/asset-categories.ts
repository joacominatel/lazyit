import type {
  AssetCategory,
  CreateAssetCategory,
  UpdateAssetCategory,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Asset categories. The list read powers the asset list's category filter; the
 * write functions back the Settings → Taxonomies management screen (ADMIN-only in the UI; the API
 * gates writes server-side). Routes mirror apps/api/src/asset-categories.
 */
export function getAssetCategories(): Promise<AssetCategory[]> {
  return apiFetch<AssetCategory[]>("/asset-categories");
}

export function createAssetCategory(
  data: CreateAssetCategory,
): Promise<AssetCategory> {
  return apiFetch<AssetCategory>("/asset-categories", {
    method: "POST",
    body: data,
  });
}

export function updateAssetCategory(
  id: string,
  data: UpdateAssetCategory,
): Promise<AssetCategory> {
  return apiFetch<AssetCategory>(`/asset-categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an asset category (returns the now-archived record). */
export function deleteAssetCategory(id: string): Promise<AssetCategory> {
  return apiFetch<AssetCategory>(`/asset-categories/${id}`, {
    method: "DELETE",
  });
}
