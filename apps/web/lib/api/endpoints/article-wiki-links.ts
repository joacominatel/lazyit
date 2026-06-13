import type {
  ArticleAlias,
  ArticleBacklink,
  CreateArticleAlias,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the KB v2 article↔article navigation primitives (ADR-0059): the materialized
 * wiki-link backlinks ("References", §4) and the nav-only folder aliases ("symlinks", §2). Both hang
 * off the article resource (`/articles/:id/...`) and are surfaced on the article detail.
 *
 * Kept in this NEW file (alongside `endpoints/article-links.ts`, the DISTINCT asset/application
 * relation from ADR-0042) so the wiki-link feature owns its own data-access. Backlinks are
 * article↔article; ArticleLinks are article↔asset/application — two different tables, two affordances.
 *
 * The acting user is set by the API from the Bearer token, never the body. Reads are visibility-gated
 * server-side (a draft's backlink never leaks); aliases are author-only writes.
 */

/**
 * List the "References" (incoming article↔article wiki-links) of an article (ADR-0059 §4) — every
 * readable article whose body `[[slug]]`-references this one, denormalized with the source's
 * slug/title for display. Draft sources are hidden from non-authors server-side.
 */
export function getArticleBacklinks(
  articleId: string,
): Promise<ArticleBacklink[]> {
  return apiFetch<ArticleBacklink[]>(`/articles/${articleId}/backlinks`);
}

/**
 * List an article's nav-only folder aliases (symlinks, ADR-0059 §2) — the folders, other than its
 * home, where the article also surfaces for browsing. Readable by any reader of the article.
 */
export function getArticleAliases(
  articleId: string,
): Promise<ArticleAlias[]> {
  return apiFetch<ArticleAlias[]>(`/articles/${articleId}/aliases`);
}

/**
 * Alias an article into another folder — a nav-only symlink (author only). The target folder must be
 * live and NOT the article's home folder; a duplicate `(folder, article)` is rejected (409). An alias
 * NEVER widens access (ADR-0059 §2; access is ADR-0060's job, not built here).
 */
export function createArticleAlias(
  articleId: string,
  data: CreateArticleAlias,
): Promise<ArticleAlias> {
  return apiFetch<ArticleAlias>(`/articles/${articleId}/aliases`, {
    method: "POST",
    body: data,
  });
}

/** Remove a folder alias from an article (author only). Hard delete — an alias is current-state. */
export function deleteArticleAlias(
  articleId: string,
  aliasId: string,
): Promise<ArticleAlias> {
  return apiFetch<ArticleAlias>(`/articles/${articleId}/aliases/${aliasId}`, {
    method: "DELETE",
  });
}
