import type {
  AccessGrant,
  AccessGrantListPage,
  BatchResult,
  BatchRevokeGrants,
  CreateAccessGrant,
  RevokeAccessGrant,
  UpdateAccessGrantExpiry,
  UpdateAccessGrantNotes,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for AccessGrant — the append-only user↔application join (ADR-0023). There is **no
 * delete**: a grant is ended by revoking it. The actor (`grantedById` / `revokedById`) is set by
 * the API from the authenticated user's identity (Bearer token, ADR-0039), never the body. Reads of one application's grants
 * live in endpoints/applications.ts; the filtered list here backs the all-apps active-grant counts.
 *
 * The top-level list is **paginated** (ADR-0030): `GET /access-grants` returns a
 * `Page<AccessGrant>` envelope (the row is already lean — no relations inlined) and
 * `getAccessGrants` returns the whole envelope (`items` + `total`/`limit`/`offset`).
 * The nested per-user / per-application grant lists (in endpoints/applications.ts and
 * endpoints/users.ts) stay bare arrays.
 */

const BASE = "/access-grants";

export interface AccessGrantFilters {
  userId?: string;
  applicationId?: string;
  /** Default true — only active grants. */
  activeOnly?: boolean;
  /** Default true — include active grants past their expiresAt. */
  includeExpired?: boolean;
  /** Page size (ADR-0030; 1-200). Omit for the server default (50). */
  limit?: number;
  /** Zero-based window offset (ADR-0030). Omit for the first page. */
  offset?: number;
}

/**
 * List grants (newest first), filtered and paged. `GET /access-grants` returns a
 * paginated `Page<AccessGrant>` envelope (ADR-0030); we return the whole envelope
 * so callers can read both `items` and the `total`/`limit`/`offset` metadata. A
 * count-only consumer (e.g. the Access list's per-app avatars) requests a large
 * `limit` to gather all active grants in one page.
 */
export function getAccessGrants(
  filters: AccessGrantFilters = {},
): Promise<AccessGrantListPage> {
  const params = new URLSearchParams();
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.activeOnly !== undefined)
    params.set("activeOnly", String(filters.activeOnly));
  if (filters.includeExpired !== undefined)
    params.set("includeExpired", String(filters.includeExpired));
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return apiFetch<AccessGrantListPage>(qs ? `${BASE}?${qs}` : BASE);
}

/** Open a grant (give a user access to an application). 400 if the user/app isn't live. */
export function createAccessGrant(
  data: CreateAccessGrant,
): Promise<AccessGrant> {
  return apiFetch<AccessGrant>(BASE, { method: "POST", body: data });
}

/** Revoke an active grant (sets `revokedAt`). 409 if it's already revoked. */
export function revokeAccessGrant(
  id: string,
  data: RevokeAccessGrant = {},
): Promise<AccessGrant> {
  return apiFetch<AccessGrant>(`${BASE}/${id}/revoke`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Bulk revoke active grants (`POST /access-grants/batch/revoke`, ADMIN) — per-grant
 * `revokedAt`/`revokedById` in one transaction (#104). Optional `notes` is applied to each. Returns a
 * {@link BatchResult} (`{ requested, succeeded, skipped }`) so a partial outcome (e.g. grants already
 * revoked) can be surfaced. `ids` is bounded by `MAX_BATCH_IDS`.
 */
export function batchRevokeGrants(
  ids: BatchRevokeGrants["ids"],
  notes?: BatchRevokeGrants["notes"],
): Promise<BatchResult> {
  return apiFetch<BatchResult>(`${BASE}/batch/revoke`, {
    method: "POST",
    body: notes != null ? { ids, notes } : { ids },
  });
}

/**
 * Edit only a grant's notes (`PATCH /access-grants/:id/notes`). `notes: null` clears them. Identity
 * (user, application, grantedAt) is immutable — this is a metadata edit, no actor.
 */
export function updateAccessGrantNotes(
  id: string,
  data: UpdateAccessGrantNotes,
): Promise<AccessGrant> {
  return apiFetch<AccessGrant>(`${BASE}/${id}/notes`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Change a grant's expiry (`PATCH /access-grants/:id/expiry`) — extend, shorten, or clear it.
 * `expiresAt: null` removes the expiry (makes the grant permanent). Informative only: changing it
 * never revokes or reactivates the grant (ADR-0023).
 */
export function updateAccessGrantExpiry(
  id: string,
  data: UpdateAccessGrantExpiry,
): Promise<AccessGrant> {
  return apiFetch<AccessGrant>(`${BASE}/${id}/expiry`, {
    method: "PATCH",
    body: data,
  });
}
