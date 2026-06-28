import { z } from "zod";
import { int4 } from "./primitives";

/**
 * SecretItem — a single secret VALUE inside a SecretVault (ADR-0061 §2, crypto design note §3/§5). The
 * single source of truth for api and web wire shapes. See docs/02-domain/entities/secret-item.md.
 *
 * The row stores ONLY the ciphertext of the value, encrypted under the vault DEK, in columns that mirror
 * WorkflowSecret EXACTLY: `ciphertext` / `iv` / `authTag` / `keyVersion` (base64 text). CRUCIAL contrast
 * with WorkflowSecret: WorkflowSecret's read shape DROPS the envelope because the SERVER decrypts it;
 * here the CLIENT decrypts, so the read shape legitimately CARRIES the envelope blobs (crypto note §5) —
 * they are ciphertext, safe to hand to the member's browser, which alone holds the (unwrapped) DEK. The
 * server can NEVER produce the plaintext value (INV-10) and NEVER logs the envelope (ADR-0031).
 *
 * `handle` is the §8 KB-chip machine reference ({{ lazyit_secret.HANDLE }}); `label` is the human title.
 * Both are server-visible metadata, never the value.
 *
 * PURE zod — this file MUST NOT import `@lazyit/shared/crypto` or `@noble/*` (apps/api's CommonJS Jest
 * cannot load ESM `@noble`; apps/api is only a ciphertext custodian).
 */

/** Length bounds for the server-visible metadata fields. */
const HANDLE_MAX = 80;
const LABEL_MAX = 200;
/** Generous cap on a base64 envelope/blob field — large enough for any reasonable value, bounded. */
const BLOB_MAX = 16384;

/**
 * A base64 string blob (an at-rest ciphertext / nonce / tag column). Shape only: non-empty, bounded,
 * base64-charset. The server validates SHAPE, never the value — it cannot decrypt it.
 */
const base64Blob = z.base64().min(1).max(BLOB_MAX);

/**
 * The STRUCTURAL TYPE of a secret (ADR-0075) — server-visible METADATA only (same trust class as
 * `handle`/`label`), NEVER the value. It tells the UI which typed form/icon/renderer to use WITHOUT
 * decrypting; the typed payload itself is a CLIENT-SIDE JSON encoding serialized into the SAME opaque
 * ciphertext, so the server never sees it (INV-10). Mirrors the Prisma `SecretItemKind` enum.
 *
 *   - GENERIC     — a plain string value (legacy + the back-compat default).
 *   - SSH_KEY     — client payload e.g. `{ privateKey, publicKey?, passphrase? }`.
 *   - TOTP        — client payload e.g. `{ secret, issuer?, account?, digits?, period?, algorithm? }`.
 *   - CERTIFICATE — client payload e.g. `{ certificate, privateKey?, chain? }`.
 *
 * The payload shapes above are a CLIENT-SIDE contract (encoded/parsed entirely in the browser); the
 * server validates none of them — it stores only `kind` + the ciphertext.
 */
export const SecretItemKindSchema = z.enum([
  "GENERIC",
  "SSH_KEY",
  "TOTP",
  "CERTIFICATE",
]);
export type SecretItemKind = z.infer<typeof SecretItemKindSchema>;

/**
 * The AES-256-GCM envelope of a SecretItem value (crypto note §3) — byte-compatible with WorkflowSecret.
 * `ciphertext` excludes the 16-byte tag; `authTag` holds the trailing 16 bytes; `iv` is the 12-byte
 * nonce. `keyVersion` tracks the vault DEK version (v1 = 1). Reused by the read shape and the create/
 * update payloads — the client produces these blobs; the server stores them verbatim.
 */
export const SecretEnvelopeSchema = z.object({
  ciphertext: base64Blob,
  iv: base64Blob,
  authTag: base64Blob,
  keyVersion: int4({ min: 1 }),
});
export type SecretEnvelope = z.infer<typeof SecretEnvelopeSchema>;

/**
 * A single SecretItem row (API representation of the `secret_items` row). UNLIKE WorkflowSecret, the read
 * shape INCLUDES the envelope blobs (the client decrypts; crypto note §5) — they are ciphertext, never
 * plaintext. The plaintext value is structurally absent.
 */
export const SecretItemSchema = z.object({
  id: z.cuid(),
  vaultId: z.cuid(),
  handle: z.string().min(1).max(HANDLE_MAX),
  label: z.string().min(1).max(LABEL_MAX),
  ciphertext: base64Blob,
  iv: base64Blob,
  authTag: base64Blob,
  keyVersion: int4({ min: 1 }),
  // The structural type — metadata only, drives the typed form/render in the client (ADR-0075).
  kind: SecretItemKindSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type SecretItem = z.infer<typeof SecretItemSchema>;

/**
 * Create an item (`POST /secret-vaults/:vaultId/items`, slice 2b). The `vaultId` comes from the route,
 * never the body. The CLIENT supplies the metadata + the already-encrypted envelope (it encrypted the
 * value under the vault DEK in the browser); the server stores ciphertext only — it never sees the
 * plaintext value. Live handle uniqueness (global) is enforced by a partial unique index + the service.
 */
export const CreateSecretItemSchema = z.strictObject({
  handle: z.string().trim().min(1).max(HANDLE_MAX),
  label: z.string().trim().min(1).max(LABEL_MAX),
  ciphertext: base64Blob,
  iv: base64Blob,
  authTag: base64Blob,
  keyVersion: int4({ min: 1 }),
  // The structural type — metadata only; OPTIONAL on the wire, the service defaults it to GENERIC when
  // omitted so existing clients keep working (ADR-0075). Kept `.optional()` (not zod `.default()`) so the
  // inferred type stays optional for direct service callers; the GENERIC fill lives in the service.
  kind: SecretItemKindSchema.optional(),
});
export type CreateSecretItem = z.infer<typeof CreateSecretItemSchema>;

/**
 * Update an item (`PATCH /secret-vaults/:vaultId/items/:id`, slice 2b). All fields optional — a metadata
 * edit (label/handle) and a value-change (a fresh envelope, re-encrypted under the same DEK) are both
 * possible. When the value changes, the client MUST send all four envelope fields together (the new
 * ciphertext/iv/authTag and the keyVersion that produced them); the service enforces that all-or-none
 * grouping. An empty PATCH is rejected at the service edge.
 */
export const UpdateSecretItemSchema = z.strictObject({
  handle: z.string().trim().min(1).max(HANDLE_MAX).optional(),
  label: z.string().trim().min(1).max(LABEL_MAX).optional(),
  ciphertext: base64Blob.optional(),
  iv: base64Blob.optional(),
  authTag: base64Blob.optional(),
  keyVersion: int4({ min: 1 }).optional(),
  // A secret can be RE-TYPED (metadata only) — e.g. promoting a GENERIC value to SSH_KEY (ADR-0075).
  kind: SecretItemKindSchema.optional(),
});
export type UpdateSecretItem = z.infer<typeof UpdateSecretItemSchema>;
