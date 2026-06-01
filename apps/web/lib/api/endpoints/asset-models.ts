import type {
  AssetModel,
  CreateAssetModel,
  UpdateAssetModel,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Asset models. The list read backs the asset form's model select; `create` also
 * powers the inline "+ New model" flow. `update`/`remove` back the Settings → Taxonomies management
 * screen (ADMIN-only in the UI; the API gates writes). Routes mirror apps/api/src/asset-models.
 */
export function getAssetModels(): Promise<AssetModel[]> {
  return apiFetch<AssetModel[]>("/asset-models");
}

/** Create an asset model (inline "+ New model" from the asset form, and Settings). */
export function createAssetModel(data: CreateAssetModel): Promise<AssetModel> {
  return apiFetch<AssetModel>("/asset-models", { method: "POST", body: data });
}

export function updateAssetModel(
  id: string,
  data: UpdateAssetModel,
): Promise<AssetModel> {
  return apiFetch<AssetModel>(`/asset-models/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an asset model (returns the now-archived record). */
export function deleteAssetModel(id: string): Promise<AssetModel> {
  return apiFetch<AssetModel>(`/asset-models/${id}`, { method: "DELETE" });
}
