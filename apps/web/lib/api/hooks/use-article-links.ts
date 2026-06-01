import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateArticleLink } from "@lazyit/shared";
import {
  createArticleLink,
  deleteArticleLink,
  getApplicationArticles,
  getArticleLinks,
  getAssetArticles,
} from "../endpoints/article-links";

/**
 * Query/mutation hooks for the ArticleLink relation (ADR-0042). Kept in this NEW file (alongside
 * `endpoints/article-links.ts`) so the runbook/cross-link feature owns its own data-access without
 * touching the article/asset/application hook files other surfaces own.
 *
 * Two read shapes:
 * - the **forward** links of one article (`useArticleLinks`) — drives the KB "Linked to" panel;
 * - the **reverse** published articles of one asset/application (`useAssetArticles`,
 *   `useApplicationArticles`) — drives the "Related articles / Runbooks" panels (#104).
 *
 * Mutations invalidate `articleLinkKeys.all` (so every link/reverse read refetches). Toasts, dialog
 * state and navigation stay with the calling component.
 */
export const articleLinkKeys = {
  all: ["article-links"] as const,
  /** Forward: one article's own links. */
  forArticle: (articleId: string) =>
    [...articleLinkKeys.all, "article", articleId] as const,
  /** Reverse: published articles linked to an asset. */
  forAsset: (assetId: string) =>
    [...articleLinkKeys.all, "asset", assetId] as const,
  /** Reverse: published articles linked to an application. */
  forApplication: (applicationId: string) =>
    [...articleLinkKeys.all, "application", applicationId] as const,
};

/** One article's links (forward direction); idle until an id is provided. */
export function useArticleLinks(articleId: string | undefined) {
  return useQuery({
    queryKey: articleLinkKeys.forArticle(articleId ?? ""),
    queryFn: () => getArticleLinks(articleId as string),
    enabled: Boolean(articleId),
  });
}

/** Published articles linked to an asset (reverse direction); idle until an id is provided. */
export function useAssetArticles(assetId: string | undefined) {
  return useQuery({
    queryKey: articleLinkKeys.forAsset(assetId ?? ""),
    queryFn: () => getAssetArticles(assetId as string),
    enabled: Boolean(assetId),
  });
}

/** Published articles linked to an application (reverse direction); idle until an id is provided. */
export function useApplicationArticles(applicationId: string | undefined) {
  return useQuery({
    queryKey: articleLinkKeys.forApplication(applicationId ?? ""),
    queryFn: () => getApplicationArticles(applicationId as string),
    enabled: Boolean(applicationId),
  });
}

function useInvalidateArticleLinks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: articleLinkKeys.all });
}

/** Link an article to an asset XOR application (author only). Invalidates all link reads. */
export function useCreateArticleLink() {
  const invalidate = useInvalidateArticleLinks();
  return useMutation({
    mutationFn: ({
      articleId,
      data,
    }: {
      articleId: string;
      data: CreateArticleLink;
    }) => createArticleLink(articleId, data),
    onSuccess: invalidate,
  });
}

/** Remove a link from an article (author only). Invalidates all link reads. */
export function useDeleteArticleLink() {
  const invalidate = useInvalidateArticleLinks();
  return useMutation({
    mutationFn: ({
      articleId,
      linkId,
    }: {
      articleId: string;
      linkId: string;
    }) => deleteArticleLink(articleId, linkId),
    onSuccess: invalidate,
  });
}
