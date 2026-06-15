import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ArticleFilters,
  getArticle,
  getArticleBySlug,
  getArticleImportStatus,
  getArticles,
} from "../endpoints/articles";

/** Poll cadence for an in-flight import job (ADR-0053). md/txt finish near-instantly. */
const IMPORT_POLL_INTERVAL_MS = 1500;

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
  importStatus: (jobId: string) =>
    [...articleKeys.all, "import", jobId] as const,
};

/**
 * List articles visible to the acting user, with optional server-side filters and
 * paging (`limit`/`offset`). Returns the `Page<ArticleListItem>` envelope (`items`
 * + `total`/`limit`/`offset`) so the list can render pagination controls.
 * `keepPreviousData` keeps the current page on screen while a new filter/page query
 * resolves, so typing in the filter bar or paging doesn't flash the skeleton.
 */
export function useArticles(filters: ArticleFilters = {}) {
  return useQuery({
    queryKey: articleKeys.list(filters),
    queryFn: ({ signal }) => getArticles(filters, signal),
    placeholderData: keepPreviousData,
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

/**
 * Poll an async import job (ADR-0053). Idle until a `jobId` is provided; refetches every
 * {@link IMPORT_POLL_INTERVAL_MS} while the job is `queued`/`active` and stops once it reaches a
 * terminal state (`completed`/`failed`). `keepPreviousData` avoids a flash while each poll resolves.
 * The caller reacts to the terminal state (navigate on completed, toast on failed).
 */
export function useArticleImportStatus(jobId: string | undefined) {
  return useQuery({
    queryKey: articleKeys.importStatus(jobId ?? ""),
    queryFn: ({ signal }) => getArticleImportStatus(jobId as string, signal),
    enabled: Boolean(jobId),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed"
        ? false
        : IMPORT_POLL_INTERVAL_MS;
    },
  });
}
