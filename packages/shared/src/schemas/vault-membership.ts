import { z } from "zod";
import { int4 } from "./primitives";

/**
 * VaultMembership — records that a User is a CRYPTO MEMBER of a SecretVault, carrying the vault DEK
 * WRAPPED to that member's public key (ADR-0061 §4, crypto design note §2/§5). The single source of
 * truth for api and web wire shapes. See docs/02-domain/entities/vault-membership.md.
 *
 * The load-bearing payload is an ECIES-style wrap over X25519: `ephemeralPublicKey` + `wrapNonce` +
 * `wrappedDek` (all base64). The server stores these in clear (they are public material + ciphertext,
 * left of the §9 line) and can NEVER unwrap them — only the member's private key can (INV-10). Granting
 * = wrapping the existing DEK to a new member's public key, which requires the granter to ALREADY be
 * able to unwrap it ("no grant-what-you-can't-read"). A CURRENT-STATE JOIN: `createdAt` + `updatedAt`
 * (re-wrap on peer-reset), NO `deletedAt` — v1 revoke is a HARD DROP of the row.
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian).
 */

/** Generous cap on a base64 wrapped-blob/public-key field — bounded, never the value. */
const BLOB_MAX = 4096;

/** A base64 wrapped-DEK / ephemeral-public-key / nonce column. Shape only — never decryptable here. */
const base64Blob = z.base64().min(1).max(BLOB_MAX);

/**
 * The wrapped-DEK blob set (crypto note §2). The ephemeral keypair is fresh per wrap (forward-secrecy of
 * the wrap operation), so `ephemeralPublicKey`/`wrapNonce` are unique per row. Reused by the read shape
 * and the create/re-wrap payloads — the client produces these; the server stores them verbatim.
 */
export const WrappedDekSchema = z.object({
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
});
export type WrappedDek = z.infer<typeof WrappedDekSchema>;

/**
 * A single VaultMembership row (API representation of the `vault_memberships` row). Carries the wrapped
 * DEK so the member's browser can unwrap it (crypto note §5) — never the unwrapped DEK. No `deletedAt`:
 * v1 revoke hard-drops the row.
 */
export const VaultMembershipSchema = z.object({
  id: z.cuid(),
  vaultId: z.cuid(),
  userId: z.uuid(),
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VaultMembership = z.infer<typeof VaultMembershipSchema>;

/**
 * Grant a member (`POST /secret-vaults/:vaultId/memberships`, slice 2b). The `vaultId` comes from the
 * route. The granter (a current member) unwraps the DEK with their OWN private key, re-wraps it to the
 * TARGET member's public key in the browser, and posts the wrapped blob here together with the target
 * `userId`. The server only ever sees a wrapped DEK — it cannot mint one (no-escalation, INV-9 twin).
 */
export const CreateVaultMembershipSchema = z.strictObject({
  userId: z.uuid(),
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
});
export type CreateVaultMembership = z.infer<typeof CreateVaultMembershipSchema>;

/**
 * Re-wrap a member's DEK on peer-reset (`PATCH /secret-vaults/:vaultId/memberships/:id`, slice 2b). When
 * a member resets (new keypair → new public key), a surviving member re-wraps the DEK to the new public
 * key, replacing only the wrapped-blob fields (the `(vaultId, userId)` identity is unchanged). All four
 * blob fields move together — the service enforces the grouping.
 */
export const UpdateVaultMembershipSchema = z.strictObject({
  ephemeralPublicKey: base64Blob,
  wrapNonce: base64Blob,
  wrappedDek: base64Blob,
  wrapVersion: int4({ min: 1 }),
});
export type UpdateVaultMembership = z.infer<typeof UpdateVaultMembershipSchema>;
