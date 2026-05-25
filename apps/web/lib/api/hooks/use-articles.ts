import { useQuery } from "@tanstack/react-query";
import {
  type ArticleFilters,
  getArticle,
  getArticleBySlug,
  getArticles,
} from "../endpoints/articles";

/**
 * Query keys for the Article resource. Hand-written (not `createQueryKeys`)
 * because the KB needs bespoke shapes — a *filtered* list and a by-slug lookup —
 * that the generic factory doesn't cover (ADR-0020). Mutations invalidate `all`,
 * the common prefix, so lists, details and slug lookups all refetch.
 */
export const articleKeys = {
  all: ["articles"] as const,
  lists: () => [...articleKeys.all, "list"] as const,
  list: (filters: ArticleFilters) =>
    [...articleKeys.all, "list", filters] as const,
  detail: (id: string) => [...articleKeys.all, "detail", id] as const,
  bySlug: (slug: string) => [...articleKeys.all, "by-slug", slug] as const,
};

/** List articles visible to the acting user, with optional server-side filters. */
export function useArticles(filters: ArticleFilters = {}) {
  return useQuery({
    queryKey: articleKeys.list(filters),
    queryFn: () => getArticles(filters),
  });
}

/** Fetch one article by slug (detail view); idle until a slug is provided. */
export function useArticleBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: articleKeys.bySlug(slug ?? ""),
    queryFn: () => getArticleBySlug(slug as string),
    enabled: Boolean(slug),
  });
}

/** Fetch one article by id (e.g. the edit page); idle until an id is provided. */
export function useArticle(id: string | undefined) {
  return useQuery({
    queryKey: articleKeys.detail(id ?? ""),
    queryFn: () => getArticle(id as string),
    enabled: Boolean(id),
  });
}
