import { z } from "zod";
import { KdfParamsSchema } from "./user-keypair";

/**
 * ServiceAccountKeypair — the X25519 identity a SERVICE ACCOUNT (ADR-0048) uses to be a crypto member of
 * a SecretVault, so a headless caller can retrieve secrets programmatically (ADR-0080, extends ADR-0061 +
 * ADR-0048). It is the machine analogue of {@link UserKeypair}, kept in a SEPARATE model (not a
 * user/SA union) because ADR-0048 makes the service account a SEPARATE principal, never a User.
 *
 * The single, load-bearing difference from a human keypair: the private key is wrapped ONCE, under a KEK
 * derived (Argon2id) from the SA TOKEN SECRET (the `lzit_sa_<id>_<secret>` plaintext) — the token plays
 * the role the human's vault passphrase plays. There is NO recovery-key copy: the token IS the only
 * credential; losing it means rotating (re-issue the keypair + re-grant), a documented follow-up. So only
 * `privateKeyEnc` + `privateKeySalt` + `privateKeyIv` + `kdfParams` exist (one wrapped copy), never the
 * two-copy passphrase/recovery split of {@link UserKeypair}.
 *
 * ZERO-KNOWLEDGE (INV-10 preserved end-to-end): the server stores ONLY the public key + the wrapped
 * private-key blob + its KDF inputs. It NEVER stores the token plaintext (only its SHA-256 `tokenHash`
 * for auth), NEVER the unwrapped private key, and NEVER derives the KEK. The KEK derivation and every
 * unwrap happen CLIENT-SIDE (the `lazyit-fetch` CLI, or the browser at creation) — the API is a
 * ciphertext custodian, structurally incapable of decryption.
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian). `kdfParams` is modeled structurally
 * (reused from {@link user-keypair}), NOT imported from the crypto subpath, keeping this leaf @noble-free.
 */

/** Generous cap on a base64 wrapped-blob / public-key field — bounded, never the value. */
const BLOB_MAX = 4096;

/** A base64 wrapped-private-key / public-key / salt / IV column. Shape only — never decryptable here. */
const base64Blob = z.base64().min(1).max(BLOB_MAX);

/**
 * A single ServiceAccountKeypair row (API representation of the `service_account_keypairs` row). Carries
 * the public key + the ONE token-wrapped private-key copy + its KDF inputs so the headless caller can
 * unlock the private key (client-side, from the token) — never the unwrapped private key. 1:1 with the
 * cuid ServiceAccount.
 */
export const ServiceAccountKeypairSchema = z.object({
  id: z.cuid(),
  serviceAccountId: z.cuid(),
  publicKey: base64Blob,
  /** The X25519 private key wrapped under `Argon2id(SA token secret)` — ciphertext ‖ tag, base64. */
  privateKeyEnc: base64Blob,
  /** The Argon2id salt (clear, per-keypair). */
  privateKeySalt: base64Blob,
  /** The AES-GCM IV for the private-key wrap. */
  privateKeyIv: base64Blob,
  kdfParams: KdfParamsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ServiceAccountKeypair = z.infer<typeof ServiceAccountKeypairSchema>;

/**
 * Bootstrap a service account's keypair (`POST /secret-manager/service-accounts/:saId/keypair`, ADR-0080).
 * Performed by an ADMIN during SA creation — the SA cannot act for itself, so a human with `secret:manage`
 * uploads the material. Everything here is produced CLIENT-SIDE right after the SA's token is shown once:
 * the browser generates a fresh X25519 keypair, derives the KEK from the token via Argon2id, wraps the
 * private key, and posts ONLY the public key + the wrapped blob + its salt/IV/`kdfParams`. The server
 * never sees the token plaintext (it stored only the hash), the private key, or the derived KEK.
 */
export const CreateServiceAccountKeypairSchema = z.strictObject({
  publicKey: base64Blob,
  privateKeyEnc: base64Blob,
  privateKeySalt: base64Blob,
  privateKeyIv: base64Blob,
  kdfParams: KdfParamsSchema,
});
export type CreateServiceAccountKeypair = z.infer<
  typeof CreateServiceAccountKeypairSchema
>;

/**
 * The SA public-key lookup response (`GET /secret-manager/service-accounts/:saId/public-key`, ADR-0080) —
 * the ONLY keypair field a granter needs to wrap the vault DEK to the SA (the machine twin of
 * `UserPublicKey`). Public material only; never a wrapped private-key blob. Left of the §9 line.
 */
export const ServiceAccountPublicKeySchema = z.object({
  serviceAccountId: z.cuid(),
  publicKey: base64Blob,
});
export type ServiceAccountPublicKey = z.infer<
  typeof ServiceAccountPublicKeySchema
>;
