import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type CategoryKind, createCategory } from "../endpoints/categories";
import { applicationCategoryKeys } from "./use-application-categories";
import { articleCategoryKeys } from "./use-article-categories";
import { assetCategoryKeys } from "./use-asset-categories";
import { consumableCategoryKeys } from "./use-consumable-categories";

/** Each kind's query-key root, so a create invalidates the matching category list. */
const CATEGORY_KEY: Record<CategoryKind, readonly unknown[]> = {
  asset: assetCategoryKeys.all,
  application: applicationCategoryKeys.all,
  consumable: consumableCategoryKeys.all,
  article: articleCategoryKeys.all,
};

/** Create a category of `kind` (the inline "+ New category"); invalidates that kind's list. */
export function useCreateCategory(kind: CategoryKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createCategory(kind, name),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: CATEGORY_KEY[kind] }),
  });
}
