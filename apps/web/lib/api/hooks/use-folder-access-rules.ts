import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FolderAccessRules } from "@lazyit/shared";
import { setFolderAccessRules } from "../endpoints/folder-access-rules";
import { articleCategoryKeys } from "./use-article-categories";

/**
 * Set or clear the access rules for a folder (PUT /article-categories/:id/access-rules).
 * ADMIN-only (the backend gates it on `settings:manage`). On success the article-categories
 * query is invalidated so every consumer (the tree, the form select, the filters) sees the
 * updated row — including the new `accessRules` value that drives the padlock affordance.
 */
export function useSetFolderAccessRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      accessRules,
    }: {
      id: string;
      accessRules: FolderAccessRules;
    }) => setFolderAccessRules(id, accessRules),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: articleCategoryKeys.all }),
  });
}
