import type { ArticleCategory, FolderAccessRules } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Set or clear the access rules for a folder (PUT /article-categories/:id/access-rules).
 * ADMIN-only on the backend (`settings:manage`). `accessRules: null` makes the folder PUBLIC
 * again; a non-empty list replaces the current restriction (OR-combined, ADR-0060 §3).
 * Returns the updated folder row (the API returns the full `ArticleCategory` entity).
 */
export function setFolderAccessRules(
  id: string,
  accessRules: FolderAccessRules,
): Promise<ArticleCategory> {
  return apiFetch<ArticleCategory>(`/article-categories/${id}/access-rules`, {
    method: "PUT",
    body: { accessRules },
  });
}
