import type {
  ApplicationCategory,
  ApplicationCategoryDeleteImpact,
  CreateApplicationCategory,
  UpdateApplicationCategory,
  DeleteResolution,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { deleteResolutionQuery } from "../delete-resolution";

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

export function getApplicationCategoryDeleteImpact(
  id: string,
): Promise<ApplicationCategoryDeleteImpact> {
  return apiFetch<ApplicationCategoryDeleteImpact>(`/application-categories/${id}/delete-impact`);
}

/** Soft-delete a category; while items are still filed under it, `resolution` says where they go. */
export function deleteApplicationCategory(
  id: string,
  resolution?: DeleteResolution,
): Promise<ApplicationCategory> {
  return apiFetch<ApplicationCategory>(`/application-categories/${id}${deleteResolutionQuery(resolution)}`, {
    method: "DELETE",
  });
}
