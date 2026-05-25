import { useQuery } from "@tanstack/react-query";
import { getArticleCategories } from "../endpoints/article-categories";

/** Query keys for Article categories (read-only in the current scope). */
export const articleCategoryKeys = {
  all: ["article-categories"] as const,
  lists: () => [...articleCategoryKeys.all, "list"] as const,
};

/** List all article categories (for KB filters and the article form select). */
export function useArticleCategories() {
  return useQuery({
    queryKey: articleCategoryKeys.lists(),
    queryFn: getArticleCategories,
  });
}
