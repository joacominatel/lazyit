import type {
  Article,
  ArticleVersion,
  ArticleVersionPage,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the ArticleVersion append-only log (ADR-0042). Two endpoints:
 *
 * - `GET /articles/:id/versions` — paginated list, newest first.
 * - `GET /articles/:id/versions/:version` — a single version by its monotonic number.
 *
 * Versions are snapshots of the article's editable state (title, content, excerpt, status)
 * plus `editedById` and `createdAt`. They are never modified or removed.
 * Draft versions are visible only to the article's author; the API enforces this.
 */

export interface ArticleVersionsParams {
  /** Per-page cap. API default 50, max 200 (ADR-0030). */
  limit?: number;
  offset?: number;
  page?: number;
}

/**
 * List the version history of one article (newest first, paginated). Requires `article:read`.
 * Returns a `Page<ArticleVersion>` envelope (`items` + `total`/`limit`/`offset`).
 */
export function getArticleVersions(
  articleId: string,
  { limit, offset, page }: ArticleVersionsParams = {},
): Promise<ArticleVersionPage> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  if (page !== undefined) params.set("page", String(page));
  const qs = params.toString();
  return apiFetch<ArticleVersionPage>(
    qs
      ? `/articles/${articleId}/versions?${qs}`
      : `/articles/${articleId}/versions`,
  );
}

/**
 * Fetch a single version of an article by its monotonic version number (1, 2, 3 …).
 * Requires `article:read`. 400 if version is not a positive integer; 404 if not found.
 */
export function getArticleVersion(
  articleId: string,
  version: number,
): Promise<ArticleVersion> {
  return apiFetch<ArticleVersion>(
    `/articles/${articleId}/versions/${version}`,
  );
}

/**
 * Restore an article to a previous version (#848): replays that version's title/body/excerpt
 * through the normal edit path, appending a NEW version (history is never mutated). Requires
 * `article:write` (the API also enforces authorship). Returns the updated live Article.
 */
export function restoreArticleVersion(
  articleId: string,
  version: number,
): Promise<Article> {
  return apiFetch<Article>(
    `/articles/${articleId}/versions/${version}/restore`,
    { method: "POST" },
  );
}
