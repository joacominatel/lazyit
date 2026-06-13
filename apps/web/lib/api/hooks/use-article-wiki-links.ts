import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateArticleAlias } from "@lazyit/shared";
import {
  createArticleAlias,
  deleteArticleAlias,
  getArticleAliases,
  getArticleBacklinks,
} from "../endpoints/article-wiki-links";

/**
 * Query/mutation hooks for the KB v2 article↔article primitives (ADR-0059): backlinks ("References",
 * §4) and nav-only folder aliases (§2). Kept in this NEW file (alongside `endpoints/article-wiki-links.ts`)
 * so the wiki-link feature owns its own data-access without touching the article/link hook files.
 *
 * Alias mutations invalidate the alias read for the article (so the affordance refetches). Toasts and
 * dialog state stay with the calling component.
 */
export const articleWikiLinkKeys = {
  all: ["article-wiki-links"] as const,
  /** Incoming wiki-links ("References") of an article. */
  backlinks: (articleId: string) =>
    [...articleWikiLinkKeys.all, "backlinks", articleId] as const,
  /** Nav-only folder aliases of an article. */
  aliases: (articleId: string) =>
    [...articleWikiLinkKeys.all, "aliases", articleId] as const,
};

/** The "References" (incoming wiki-links) of an article; idle until an id is provided. */
export function useArticleBacklinks(articleId: string | undefined) {
  return useQuery({
    queryKey: articleWikiLinkKeys.backlinks(articleId ?? ""),
    queryFn: () => getArticleBacklinks(articleId as string),
    enabled: Boolean(articleId),
  });
}

/** The nav-only folder aliases of an article; idle until an id is provided. */
export function useArticleAliases(articleId: string | undefined) {
  return useQuery({
    queryKey: articleWikiLinkKeys.aliases(articleId ?? ""),
    queryFn: () => getArticleAliases(articleId as string),
    enabled: Boolean(articleId),
  });
}

/** Alias an article into a folder (author only). Invalidates that article's alias read. */
export function useCreateArticleAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      articleId,
      data,
    }: {
      articleId: string;
      data: CreateArticleAlias;
    }) => createArticleAlias(articleId, data),
    onSuccess: (_alias, { articleId }) =>
      queryClient.invalidateQueries({
        queryKey: articleWikiLinkKeys.aliases(articleId),
      }),
  });
}

/** Remove a folder alias from an article (author only). Invalidates that article's alias read. */
export function useDeleteArticleAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      articleId,
      aliasId,
    }: {
      articleId: string;
      aliasId: string;
    }) => deleteArticleAlias(articleId, aliasId),
    onSuccess: (_alias, { articleId }) =>
      queryClient.invalidateQueries({
        queryKey: articleWikiLinkKeys.aliases(articleId),
      }),
  });
}
