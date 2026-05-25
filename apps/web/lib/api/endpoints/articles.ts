import type {
  Article,
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
 * Authorship/visibility is driven by `X-User-Id` (ADR-0022), which `apiFetch`
 * attaches from the acting-user store — so these functions don't deal with it.
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

/** List articles the caller may see, with optional server-side filters. */
export function getArticles(filters: ArticleFilters = {}): Promise<Article[]> {
  const params = new URLSearchParams();
  if (filters.categoryId) params.set("categoryId", filters.categoryId);
  if (filters.authorId) params.set("authorId", filters.authorId);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  const qs = params.toString();
  return apiFetch<Article[]>(qs ? `${BASE}?${qs}` : BASE);
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
