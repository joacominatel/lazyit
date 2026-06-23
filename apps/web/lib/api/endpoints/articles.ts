import type {
  Article,
  ArticleLinkedFilter,
  ArticleLinkedTo,
  ArticleListPage,
  ArticleStatus,
  CreateArticle,
  ImportArticle,
  UpdateArticle,
  ZipImportResult,
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
 * `status` / `categoryId` / `linkedTo` are **multi-select** (#198): each accepts an array whose
 * values OR-combine within the filter (and AND-combine across filters). `getArticles` comma-encodes
 * each into its one query param (`status=DRAFT,PUBLISHED`), matching the `search.ts` precedent; the
 * server splits + validates each element (unknown element → 400, ADR-0030). A single-element array
 * is equivalent to the prior single-value contract.
 *
 * `linked`/`linkedTo` drive the card-UI "linked" filter (ADR-0042): `linked: "only"` keeps just the
 * articles that have >=1 `ArticleLink`, and `linkedTo` narrows that to one or more target kinds
 * (`asset` / `application`). All allowlisted server-side -- an unknown value is rejected with 400,
 * never silently ignored (ADR-0030).
 *
 * `assetId`/`applicationId` are the **specific-entity** link filters (#213): each is a multi-value
 * array of cuids keeping only articles linked to >=1 of those exact assets / applications. Values
 * OR-combine within a param and across the two params (linked to one of these assets OR these apps);
 * selecting any id implies `linked: "only"`. Comma-encoded like the other multi-value filters; each
 * element is validated as a cuid server-side (unknown -> 400).
 */
export interface ArticleFilters {
  categoryId?: string[];
  authorId?: string;
  status?: ArticleStatus[];
  q?: string;
  linked?: ArticleLinkedFilter;
  linkedTo?: ArticleLinkedTo[];
  assetId?: string[];
  applicationId?: string[];
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
  signal?: AbortSignal,
  // Optional Bearer override for SSR server-prefetch (ADR-0067): a Server Component passes
  // `session.accessToken` from `await auth()`, since the client-side token store is browser-only.
  // Client callers omit it and `apiFetch` falls back to the session-token store, unchanged.
  token?: string,
): Promise<ArticleListPage> {
  const params = new URLSearchParams();
  // Multi-select filters (#198): comma-encode each non-empty array into its one query param.
  if (filters.categoryId?.length)
    params.set("categoryId", filters.categoryId.join(","));
  if (filters.authorId) params.set("authorId", filters.authorId);
  if (filters.status?.length) params.set("status", filters.status.join(","));
  if (filters.q) params.set("q", filters.q);
  if (filters.linked) params.set("linked", filters.linked);
  if (filters.linkedTo?.length)
    params.set("linkedTo", filters.linkedTo.join(","));
  // Specific-entity link filters (#213): comma-encode each non-empty array into its one query param.
  if (filters.assetId?.length) params.set("assetId", filters.assetId.join(","));
  if (filters.applicationId?.length)
    params.set("applicationId", filters.applicationId.join(","));
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<ArticleListPage>(qs ? `${BASE}?${qs}` : BASE, {
    signal,
    token,
  });
}

/**
 * Fetch a single article by its slug (the detail lookup). `token` is the optional SSR Bearer
 * override (ADR-0067): a Server Component prefetch passes `session.accessToken` from `await auth()`;
 * client callers omit it and `apiFetch` falls back to the browser-only session-token store.
 */
export function getArticleBySlug(slug: string, token?: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/by-slug/${encodeURIComponent(slug)}`, {
    token,
  });
}

/** Transition DRAFT -> PUBLISHED (author only). Sets publishedAt on first publish. */
export function publishArticle(id: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/${id}/publish`, { method: "POST" });
}

/** Transition PUBLISHED -> DRAFT (author only). Keeps publishedAt. */
export function unpublishArticle(id: string): Promise<Article> {
  return apiFetch<Article>(`${BASE}/${id}/unpublish`, { method: "POST" });
}

/**
 * Async import contract (ADR-0053, extended in ADR-0059 §5). Every import
 * (.md / .txt / .docx / .zip) flows through a BullMQ queue for a uniform
 * UX: the `POST` validates the file synchronously, enqueues a job and returns
 * `202 { jobId }`; the client then polls {@link getArticleImportStatus}. The
 * .docx/.zip parse runs in a sandboxed child so a decompression bomb crashes
 * the child, not the API (SEC-002).
 */

/** BullMQ job lifecycle as exposed to the client (ADR-0053). */
export type ImportJobState = "queued" | "active" | "completed" | "failed";

/** Body of the `202` from `POST /articles/import`: the enqueued job's id. */
export interface ImportArticleResult {
  jobId: string;
}

/**
 * Body of `GET /articles/import/:jobId` -- the poll target.
 * - `articleId`: non-null only when `state === "completed"` for a **single-file** import.
 *   A .zip import leaves it null (the batch has no single id -- see `batch`).
 * - `batch`: non-null only when `state === "completed"` for a .zip import (ADR-0059 §5).
 *   Contains the per-item fan-out result (created / renamed / skipped counts + item list).
 *   Single-file imports leave it null; existing callers that ignore `batch` are unaffected.
 * - `error`: a SHORT, friendly message -- non-null only when `state === "failed"`. A parse /
 *   decompression-bomb / over-quota failure is PERMANENT: the message is never phrased as
 *   a transient "try again".
 */
export interface ImportJobStatus {
  jobId: string;
  state: ImportJobState;
  articleId?: string;
  batch?: ZipImportResult | null;
  error?: string;
}

/**
 * Enqueue an async import from a .md/.txt/.docx/.zip file (multipart). Author = caller.
 * The API validates extension + size synchronously and returns `202 { jobId }`; poll
 * {@link getArticleImportStatus} for the result.
 */
export function importArticle(
  file: File,
  fields: ImportArticle,
): Promise<ImportArticleResult> {
  const form = new FormData();
  form.set("file", file);
  form.set("categoryId", fields.categoryId);
  form.set("status", fields.status);
  if (fields.title) form.set("title", fields.title);
  if (fields.slug) form.set("slug", fields.slug);
  return apiFetch<ImportArticleResult>(`${BASE}/import`, {
    method: "POST",
    body: form,
  });
}

/** Poll the status of an import job (ADR-0053). 404 -> unknown/expired job id. */
export function getArticleImportStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<ImportJobStatus> {
  return apiFetch<ImportJobStatus>(
    `${BASE}/import/${encodeURIComponent(jobId)}`,
    { signal },
  );
}
