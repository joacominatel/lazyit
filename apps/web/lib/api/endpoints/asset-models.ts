import type { AssetModel, CreateAssetModel } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Asset models (the asset form's model select). Full model management is out of
 * scope; the one write is the inline "+ New model" create from the asset form.
 */
export function getAssetModels(): Promise<AssetModel[]> {
  return apiFetch<AssetModel[]>("/asset-models");
}

/** Create an asset model (inline "+ New model" from the asset form). */
export function createAssetModel(data: CreateAssetModel): Promise<AssetModel> {
  return apiFetch<AssetModel>("/asset-models", { method: "POST", body: data });
}
