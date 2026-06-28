import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateArticle, ImportArticle, UpdateArticle } from "@lazyit/shared";
import {
  createArticle,
  deleteArticle,
  importArticle,
  publishArticle,
  unpublishArticle,
  updateArticle,
} from "../endpoints/articles";
import { restoreArticleVersion } from "../endpoints/article-versions";
import { articleKeys } from "./use-articles";
import { articleVersionKeys } from "./use-article-versions";
import { invalidateDashboard } from "./use-dashboard";

/**
 * Write hooks for the Article resource. Each invalidates `articleKeys.all` on
 * success — the common prefix, so lists, details and slug lookups all refetch —
 * AND the dashboard, whose published/draft article counts derive from the same
 * state (issue #499). Toasts, navigation and dialog state are owned by the calling
 * component.
 *
 * The bespoke transitions (publish / unpublish / import) are exactly why the KB
 * keeps hand-written hooks instead of a generic factory (ADR-0020).
 */

function useInvalidateArticles() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: articleKeys.all });
    invalidateDashboard(queryClient);
  };
}

export function useCreateArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (data: CreateArticle) => createArticle(data),
    onSuccess: invalidate,
  });
}

export function useUpdateArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateArticle }) =>
      updateArticle(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (id: string) => deleteArticle(id),
    onSuccess: invalidate,
  });
}

export function usePublishArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (id: string) => publishArticle(id),
    onSuccess: invalidate,
  });
}

export function useUnpublishArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (id: string) => unpublishArticle(id),
    onSuccess: invalidate,
  });
}

/**
 * Restore an article to a previous version (#848). The API replays the snapshot through the edit
 * path, appending a NEW version — so on success we invalidate the article state (lists/detail/slug
 * + dashboard) AND the version history (a new snapshot now exists). Toast/dialog state is owned by
 * the calling component.
 */
export function useRestoreArticleVersion(articleId: string) {
  const invalidate = useInvalidateArticles();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => restoreArticleVersion(articleId, version),
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: articleVersionKeys.all });
    },
  });
}

/**
 * Enqueue an async import (ADR-0053). The mutation resolves when the job is **accepted** (HTTP 202)
 * — it returns `{ jobId }`, not an Article. The article doesn't exist yet, so there's nothing to
 * invalidate here; the caller polls `useArticleImportStatus(jobId)` and invalidates on completion.
 */
export function useImportArticle() {
  return useMutation({
    mutationFn: ({ file, fields }: { file: File; fields: ImportArticle }) =>
      importArticle(file, fields),
  });
}
