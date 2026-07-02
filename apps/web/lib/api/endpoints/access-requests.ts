import {
  type AccessRequest,
  type AccessRequestListPage,
  AccessRequestListPageSchema,
  AccessRequestSchema,
  type AccessRequestStatus,
  type CreateAccessRequest,
  type DenyAccessRequest,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for AccessRequest — the self-service request→approve/deny→grant lifecycle (ADR-0085).
 * A request is an append-lifecycle row: born PENDING, closed by a HUMAN decision (APPROVED → a grant
 * is created through the existing grant path, or DENIED with a reason). Rows are never deleted.
 *
 * The requester is always the authenticated caller (never in the body). Reads are paged (ADR-0030):
 * the estate-wide list (`accessRequest:read`, ADMIN+MEMBER) and the self-scope `/mine` (any human).
 * Responses are validated against the shared zod schemas so wire drift surfaces at the boundary.
 */

const BASE = "/access-requests";

export interface AccessRequestFilters {
  status?: AccessRequestStatus;
  applicationId?: string;
  requesterId?: string;
  /** Page size (ADR-0030). Omit for the server default. */
  limit?: number;
  /** Zero-based window offset (ADR-0030). Omit for the first page. */
  offset?: number;
}

/**
 * List access requests (newest first), filtered and paged (`GET /access-requests`,
 * `accessRequest:read`). Returns the whole `Page<AccessRequest>` envelope so callers can read both
 * `items` and the `total`/`limit`/`offset` metadata.
 */
export async function getAccessRequests(
  filters: AccessRequestFilters = {},
): Promise<AccessRequestListPage> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.requesterId) params.set("requesterId", filters.requesterId);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined)
    params.set("offset", String(filters.offset));
  const qs = params.toString();
  return AccessRequestListPageSchema.parse(
    await apiFetch<unknown>(qs ? `${BASE}?${qs}` : BASE),
  );
}

/**
 * The CALLER's OWN access requests (`GET /access-requests/mine`) — pending + decided history. A
 * SELF-SCOPE read: any authenticated human, no `accessRequest:read` (a VIEWER lacks it), so it powers
 * the self-service `/profile` tracking list and the "already requested?" check on application detail.
 */
export async function getMyAccessRequests(
  { limit }: { limit?: number } = {},
): Promise<AccessRequestListPage> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  const qs = params.toString();
  return AccessRequestListPageSchema.parse(
    await apiFetch<unknown>(qs ? `${BASE}/mine?${qs}` : `${BASE}/mine`),
  );
}

/**
 * Raise a request for access to an application (`POST /access-requests`, `accessRequest:create` —
 * seeded to every role). 400 if the app isn't live; **409** if a PENDING request already exists for
 * this (caller, app) — the caller handles that as "you already have a pending request", not an error.
 */
export async function createAccessRequest(
  data: CreateAccessRequest,
): Promise<AccessRequest> {
  return AccessRequestSchema.parse(
    await apiFetch<unknown>(BASE, { method: "POST", body: data }),
  );
}

/**
 * Approve a request (`POST /access-requests/:id/approve`, `accessGrant:grant`) — no body. Creates the
 * grant + flips the request to APPROVED in one transaction. 409 if it was already decided.
 */
export async function approveAccessRequest(id: string): Promise<AccessRequest> {
  return AccessRequestSchema.parse(
    await apiFetch<unknown>(`${BASE}/${id}/approve`, { method: "POST" }),
  );
}

/**
 * Deny a request (`POST /access-requests/:id/deny`, `accessGrant:grant`) — a reason is REQUIRED.
 * 409 if it was already decided.
 */
export async function denyAccessRequest(
  id: string,
  data: DenyAccessRequest,
): Promise<AccessRequest> {
  return AccessRequestSchema.parse(
    await apiFetch<unknown>(`${BASE}/${id}/deny`, {
      method: "POST",
      body: data,
    }),
  );
}
