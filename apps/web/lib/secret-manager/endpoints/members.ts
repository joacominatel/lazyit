import type { CreateVaultMembership, VaultMembership } from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for `VaultMembership` — the wrapped-DEK join that says "user U can decrypt vault V"
 * (ADR-0061 §4, crypto-design §2). Granting is a CLIENT-SIDE re-wrap: a current member unwraps the DEK
 * with their own private key, re-wraps it to the target's public key (`wrapDekForMember`), and posts the
 * wrapped blob here. The server only ever sees wrapped DEKs — it cannot mint one ("no
 * grant-what-you-can't-read", INV-9 twin / INV-10).
 *
 * Backend contract (slice 2b): `GET /secret-vaults/:id/members` (metadata list),
 * `GET /secret-vaults/:id/membership/me` (the caller's own wrapped-DEK row),
 * `POST /secret-vaults/:id/members { userId, ...wrappedDek }`,
 * `DELETE /secret-vaults/:id/members/:userId` → `{ revoked: true }`.
 */

const BASE = "/secret-vaults";

/**
 * A vault member's NON-secret metadata — the shape of `GET /secret-vaults/:id/members` and the embedded
 * `members` on the vault detail. No wrapped-DEK blobs here (those are per-caller, on `membership/me`).
 * Frontend read-shape only.
 */
export interface VaultMemberMeta {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  memberSince: string;
}

/** The `DELETE …/members/:userId` literal response. */
export interface RevokeResult {
  revoked: true;
}

/** List a vault's members (metadata only — no wrapped DEKs). */
export function getMembers(vaultId: string): Promise<VaultMemberMeta[]> {
  return apiFetch<VaultMemberMeta[]>(`${BASE}/${vaultId}/members`);
}

/**
 * Fetch the caller's OWN membership row (the wrapped-DEK blob set the browser needs to unwrap the vault
 * DEK via `unwrapDekFromMembership`). 404 if the caller is not a live member.
 */
export function getMyMembership(vaultId: string): Promise<VaultMembership> {
  return apiFetch<VaultMembership>(`${BASE}/${vaultId}/membership/me`);
}

/**
 * Grant a member: post the target `userId` plus the DEK wrapped to their public key
 * (`wrapDekForMember(...)` → the four `WrappedDek` fields). The server stores a wrapped blob it can never
 * unwrap; the granter must already hold the DEK to have produced it.
 */
export function addMember(
  vaultId: string,
  data: CreateVaultMembership,
): Promise<VaultMembership> {
  return apiFetch<VaultMembership>(`${BASE}/${vaultId}/members`, {
    method: "POST",
    body: data,
  });
}

/**
 * Revoke a member (v1 soft revoke = HARD DROP of their wrapped-DEK row). The dropped member can no longer
 * fetch a wrapped DEK; a CACHED DEK is NOT crypto-revoked (hard revoke / DEK rotation is deferred).
 */
export function removeMember(
  vaultId: string,
  userId: string,
): Promise<RevokeResult> {
  return apiFetch<RevokeResult>(`${BASE}/${vaultId}/members/${userId}`, {
    method: "DELETE",
  });
}
