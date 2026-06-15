import { z } from "zod";

/**
 * UserKeypair — one keypair per User, the identity the Secret Manager wraps vault DEKs TO (ADR-0061 §3,
 * crypto design note §2/§4/§5). The single source of truth for api and web wire shapes. See
 * docs/02-domain/entities/user-keypair.md.
 *
 * `publicKey` is the ONLY clear column (it is public — DEKs are wrapped to it). The X25519 private key is
 * persisted as TWO independent AES-256-GCM-wrapped copies so loss of one unlock path is survivable:
 *   - Copy A under Argon2id(vault passphrase): `privateKeyEncByPassphrase` + `passphraseSalt` +
 *     `passphraseIv` + `kdfParams` (the Argon2id parameters, recorded for re-derivation).
 *   - Copy B under the recovery key (HKDF): `privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv`.
 * The server holds public material + wrapped blobs ONLY — never a plaintext private key, the vault
 * passphrase, the recovery key, or any derived wrapping key (INV-10, ADR-0031). The vault passphrase is
 * distinct from the OIDC login password (lazyit never receives the login credential).
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian). The `kdfParams` shape is modeled
 * structurally here (NOT imported from the crypto subpath) to keep this leaf @noble-free.
 */

/** Generous cap on a base64 wrapped-blob / public-key field — bounded, never the value. */
const BLOB_MAX = 4096;

/** A base64 wrapped-private-key / public-key / salt / IV column. Shape only — never decryptable here. */
const base64Blob = z.base64().min(1).max(BLOB_MAX);

/**
 * The Argon2id KDF parameters stamped on the passphrase-wrapped private-key blob (crypto note §0/§4).
 * Recorded so a future parameter bump stays detectable/recoverable. Structural shape only — the FROZEN
 * values live in the `@lazyit/shared/crypto` subpath (`ARGON2ID_PARAMS`), which this leaf does NOT
 * import (it would pull in the `@noble`-importing crypto graph). Positive int4 bounds keep the values
 * sane without coupling to the crypto constants.
 */
export const KdfParamsSchema = z.object({
  alg: z.literal("argon2id"),
  memorySize: z.int().min(1).max(2_147_483_647),
  iterations: z.int().min(1).max(2_147_483_647),
  parallelism: z.int().min(1).max(2_147_483_647),
  saltLength: z.int().min(1).max(1024),
  hashLength: z.int().min(1).max(1024),
  v: z.int().min(1).max(2_147_483_647),
});
export type KdfParamsShape = z.infer<typeof KdfParamsSchema>;

/**
 * A single UserKeypair row (API representation of the `user_keypairs` row). Carries the public key + both
 * wrapped private-key copies + their KDF inputs so the member's browser can unlock the private key
 * (crypto note §5) — never the unwrapped private key. 1:1 with the uuid User.
 */
export const UserKeypairSchema = z.object({
  id: z.cuid(),
  userId: z.uuid(),
  publicKey: base64Blob,
  privateKeyEncByPassphrase: base64Blob,
  passphraseSalt: base64Blob,
  passphraseIv: base64Blob,
  kdfParams: KdfParamsSchema,
  privateKeyEncByRecovery: base64Blob,
  recoverySalt: base64Blob,
  recoveryIv: base64Blob,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type UserKeypair = z.infer<typeof UserKeypairSchema>;

/**
 * Create the caller's keypair (`POST /me/keypair`, slice 2b). The `userId` comes from the authenticated
 * caller, never the body — a keypair is always self-minted. Everything here is produced CLIENT-SIDE: the
 * keypair is generated in the browser, the private key is wrapped twice (passphrase + recovery key), and
 * only the public key + the two wrapped blobs + their salts/IVs/`kdfParams` are posted. The server never
 * sees the private key, the passphrase, or the recovery key (the recovery key is shown ONCE client-side).
 */
export const CreateUserKeypairSchema = z.strictObject({
  publicKey: base64Blob,
  privateKeyEncByPassphrase: base64Blob,
  passphraseSalt: base64Blob,
  passphraseIv: base64Blob,
  kdfParams: KdfParamsSchema,
  privateKeyEncByRecovery: base64Blob,
  recoverySalt: base64Blob,
  recoveryIv: base64Blob,
});
export type CreateUserKeypair = z.infer<typeof CreateUserKeypairSchema>;

/**
 * Reset / replace the caller's keypair on peer-reset or passphrase change (`PUT /me/keypair`, slice 2b).
 * Same field set as create — a peer-reset re-mints the keypair (new public key, freshly wrapped private
 * key + new recovery key) and replaces the row in place; surviving vault members then re-wrap each DEK to
 * the new public key (a separate VaultMembership re-wrap). The server still sees only public + wrapped
 * material.
 */
export const ResetUserKeypairSchema = CreateUserKeypairSchema;
export type ResetUserKeypair = z.infer<typeof ResetUserKeypairSchema>;

/**
 * Regenerate ONLY the recovery wrap for an EXISTING keypair (`POST /secret-manager/keypair/recovery`,
 * ADR-0065). The narrow, self-only "lost the recovery key, still have the passphrase" path: the client
 * unlocks the private key with the passphrase IN THE BROWSER (always re-derived via the passphrase —
 * ADR-0065 Status resolution 2), mints a NEW recovery key, re-wraps the SAME private key under it, and
 * posts ONLY the three recovery-wrap columns. Unlike a reset (`PUT /me`), this NEVER changes the public
 * key, the passphrase wrap, or `kdfParams` — so there is no DEK re-wrap and no membership churn
 * (ADR-0065 §1). The server overwrites EXACTLY `privateKeyEncByRecovery` + `recoverySalt` + `recoveryIv`;
 * it never sees the private key, the passphrase, or the recovery key (INV-10). Requires a LIVE keypair
 * (404 if none — this is NOT bootstrap). Same base64 blob discipline as the create/reset DTOs.
 */
export const RegenerateRecoveryKeySchema = z.strictObject({
  privateKeyEncByRecovery: base64Blob,
  recoverySalt: base64Blob,
  recoveryIv: base64Blob,
});
export type RegenerateRecoveryKey = z.infer<typeof RegenerateRecoveryKeySchema>;
