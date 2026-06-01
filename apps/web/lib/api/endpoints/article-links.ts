import type {
  ArticleLink,
  ArticleListItem,
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
 *   return the PUBLISHED articles linked to that record, as the lean `ArticleListItem[]` (no body),
 *   surfaced on the asset / application detail ("Related articles / Runbooks"). #104.
 *
 * The acting user (`createdById`) is set by the API from the Bearer token, never the body.
 */

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

/** Reverse lookup: the PUBLISHED articles linked to an asset (lean — no body). #104 */
export function getAssetArticles(assetId: string): Promise<ArticleListItem[]> {
  return apiFetch<ArticleListItem[]>(`/assets/${assetId}/articles`);
}

/** Reverse lookup: the PUBLISHED articles linked to an application (lean — no body). #104 */
export function getApplicationArticles(
  applicationId: string,
): Promise<ArticleListItem[]> {
  return apiFetch<ArticleListItem[]>(`/applications/${applicationId}/articles`);
}
