import type { AssetCategory } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Asset categories (for the asset list's category filter). Full
 * category management is out of scope for now — handled via API/seed.
 */
export function getAssetCategories(): Promise<AssetCategory[]> {
  return apiFetch<AssetCategory[]>("/asset-categories");
}
