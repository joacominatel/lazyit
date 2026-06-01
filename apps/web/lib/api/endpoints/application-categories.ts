import type {
  ApplicationCategory,
  CreateApplicationCategory,
  UpdateApplicationCategory,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Application categories. The list read powers the Access list filter and the
 * application form's category select; the write functions back the Settings → Taxonomies
 * management screen (ADMIN-only in the UI; the API gates writes). Routes mirror
 * apps/api/src/application-categories.
 */
export function getApplicationCategories(): Promise<ApplicationCategory[]> {
  return apiFetch<ApplicationCategory[]>("/application-categories");
}

export function createApplicationCategory(
  data: CreateApplicationCategory,
): Promise<ApplicationCategory> {
  return apiFetch<ApplicationCategory>("/application-categories", {
    method: "POST",
    body: data,
  });
}

export function updateApplicationCategory(
  id: string,
  data: UpdateApplicationCategory,
): Promise<ApplicationCategory> {
  return apiFetch<ApplicationCategory>(`/application-categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an application category (returns the now-archived record). */
export function deleteApplicationCategory(
  id: string,
): Promise<ApplicationCategory> {
  return apiFetch<ApplicationCategory>(`/application-categories/${id}`, {
    method: "DELETE",
  });
}
