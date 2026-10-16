import type {
  ConsumableCategory,
  ConsumableCategoryDeleteImpact,
  CreateConsumableCategory,
  UpdateConsumableCategory,
  DeleteResolution,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { deleteResolutionQuery } from "../delete-resolution";

/**
 * Data-access for Consumable categories. The list read powers the Consumables list filter and the
 * consumable form's category select; the write functions back the Settings → Taxonomies management
 * screen (ADMIN-only in the UI; the API gates writes). Routes mirror
 * apps/api/src/consumable-categories.
 */
export function getConsumableCategories(): Promise<ConsumableCategory[]> {
  return apiFetch<ConsumableCategory[]>("/consumable-categories");
}

export function createConsumableCategory(
  data: CreateConsumableCategory,
): Promise<ConsumableCategory> {
  return apiFetch<ConsumableCategory>("/consumable-categories", {
    method: "POST",
    body: data,
  });
}

export function updateConsumableCategory(
  id: string,
  data: UpdateConsumableCategory,
): Promise<ConsumableCategory> {
  return apiFetch<ConsumableCategory>(`/consumable-categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

export function getConsumableCategoryDeleteImpact(
  id: string,
): Promise<ConsumableCategoryDeleteImpact> {
  return apiFetch<ConsumableCategoryDeleteImpact>(`/consumable-categories/${id}/delete-impact`);
}

/** Soft-delete a category; while items are still filed under it, `resolution` says where they go. */
export function deleteConsumableCategory(
  id: string,
  resolution?: DeleteResolution,
): Promise<ConsumableCategory> {
  return apiFetch<ConsumableCategory>(`/consumable-categories/${id}${deleteResolutionQuery(resolution)}`, {
    method: "DELETE",
  });
}
