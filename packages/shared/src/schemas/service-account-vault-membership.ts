import { z } from "zod";
import { int4 } from "./primitives";

/**
 * ServiceAccountVaultMembership — records that a SERVICE ACCOUNT is a CRYPTO MEMBER of a SecretVault,
 * carrying the vault DEK WRAPPED to that service account's public key (ADR-0080, extends ADR-0061 §4). It
 * is the machine twin of {@link VaultMembership}, kept in a SEPARATE model (keyed to the cuid
 * ServiceAccount, not the uuid User) so the human zero-knowledge tables stay untouched and there is no
 * nullable user/SA union.
 *
 * The load-bearing payload is the same ECIES-style wrap over X25519 (`ephemeralPublicKey` + `wrapNonce` +
 * `wrappedDek`). Granting = a human member unwraps the DEK with THEIR OWN private key, then wraps it to
 * the SA's public key — the "no grant-what-you-can't-read" fence still holds (ADR-0061 §4). The server
 * stores the wrapped blob in clear and can NEVER unwrap it (INV-10). A CURRENT-STATE JOIN: `createdAt` +
 * `updatedAt` (re-wrap on SA key rotation), NO `deletedAt` — revoke is a HARD DROP of the row.
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian).
 */

/** Generous cap on a base64 wrapped-blob / public-key field — bounded, never the value. */
const BLOB_MAX = 4096;

/** A base64 wrapped-DEK / ephemeral-public-key / nonce column. Shape only — never decryptable here. */
const base64Blob = z.base64().min(1).max(BLOB_MAX);

/**
 * A single ServiceAccountVaultMembership row (API representation of the
 * `service_account_vault_memberships` row). Carries the wrapped DEK so the headless caller can unwrap it
 * client-side — never the unwrapped DEK. No `deletedAt`: revoke hard-drops the row.
 */
export const ServiceAccountVaultMembershipSchema = z.object({
  id: z.cuid(),
  vaultId: z.cuid(),
  serviceAccountId: z.cuid(),
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ServiceAccountVaultMembership = z.infer<
  typeof ServiceAccountVaultMembershipSchema
>;

/**
 * Grant a service account membership (`POST /secret-vaults/:vaultId/service-account-members`, ADR-0080).
 * The `vaultId` comes from the route. A human granter (a current member with `secret:manage`) unwraps the
 * DEK with their OWN private key, re-wraps it to the TARGET SERVICE ACCOUNT's public key in the browser,
 * and posts the wrapped blob here together with the target `serviceAccountId`. The server only ever sees a
 * wrapped DEK — it cannot mint one (no-escalation, the INV-10 crypto twin).
 */
export const CreateServiceAccountVaultMembershipSchema = z.strictObject({
  serviceAccountId: z.cuid(),
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
});
export type CreateServiceAccountVaultMembership = z.infer<
  typeof CreateServiceAccountVaultMembershipSchema
>;
