import type {
  CreateSecretVaultWithMembership,
  SecretVault,
  SecretVaultDetail,
  UpdateSecretVault,
} from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for `SecretVault` — the folder vault that is the CRYPTO BOUNDARY of the zero-knowledge
 * Secret Manager (ADR-0061 §2). Server-visible state is ONLY the `name` + member list (metadata, §9);
 * the vault row NEVER carries the DEK. Creating a vault posts the non-secret `name` together with the
 * creator's SELF-WRAP of the client-generated DEK (their first membership) — the server stores a wrapped
 * blob it can never unwrap (INV-10).
 *
 * Backend contract (slice 2b): `GET /secret-vaults`, `GET /secret-vaults/:id` (embeds `members`),
 * `POST /secret-vaults { name, membership }`, `PATCH /secret-vaults/:id`, `DELETE /secret-vaults/:id`.
 * All list/single responses are plain (no pagination envelope). The `{ name, membership }` body
 * ({@link CreateSecretVaultWithMembership}) and the detail shape ({@link SecretVaultDetail}) are the
 * shared contracts — one definition across api + web (issue #430).
 */

const BASE = "/secret-vaults";

/** List the vaults the caller can see (ADMIN → all; else only vaults they are a member of). Metadata only. */
export function getVaults(): Promise<SecretVault[]> {
  return apiFetch<SecretVault[]>(BASE);
}

/** Fetch one vault with its embedded member list. Metadata only — never a DEK. */
export function getVault(vaultId: string): Promise<SecretVaultDetail> {
  return apiFetch<SecretVaultDetail>(`${BASE}/${vaultId}`);
}

/**
 * Create a vault. `body.name` is server-visible metadata; `body.membership` is the creator's wrapped-DEK
 * self-wrap (produced client-side). The raw DEK stays in the browser and is never part of `body`.
 */
export function createVault(
  body: CreateSecretVaultWithMembership,
): Promise<SecretVault> {
  return apiFetch<SecretVault>(BASE, { method: "POST", body });
}

/** Rename a vault (`PATCH /secret-vaults/:id { name }`). Only the non-secret `name` is mutable. */
export function updateVault(
  vaultId: string,
  data: UpdateSecretVault,
): Promise<SecretVault> {
  return apiFetch<SecretVault>(`${BASE}/${vaultId}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete a vault. Returns the soft-deleted vault (`deletedAt` set). */
export function deleteVault(vaultId: string): Promise<SecretVault> {
  return apiFetch<SecretVault>(`${BASE}/${vaultId}`, { method: "DELETE" });
}
