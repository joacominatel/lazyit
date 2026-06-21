import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getArticleVersion,
  getArticleVersions,
} from "../endpoints/article-versions";

/**
 * Query keys for the ArticleVersion append-only log (ADR-0042).
 * Versions are immutable — nothing invalidates them after write. The `list` key includes the
 * `articleId` so each article's history is cached independently.
 */
export const articleVersionKeys = {
  all: ["article-versions"] as const,
  list: (articleId: string) =>
    [...articleVersionKeys.all, articleId, "list"] as const,
  detail: (articleId: string, version: number) =>
    [...articleVersionKeys.all, articleId, "version", version] as const,
};

/**
 * Fetch the paginated version history of one article (newest first). Requires `article:read`.
 * Idle until `articleId` is provided. `keepPreviousData` prevents a skeleton flash while
 * page params change (ADR-0030).
 */
export function useArticleVersions(
  articleId: string | undefined,
  params: { limit?: number; offset?: number } = {},
) {
  return useQuery({
    queryKey: [...articleVersionKeys.list(articleId ?? ""), params],
    queryFn: () => getArticleVersions(articleId as string, params),
    enabled: Boolean(articleId),
    placeholderData: keepPreviousData,
  });
}

/**
 * Fetch a single version of an article by its monotonic version number. Requires `article:read`.
 * Idle until both `articleId` and `version` are provided.
 */
export function useArticleVersion(
  articleId: string | undefined,
  version: number | undefined,
) {
  return useQuery({
    queryKey: articleVersionKeys.detail(articleId ?? "", version ?? 0),
    queryFn: () => getArticleVersion(articleId as string, version as number),
    enabled: Boolean(articleId) && version !== undefined && version > 0,
  });
}
