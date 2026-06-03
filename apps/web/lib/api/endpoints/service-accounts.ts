import type {
  CreateServiceAccount,
  ServiceAccount,
  ServiceAccountWithSecret,
  UpdateServiceAccount,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the ServiceAccount resource (ADR-0048) — the ONLY place that talks to
 * `apiFetch` for service accounts. Hooks (../hooks) wrap these in TanStack Query; the admin screen
 * consumes the hooks. Routes mirror apps/api/src/service-accounts (every one gated server-side by
 * `@RequirePermission('settings:manage')`).
 *
 * SECURITY (ADR-0048): the cleartext token (`lzit_sa_<id>_<secret>`) is only ever present on the
 * {@link ServiceAccountWithSecret} returned by {@link createServiceAccount} / {@link rotateServiceAccount}.
 * Every other read returns the plain {@link ServiceAccount} (tokenPrefix only — never the secret/hash).
 * The hooks deliberately do NOT cache the with-secret response, so the secret is shown exactly once and
 * is never refetchable.
 */
const BASE = "/service-accounts";

/**
 * List service accounts. `GET /service-accounts` returns a FLAT array (not a `Page<T>` envelope —
 * the management list is small and unpaginated). Live accounts only by default; pass
 * `includeRevoked: true` to also list revoked (soft-deleted) accounts for the archived/restore view.
 */
export function getServiceAccounts(
  includeRevoked = false,
): Promise<ServiceAccount[]> {
  const path = includeRevoked ? `${BASE}?includeRevoked=true` : BASE;
  return apiFetch<ServiceAccount[]>(path);
}

/** Fetch one service account by id (`GET /service-accounts/:id`). Never carries the secret. */
export function getServiceAccount(id: string): Promise<ServiceAccount> {
  return apiFetch<ServiceAccount>(`${BASE}/${id}`);
}

/**
 * Create a service account + mint its token (`POST /service-accounts`). The response is the ONLY place
 * the cleartext token ever appears (`token` on {@link ServiceAccountWithSecret}); store it now, it is
 * never returned again. The body has NO token field — the secret is minted server-side.
 */
export function createServiceAccount(
  data: CreateServiceAccount,
): Promise<ServiceAccountWithSecret> {
  return apiFetch<ServiceAccountWithSecret>(BASE, {
    method: "POST",
    body: data,
  });
}

/**
 * Partial update (`PATCH /service-accounts/:id`): rename, edit description, replace the permission set
 * wholesale, toggle `isActive`, or change `expiresAt` (`null` clears it). The token is NEVER touched
 * here — use {@link rotateServiceAccount} to mint a new secret.
 */
export function updateServiceAccount(
  id: string,
  data: UpdateServiceAccount,
): Promise<ServiceAccount> {
  return apiFetch<ServiceAccount>(`${BASE}/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Rotate the token (`POST /service-accounts/:id/rotate`). Mints a NEW secret (the old token stops
 * working immediately) and returns the new full token EXACTLY ONCE on {@link ServiceAccountWithSecret}.
 * The account id (and the token's id segment) is unchanged.
 */
export function rotateServiceAccount(
  id: string,
): Promise<ServiceAccountWithSecret> {
  return apiFetch<ServiceAccountWithSecret>(`${BASE}/${id}/rotate`, {
    method: "POST",
  });
}

/**
 * Revoke (soft-delete) a service account (`DELETE /service-accounts/:id`). Its token stops
 * authenticating immediately; the row and its grants are preserved. Returns the now-revoked record.
 */
export function revokeServiceAccount(id: string): Promise<ServiceAccount> {
  return apiFetch<ServiceAccount>(`${BASE}/${id}`, { method: "DELETE" });
}

/**
 * Restore a revoked service account (`POST /service-accounts/:id/restore`). Clears the revocation; the
 * EXISTING token resumes working (rotate separately to invalidate it). Idempotent if already live.
 */
export function restoreServiceAccount(id: string): Promise<ServiceAccount> {
  return apiFetch<ServiceAccount>(`${BASE}/${id}/restore`, { method: "POST" });
}
