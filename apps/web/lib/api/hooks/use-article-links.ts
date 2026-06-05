import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreateArticleLink } from "@lazyit/shared";
import {
  createArticleLink,
  deleteArticleLink,
  getApplicationArticles,
  getArticleLinks,
  getAssetArticles,
  type ReverseArticleFilters,
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
  /**
   * Reverse: published articles linked to an asset. The filter/page dimension (#220) is part of the
   * key so each distinct search/filter/page is cached independently and refetches correctly.
   */
  forAsset: (assetId: string, filters: ReverseArticleFilters = {}) =>
    [...articleLinkKeys.all, "asset", assetId, filters] as const,
  /** Reverse: published articles linked to an application (filter/page-aware key, #220). */
  forApplication: (
    applicationId: string,
    filters: ReverseArticleFilters = {},
  ) =>
    [...articleLinkKeys.all, "application", applicationId, filters] as const,
};

/** One article's links (forward direction); idle until an id is provided. */
export function useArticleLinks(articleId: string | undefined) {
  return useQuery({
    queryKey: articleLinkKeys.forArticle(articleId ?? ""),
    queryFn: () => getArticleLinks(articleId as string),
    enabled: Boolean(articleId),
  });
}

/**
 * A page of the PUBLISHED articles linked to an asset (reverse direction); idle until an id is
 * provided. Accepts the #220 `q`/`status`/`categoryId` + page filters; `keepPreviousData` keeps the
 * current page visible (no flash to the loading state) while the next search/filter/page resolves.
 */
export function useAssetArticles(
  assetId: string | undefined,
  filters: ReverseArticleFilters = {},
) {
  return useQuery({
    queryKey: articleLinkKeys.forAsset(assetId ?? "", filters),
    queryFn: () => getAssetArticles(assetId as string, filters),
    enabled: Boolean(assetId),
    placeholderData: keepPreviousData,
  });
}

/**
 * A page of the PUBLISHED articles linked to an application (reverse direction); idle until an id is
 * provided. Same #220 filter/page contract + `keepPreviousData` as {@link useAssetArticles}.
 */
export function useApplicationArticles(
  applicationId: string | undefined,
  filters: ReverseArticleFilters = {},
) {
  return useQuery({
    queryKey: articleLinkKeys.forApplication(applicationId ?? "", filters),
    queryFn: () => getApplicationArticles(applicationId as string, filters),
    enabled: Boolean(applicationId),
    placeholderData: keepPreviousData,
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
