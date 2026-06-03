import type {
  Article,
  ArticleLinkedFilter,
  ArticleLinkedTo,
  ArticleListPage,
  ArticleStatus,
  CreateArticle,
  ImportArticle,
  UpdateArticle,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for the Knowledge Base Article resource. The plain CRUD bodies
 * come from `createCrudEndpoints`; the KB-specific routes (filtered list,
 * by-slug, publish/unpublish, multipart import) are hand-written alongside —
 * the "spread the factory + add bespoke endpoints" pattern from ADR-0020.
 *
 * The list read is **lean and paginated** (ADR-0030): `GET /articles` returns a
 * `Page<ArticleListItem>` envelope (the markdown `content` is omitted; `excerpt`
 * is kept) and `getArticles` returns the whole envelope so the list can render
 * pagination controls. The detail reads (`getArticle`, `getArticleBySlug`) still
 * return the full `Article` with `content`.
 *
 * Authorship/visibility is enforced by the API via the Bearer token (ADR-0038/0039).
 * These functions don't deal with auth directly — the token flows from the session.
 */

const BASE = "/articles";

const crud = createCrudEndpoints<Article, CreateArticle, UpdateArticle>(BASE);
export const getArticle = crud.get;
export const createArticle = crud.create;
export const updateArticle = crud.update;
export const deleteArticle = crud.remove;

/**
 * Server-side filters for the list endpoint (ADR-0021: `q` is title+excerpt).
 * `limit`/`offset` thread the pagination window (ADR-0030); omit for the defaults.
 *
 * `linked`/`linkedTo` drive the card-UI "linked" filter (ADR-0042): `linked: "only"`
 * keeps just the articles that have ≥1 `ArticleLink`, and `linkedTo` narrows that to a
 * single target kind (`asset` / `application`). Both are allowlisted server-side — an
 * unknown value is rejected with 400, never silently ignored (ADR-0030).
 */
export interface ArticleFilters {
  categoryId?: string;
  authorId?: string;
  status?: ArticleStatus;
  q?: string;
  linked?: ArticleLinkedFilter;
  linkedTo?: ArticleLinkedTo;
  limit?: number;
  offset?: number;
}

/**
 * List articles the caller may see (lean), with optional server-side filters and
 * paging. `GET /articles` returns a paginated `Page<ArticleListItem>` envelope
 * (ADR-0030; `content` omitted); we return the whole envelope (`items` +
 * `total`/`limit`/`offset`) so the list can render pagination controls.
 */
export function getArticles(
  filters: ArticleFilters = {},
): Promise<ArticleListPage> {
  const params = new URLSearchParams();
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.authorId) params.set("authorId", filters.authorId);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.linked) params.set("linked", filters.linked);
  if (filters.linkedTo) params.set("linkedTo", filters.linkedTo);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<ArticleListPage>(qs ? `${BASE}?${qs}` : BASE);
}

/** Fetch a single article by its slug (the public/detail lookup). */
export function getArticleBySlug(slug: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/by-slug/${encodeURIComponent(slug)}`);
}

/** Transition DRAFT → PUBLISHED (author only). Sets publishedAt on first publish. */
export function publishArticle(id: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/${id}/publish`, { method: "POST" });
}

/** Transition PUBLISHED → DRAFT (author only). Keeps publishedAt. */
export function unpublishArticle(id: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/${id}/unpublish`, { method: "POST" });
}

/** Import an article from a .md/.txt/.docx file (multipart). Author = caller. */
export function importArticle(
  file: File,
  fields: ImportArticle,
): Promise<Article> {
  const form = new FormData();
  form.set("file", file);
  form.set("categoryId", fields.categoryId);
  form.set("status", fields.status);
  if (fields.title) form.set("title", fields.title);
  if (fields.slug) form.set("slug", fields.slug);
  return apiFetch<Article>(`${BASE}/import`, { method: "POST", body: form });
}
