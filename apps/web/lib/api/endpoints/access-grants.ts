import type {
  AccessGrant,
  CreateAccessGrant,
  RevokeAccessGrant,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for AccessGrant — the append-only user↔application join (ADR-0023). There is **no
 * delete**: a grant is ended by revoking it. The actor (`grantedById` / `revokedById`) is set by
 * the API from the `X-User-Id` header (optional), never the body. Reads of one application's grants
 * live in endpoints/applications.ts; the filtered list here backs the all-apps active-grant counts.
 */

const BASE = "/access-grants";

export interface AccessGrantFilters {
  userId?: string;
  applicationId?: string;
  /** Default true — only active grants. */
  activeOnly?: boolean;
  /** Default true — include active grants past their expiresAt. */
  includeExpired?: boolean;
}

/** List grants (newest first), filtered. */
export function getAccessGrants(
  filters: AccessGrantFilters = {},
): Promise<AccessGrant[]> {
  const params = new URLSearchParams();
  if (filters.userId) params.set("userId", filters.userId);
  if (filters.applicationId) params.set("applicationId", filters.applicationId);
  if (filters.activeOnly !== undefined)
    params.set("activeOnly", String(filters.activeOnly));
  if (filters.includeExpired !== undefined)
    params.set("includeExpired", String(filters.includeExpired));
  const qs = params.toString();
  return apiFetch<AccessGrant[]>(qs ? `${BASE}?${qs}` : BASE);
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
