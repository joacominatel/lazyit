import type {
  Article,
  ArticleListItem,
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
 * is kept) and `getArticles` unwraps `.items`. The detail reads (`getArticle`,
 * `getArticleBySlug`) still return the full `Article` with `content`.
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

/** Server-side filters for the list endpoint (ADR-0021: `q` is title+excerpt). */
export interface ArticleFilters {
  categoryId?: string;
  authorId?: string;
  status?: ArticleStatus;
  q?: string;
}

/**
 * List articles the caller may see (lean), with optional server-side filters.
 * `GET /articles` returns a paginated `Page<ArticleListItem>` envelope (ADR-0030;
 * `content` omitted); we unwrap `.items` so the list keeps consuming an array.
 * The default page size (50) applies — the UI does not yet page, so for now only
 * the first page is shown.
 */
export async function getArticles(
  filters: ArticleFilters = {},
): Promise<ArticleListItem[]> {
  const params = new URLSearchParams();
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.authorId) params.set("authorId", filters.authorId);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  const qs = params.toString();
  const page = await apiFetch<ArticleListPage>(qs ? `${BASE}?${qs}` : BASE);
  return page.items;
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
