import type {
  ArticleLink,
  ArticleListPage,
  ArticleStatus,
  CreateArticleLink,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the ArticleLink relation (ADR-0042) — the IT-native bridge that ties a KB article
 * to EITHER an Asset OR an Application ("the runbook for THIS server / this app").
 *
 * Two directions live here, intentionally in this NEW file rather than spread across
 * `endpoints/articles.ts` / `assets.ts` / `applications.ts` (those are owned by other surfaces):
 *
 * - **Forward** (article → targets): `GET/POST/DELETE /articles/:id/links` — manage an article's
 *   own links, surfaced on the KB article detail ("Linked to" + inline "+ Link …").
 * - **Reverse** (target → articles): `GET /assets/:id/articles` and `GET /applications/:id/articles`
 *   return the PUBLISHED articles linked to that record. As of #220 these are **paginated +
 *   filterable** (ADR-0030): each returns a `Page<ArticleListItem>` envelope (lean — no body) with an
 *   optional `q`/`status`/`categoryId` filter and a page window, surfaced on the asset / application
 *   detail ("Related articles / Runbooks"). #104 / #220.
 *
 * The acting user (`createdById`) is set by the API from the Bearer token, never the body.
 */

/**
 * Server-side filters + paging for the **reverse** KB lookups (#220), mirroring the `GET /articles`
 * contract. `q` is a case-insensitive substring over title/excerpt; `status` / `categoryId` are
 * **multi-select** (#198) — each value OR-combines within the filter (comma-encoded into its one query
 * param). `limit`/`offset` thread the page window (ADR-0030); omit for the defaults (50 / 0). The
 * list is always PUBLISHED-only server-side (drafts never surface), so a `status` filter only narrows
 * within PUBLISHED.
 */
export interface ReverseArticleFilters {
  q?: string;
  status?: ArticleStatus[];
  categoryId?: string[];
  limit?: number;
  offset?: number;
}

/** Build the shared query string for a reverse KB lookup from {@link ReverseArticleFilters}. */
function reverseArticleQuery(filters: ReverseArticleFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  // Multi-select (#198): comma-encode each non-empty array into its one query param.
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.categoryId?.length)
    params.set("categoryId", filters.categoryId.join(","));
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  return params.toString();
}

/** List an article's links to assets/applications. Readable by any reader of the article. */
export function getArticleLinks(articleId: string): Promise<ArticleLink[]> {
  return apiFetch<ArticleLink[]>(`/articles/${articleId}/links`);
}

/**
 * Link an article to an Asset XOR an Application (author only; exactly one target). The XOR is
 * enforced by `CreateArticleLinkSchema` at the edge and a DB CHECK as the hard guarantee.
 */
export function createArticleLink(
  articleId: string,
  data: CreateArticleLink,
): Promise<ArticleLink> {
  return apiFetch<ArticleLink>(`/articles/${articleId}/links`, {
    method: "POST",
    body: data,
  });
}

/** Remove a link from an article (author only). Hard delete — a link is current-state, never edited. */
export function deleteArticleLink(
  articleId: string,
  linkId: string,
): Promise<ArticleLink> {
  return apiFetch<ArticleLink>(`/articles/${articleId}/links/${linkId}`, {
    method: "DELETE",
  });
}

/**
 * Reverse lookup: a PAGE of the PUBLISHED articles linked to an asset (lean — no body; paginated +
 * filterable). Returns the whole `Page<ArticleListItem>` envelope so the panel can render search /
 * filter / pagination. #104 / #220
 */
export function getAssetArticles(
  assetId: string,
  filters: ReverseArticleFilters = {},
): Promise<ArticleListPage> {
  const qs = reverseArticleQuery(filters);
  return apiFetch<ArticleListPage>(
    qs ? `/assets/${assetId}/articles?${qs}` : `/assets/${assetId}/articles`,
  );
}

/**
 * Reverse lookup: a PAGE of the PUBLISHED articles linked to an application (lean — no body;
 * paginated + filterable). Returns the whole `Page<ArticleListItem>` envelope. #104 / #220
 */
export function getApplicationArticles(
  applicationId: string,
  filters: ReverseArticleFilters = {},
): Promise<ArticleListPage> {
  const qs = reverseArticleQuery(filters);
  return apiFetch<ArticleListPage>(
    qs
      ? `/applications/${applicationId}/articles?${qs}`
      : `/applications/${applicationId}/articles`,
  );
}
