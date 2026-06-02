import type {
  ArticleCategory,
  CreateArticleCategory,
  UpdateArticleCategory,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Article categories. The list read powers KB filters and the article form's
 * category select; the write functions back the Settings → Taxonomies management screen (ADMIN-only
 * in the UI; the API gates writes and returns 409 on a delete that still has live articles). Routes
 * mirror apps/api/src/article-categories.
 */
export function getArticleCategories(): Promise<ArticleCategory[]> {
  return apiFetch<ArticleCategory[]>("/article-categories");
}

export function createArticleCategory(
  data: CreateArticleCategory,
): Promise<ArticleCategory> {
  return apiFetch<ArticleCategory>("/article-categories", {
    method: "POST",
    body: data,
  });
}

export function updateArticleCategory(
  id: string,
  data: UpdateArticleCategory,
): Promise<ArticleCategory> {
  return apiFetch<ArticleCategory>(`/article-categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an article category (returns the now-archived record; 409 if it still has articles). */
export function deleteArticleCategory(id: string): Promise<ArticleCategory> {
  return apiFetch<ArticleCategory>(`/article-categories/${id}`, {
    method: "DELETE",
  });
}
