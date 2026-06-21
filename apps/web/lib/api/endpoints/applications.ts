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
 * `sort` is allowlisted to `name|vendor|isCritical|createdAt|updatedAt` (unknown → 400). Category and
 * criticality are NOT server params — the Access screen applies them client-side over the page (it
 * already joins category + grants client-side). `limit`/`offset` thread the pagination window.
 * `deleted: "only"` is the ADMIN-only archived view.
 */
export interface ApplicationListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
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
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
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

/** One application's access grants (raw — `userId` only; resolve the user client-side). */
export function getApplicationGrants(
  applicationId: string,
  { activeOnly, includeExpired }: ApplicationGrantsOptions = {},
): Promise<AccessGrant[]> {
  const params = new URLSearchParams();
  if (activeOnly !== undefined) params.set("activeOnly", String(activeOnly));
  if (includeExpired !== undefined)
    params.set("includeExpired", String(includeExpired));
  const qs = params.toString();
  return apiFetch<AccessGrant[]>(
    qs
      ? `${BASE}/${applicationId}/access-grants?${qs}`
      : `${BASE}/${applicationId}/access-grants`,
  );
}
