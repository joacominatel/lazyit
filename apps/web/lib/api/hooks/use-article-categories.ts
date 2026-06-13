import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateArticleCategory,
  UpdateArticleCategory,
} from "@lazyit/shared";
import {
  createArticleCategory,
  deleteArticleCategory,
  deleteArticleCategoryCascade,
  getArticleCategories,
  updateArticleCategory,
} from "../endpoints/article-categories";
import { articleKeys } from "./use-articles";

/** Query keys for Article categories. */
export const articleCategoryKeys = {
  all: ["article-categories"] as const,
  lists: () => [...articleCategoryKeys.all, "list"] as const,
};

/** List all article categories (KB filters + form select + Settings → Taxonomies table). */
export function useArticleCategories() {
  return useQuery({
    queryKey: articleCategoryKeys.lists(),
    queryFn: getArticleCategories,
  });
}

/** Create an article category; invalidates the list. */
export function useCreateArticleCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateArticleCategory) => createArticleCategory(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: articleCategoryKeys.all }),
  });
}

/** Update an article category; invalidates the list. */
export function useUpdateArticleCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateArticleCategory }) =>
      updateArticleCategory(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: articleCategoryKeys.all }),
  });
}

/** Soft-delete an article category; invalidates the list (API returns 409 if it still has articles). */
export function useDeleteArticleCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteArticleCategory(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: articleCategoryKeys.all }),
  });
}

/**
 * Cascade soft-delete a folder + all its descendant folders and their articles (#415). Invalidates
 * BOTH the folder list (tree/filters refresh) and the article lists (a deleted folder's articles
 * must drop out of the grid). Returns the `{ deletedFolders, deletedArticles }` counts.
 */
export function useDeleteArticleCategoryCascade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteArticleCategoryCascade(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: articleCategoryKeys.all });
      queryClient.invalidateQueries({ queryKey: articleKeys.all });
    },
  });
}
