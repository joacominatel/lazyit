import type {
  AccessGrant,
  AccessGrantListPage,
  Application,
  ApplicationGrantStatus,
  ApplicationGrantSummary,
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

/**
 * One application's access grants, unpaged (raw — `userId` only; resolve the user client-side). The
 * Access tab reads the paged {@link getApplicationGrantPage} instead (#1660); this compatibility read
 * stays for the grant dialog's "already holds" context and the workflow dry-run's sample grants.
 */
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

/**
 * The filters of an application's paged grant list (`GET /applications/:id/access-grants/page`, #1660).
 * `accessLevel` and `noAccessLevel` are exclusive (the API answers 400 to both); `q` needs `user:read`
 * on top of `accessGrant:read`, so a caller without it must not send one (403).
 */
export interface ApplicationGrantPageFilters {
  status: ApplicationGrantStatus;
  accessLevel?: string;
  noAccessLevel?: boolean;
  q?: string;
}

export interface ApplicationGrantPageParams extends ApplicationGrantPageFilters {
  limit?: number;
  offset?: number;
}

/**
 * The paged grant list's filters, never paging; the CSV export sends exactly these (ADR-0103 §10).
 * `status` is always sent, even at its `active` default: without it the export falls back to the
 * legacy `activeOnly`/`includeExpired` family.
 */
export function applicationGrantPageFilterParams(
  filters: ApplicationGrantPageFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("status", filters.status);
  if (filters.noAccessLevel) params.set("noAccessLevel", "true");
  else if (filters.accessLevel) params.set("accessLevel", filters.accessLevel);
  if (filters.q) params.set("q", filters.q);
  return params;
}

/** One page of an application's grants, filtered and ordered server-side (#1660). */
export function getApplicationGrantPage(
  applicationId: string,
  params: ApplicationGrantPageParams,
  signal?: AbortSignal,
): Promise<AccessGrantListPage> {
  const qs = applicationGrantPageFilterParams(params);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  return apiFetch<AccessGrantListPage>(
    `${BASE}/${applicationId}/access-grants/page?${qs.toString()}`,
    { signal },
  );
}

/** The Access tab's headline numbers over every grant of the application (#1660). */
export function getApplicationGrantSummary(
  applicationId: string,
  signal?: AbortSignal,
): Promise<ApplicationGrantSummary> {
  return apiFetch<ApplicationGrantSummary>(
    `${BASE}/${applicationId}/access-grants/summary`,
    { signal },
  );
}
