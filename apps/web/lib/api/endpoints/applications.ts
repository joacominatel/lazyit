import type {
  AccessGrant,
  Application,
  CreateApplication,
  Page,
  UpdateApplication,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for Application — the access catalog (ADR-0023). Standard CRUD via the factory; the
 * list and detail are **raw** (no expanded read), so the Access screen joins category + grants
 * client-side. Plus the nested read for one application's grants.
 */

const BASE = "/applications";

const crud = createCrudEndpoints<Application, CreateApplication, UpdateApplication>(
  BASE,
);

/**
 * Server-side params for the application list (#104). `q` matches name/vendor/url/description;
 * `sort` is allowlisted to `name|vendor|isCritical|createdAt|updatedAt` (unknown → 400). `categoryId`
 * is an exact category match and `isCritical` keeps critical (`true`) or non-critical (`false`)
 * applications (#1631). `limit`/`offset` thread the pagination window.
 * `deleted: "only"` is the ADMIN-only archived view.
 */
export interface ApplicationListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
  categoryId?: string;
  isCritical?: boolean;
}

export const APPLICATION_EXPORT_PATH = `${BASE}/export`;

/** The list's filters, never paging or sort; the CSV export sends exactly these. */
export function applicationFilterParams(params: ApplicationListParams = {}): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.deleted) qs.set("deleted", params.deleted);
  if (params.categoryId) qs.set("categoryId", params.categoryId);
  if (params.isCritical !== undefined) qs.set("isCritical", String(params.isCritical));
  return qs;
}

/**
 * List applications, paged. `GET /applications` returns a `Page<Application>` envelope;
 * we return the whole envelope (`items` + `total`/`limit`/`offset`) so the list can paginate. Only
 * server-supported params are forwarded (extra client-only filter keys are ignored). Default is
 * active-only; pass `deleted: "only"` (ADMIN) for the archived view.
 */
export function getApplications(
  params: ApplicationListParams = {},
  signal?: AbortSignal,
  // Optional Bearer override for SSR server-prefetch (ADR-0067) — see `getAssets`.
  token?: string,
): Promise<Page<Application>> {
  const qs = applicationFilterParams(params);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const search = qs.toString();
  return apiFetch<Page<Application>>(
    search ? `${BASE}?${search}` : BASE,
    { signal, token },
  );
}
export const getApplication = crud.get;
export const createApplication = crud.create;
export const updateApplication = crud.update;
export const deleteApplication = crud.remove;

/**
 * Restore one soft-deleted application (`POST /applications/:id/restore`, ADMIN). Clears `deletedAt`
 * and returns the restored row.
 */
export function restoreApplication(id: string): Promise<Application> {
  return apiFetch<Application>(`${BASE}/${id}/restore`, { method: "POST" });
}

export interface ApplicationGrantsOptions {
  /** Default true — only active (non-revoked) grants. Pass false for the full history. */
  activeOnly?: boolean;
  /** Default true — include active grants past their expiresAt. Pass false to hide them. */
  includeExpired?: boolean;
}

export function applicationGrantsExportPath(applicationId: string): string {
  return `${BASE}/${applicationId}/access-grants/export`;
}

/** The per-application grant list's filters; the CSV export sends exactly these. */
export function applicationGrantFilterParams({
  activeOnly,
  includeExpired,
}: ApplicationGrantsOptions = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (activeOnly !== undefined) params.set("activeOnly", String(activeOnly));
  if (includeExpired !== undefined)
    params.set("includeExpired", String(includeExpired));
  return params;
}

/** One application's access grants (raw — `userId` only; resolve the user client-side). */
export function getApplicationGrants(
  applicationId: string,
  options: ApplicationGrantsOptions = {},
): Promise<AccessGrant[]> {
  const qs = applicationGrantFilterParams(options).toString();
  return apiFetch<AccessGrant[]>(
    qs
      ? `${BASE}/${applicationId}/access-grants?${qs}`
      : `${BASE}/${applicationId}/access-grants`,
  );
}
