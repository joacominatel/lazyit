import type { AssetModel } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Asset models (for the asset form's model select). Full model
 * management is out of scope for now — handled via API/seed.
 */
export function getAssetModels(): Promise<AssetModel[]> {
  return apiFetch<AssetModel[]>("/asset-models");
}
