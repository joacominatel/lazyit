import type {
  CreateServiceAccountKeypair,
  CreateServiceAccountVaultMembership,
  ServiceAccountKeypair,
  ServiceAccountPublicKey,
  ServiceAccountVaultMembership,
} from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for the SERVICE-ACCOUNT half of the Secret Manager (ADR-0080, extends ADR-0061 + ADR-0048).
 * These are the endpoints that let a headless caller retrieve secrets programmatically: a human with
 * `secret:manage` gives the SA its own X25519 keypair (bootstrapped client-side from the SA token), then a
 * human vault member wraps the vault DEK to that SA's public key ("no grant-what-you-can't-read").
 *
 * INV-10: every payload here is public keys + WRAPPED blobs only — the SA token, the SA private key, the
 * DEK, and plaintext never cross this boundary. The two crypto-producing calls
 * (`createServiceAccountKeypair` / `addServiceAccountMember`) take a DTO the browser built with the
 * `crypto.ts` helpers; the server is a ciphertext custodian.
 *
 * Backend contract:
 *   `POST   /secret-manager/service-accounts/:saId/keypair`  → ServiceAccountKeypair   (secret:manage)
 *   `GET    /secret-manager/service-accounts/:saId/public-key` → ServiceAccountPublicKey (secret:read; 404 if none)
 *   `POST   /secret-vaults/:vaultId/service-account-members` → ServiceAccountVaultMembership (secret:manage)
 *   `DELETE /secret-vaults/:vaultId/service-account-members/:saId` → { revoked: true } (secret:manage)
 */

const SM_BASE = "/secret-manager/service-accounts";
const VAULT_BASE = "/secret-vaults";

/** The `DELETE …/service-account-members/:saId` literal response. */
export interface RevokeServiceAccountResult {
  revoked: true;
}

/**
 * Bootstrap a service account's keypair (`POST /secret-manager/service-accounts/:saId/keypair`). `data` is
 * the {@link CreateServiceAccountKeypair} wire DTO produced CLIENT-SIDE by
 * `crypto.ts#bootstrapServiceAccountKeypair(token)` — public key + the ONE token-wrapped private-key blob.
 * The token is structurally absent from `data` (the server stored only its hash). Requires `secret:manage`.
 */
export function createServiceAccountKeypair(
  saId: string,
  data: CreateServiceAccountKeypair,
): Promise<ServiceAccountKeypair> {
  return apiFetch<ServiceAccountKeypair>(`${SM_BASE}/${saId}/keypair`, {
    method: "POST",
    body: data,
  });
}

/**
 * Fetch a service account's public key (`GET /secret-manager/service-accounts/:saId/public-key`) — the
 * wrap target when granting the SA a vault. Returns `{ serviceAccountId, publicKey }` (public material
 * only). 404 if the SA has no keypair (never bootstrapped / not created with the Fetch permission).
 */
export function getServiceAccountPublicKey(
  saId: string,
): Promise<ServiceAccountPublicKey> {
  return apiFetch<ServiceAccountPublicKey>(`${SM_BASE}/${saId}/public-key`);
}

/**
 * Grant a service account as a crypto member of a vault
 * (`POST /secret-vaults/:vaultId/service-account-members`). `data` carries the target `serviceAccountId`
 * plus the DEK wrapped to that SA's public key (`wrapDekForMember(...)` → the four `WrappedDek` fields). The
 * server stores a wrapped blob it can never unwrap; the granter must already hold the DEK to have produced
 * it. 409 if the SA is already a member.
 */
export function addServiceAccountMember(
  vaultId: string,
  data: CreateServiceAccountVaultMembership,
): Promise<ServiceAccountVaultMembership> {
  return apiFetch<ServiceAccountVaultMembership>(
    `${VAULT_BASE}/${vaultId}/service-account-members`,
    { method: "POST", body: data },
  );
}

/**
 * Revoke a service account's vault membership
 * (`DELETE /secret-vaults/:vaultId/service-account-members/:saId`). HARD-DROP of the wrapped-DEK row — the
 * SA can no longer fetch a wrapped DEK. 404 if the SA is not a member. A DEK the SA already cached is NOT
 * crypto-revoked (rotate the token + re-issue the keypair for a real compromise — documented follow-up).
 */
export function removeServiceAccountMember(
  vaultId: string,
  saId: string,
): Promise<RevokeServiceAccountResult> {
  return apiFetch<RevokeServiceAccountResult>(
    `${VAULT_BASE}/${vaultId}/service-account-members/${saId}`,
    { method: "DELETE" },
  );
}
