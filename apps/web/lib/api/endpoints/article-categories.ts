import type { ArticleCategory } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Article categories. The KB screens only need the list (for
 * filters and the article form's category select); full category management is
 * out of scope for now (handled via API/seed) — see the Phase task notes.
 */
export function getArticleCategories(): Promise<ArticleCategory[]> {
  return apiFetch<ArticleCategory[]>("/article-categories");
}
