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

/**
 * Per-status totals for a list scope (#1539) — the counts on the status segmented control, the rail's
 * views and the home stats line. Two `limit: 1` reads (one per status) whose `total` is the count; the
 * scope (`base`) is everything the list filters on except status and paging. With an empty scope the
 * two keys are the same ones the rail uses, so the home page and the rail share one cache entry each.
 * `all` is their sum (the two statuses partition every article the viewer can see); each value is
 * `undefined` until its read resolves, and stays undefined on an error so the UI just hides it.
 */
export function useArticleStatusCounts(
  base: Omit<ArticleFilters, "status" | "limit" | "offset"> = {},
  enabled = true,
) {
  const published = useQuery({
    queryKey: articleKeys.list({ ...base, status: ["PUBLISHED"], limit: 1 }),
    queryFn: ({ signal }) =>
      getArticles({ ...base, status: ["PUBLISHED"], limit: 1 }, signal),
    enabled,
  });
  const drafts = useQuery({
    queryKey: articleKeys.list({ ...base, status: ["DRAFT"], limit: 1 }),
    queryFn: ({ signal }) =>
      getArticles({ ...base, status: ["DRAFT"], limit: 1 }, signal),
    enabled,
  });
  const publishedTotal = published.data?.total;
  const draftsTotal = drafts.data?.total;
  return {
    published: publishedTotal,
    drafts: draftsTotal,
    all:
      publishedTotal !== undefined && draftsTotal !== undefined
        ? publishedTotal + draftsTotal
        : undefined,
  };
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
