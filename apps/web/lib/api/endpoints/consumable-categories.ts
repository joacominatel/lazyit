import type {
  ConsumableCategory,
  CreateConsumableCategory,
  UpdateConsumableCategory,
} from "@lazyit/shared";
import { apiFetch } from "../client";

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

/** Soft-delete a consumable category (returns the now-archived record). */
export function deleteConsumableCategory(
  id: string,
): Promise<ConsumableCategory> {
  return apiFetch<ConsumableCategory>(`/consumable-categories/${id}`, {
    method: "DELETE",
  });
}
