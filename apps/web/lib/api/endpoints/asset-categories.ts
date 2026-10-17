import type {
  AssetCategory,
  AssetCategoryDeleteImpact,
  CreateAssetCategory,
  DeleteResolution,
  UpdateAssetCategory,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { deleteResolutionQuery } from "../delete-resolution";

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

export function getAssetCategoryDeleteImpact(id: string): Promise<AssetCategoryDeleteImpact> {
  return apiFetch<AssetCategoryDeleteImpact>(`/asset-categories/${id}/delete-impact`);
}

/** Soft-delete an asset category; while models are still filed under it, `resolution` says where they go. */
export function deleteAssetCategory(
  id: string,
  resolution?: DeleteResolution,
): Promise<AssetCategory> {
  return apiFetch<AssetCategory>(`/asset-categories/${id}${deleteResolutionQuery(resolution)}`, {
    method: "DELETE",
  });
}
