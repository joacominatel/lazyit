import { z } from "zod";

/**
 * SecretVault — a folder vault, the CRYPTO BOUNDARY of the zero-knowledge Secret Manager (ADR-0061 §2,
 * crypto design note §5). The single source of truth for api and web wire shapes. See
 * docs/02-domain/entities/secret-vault.md.
 *
 * Server-VISIBLE (left of the §9 zero-knowledge line): only the non-secret `name` and the member list
 * (modeled separately as VaultMembership). The vault row NEVER carries the DEK — the only copies that
 * exist are the per-member wrapped-DEK blobs on VaultMembership. The server can NEVER decrypt the vault
 * (INV-10). Date fields are ISO-8601 strings (the wire shape).
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian).
 */

/** Display-bound length for a vault name (server-visible metadata; name it harmlessly — §9). */
const VAULT_NAME_MAX = 120;

/** A single SecretVault row (API representation of the `secret_vaults` row). Metadata only. */
export const SecretVaultSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1).max(VAULT_NAME_MAX),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type SecretVault = z.infer<typeof SecretVaultSchema>;

/**
 * Create a vault (`POST /secret-vaults`, slice 2b). Only the non-secret `name` is supplied here — the
 * vault DEK is generated CLIENT-SIDE and never transits the server (crypto note §3); the creator's own
 * VaultMembership (the first wrapped-DEK copy) is posted alongside in the same flow. Live vault-name
 * uniqueness is enforced by a partial unique index + the service (a 409 on a live collision).
 */
export const CreateSecretVaultSchema = z.strictObject({
  name: z.string().trim().min(1).max(VAULT_NAME_MAX),
});
export type CreateSecretVault = z.infer<typeof CreateSecretVaultSchema>;

/**
 * Update a vault (`PATCH /secret-vaults/:id`, slice 2b). Only the non-secret `name` is mutable — the
 * DEK and ciphertext are immutable from the server's side (it holds no key). `name` is required because
 * it is the only editable field; an empty PATCH is meaningless here.
 */
export const UpdateSecretVaultSchema = z.strictObject({
  name: z.string().trim().min(1).max(VAULT_NAME_MAX),
});
export type UpdateSecretVault = z.infer<typeof UpdateSecretVaultSchema>;

/**
 * Record a vault secret EXPORT (`POST /secret-vaults/:id/export`, #612). The export itself — decrypting
 * the values and building the `.env`/JSON file — happens ENTIRELY CLIENT-SIDE after the member unlocks the
 * vault (INV-10 / ADR-0061: the server never sees plaintext). This endpoint only writes the metadata-only
 * audit row (action `ITEMS_EXPORTED`). The body therefore carries NO secret material whatsoever — it is a
 * `strictObject` so any unknown key (a smuggled value/key/blob) is rejected with a 400. The only field is
 * an OPTIONAL non-secret `itemCount` (how many items the client exported), kept for the audit trail.
 */
export const ExportSecretsAuditSchema = z.strictObject({
  itemCount: z.number().int().nonnegative().optional(),
});
export type ExportSecretsAudit = z.infer<typeof ExportSecretsAuditSchema>;
