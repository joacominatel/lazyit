/**
 * Secret Manager crypto parameters — the FROZEN pins (no `window`, no `.wasm`, no DOM).
 *
 * This module holds only constants and types: the Argon2id parameters, the byte-length pins, and
 * the HKDF domain-separation `info` strings shared by the wrap primitives. Pure data so the client
 * (apps/web) and any re-derivation path agree on one definition.
 *
 * Authoritative spec: `docs/04-development/secret-manager-crypto-design.md` §0/§1 (parameters) and
 * the CTO ratification (§10). Decision of record: `docs/03-decisions/0061-secret-manager-zero-knowledge.md`
 * (INV-10). These values are merge-gated — do NOT re-derive them.
 *
 * NOTE on Argon2id: only the PARAMETERS live here. The Argon2id WASM wrapper itself is a web-only
 * slice (apps/web) — `@lazyit/shared` is a framework-agnostic leaf and never loads a `.wasm`.
 */

/**
 * Argon2id KDF parameters (FROZEN — spec §0/§10, OWASP/RFC 9106 interactive baseline). Used by the
 * web slice to derive the passphrase wrapping key for the private key at rest (§4 Copy A).
 *
 * - `alg`: always `"argon2id"`.
 * - `memorySize`: 65536 KiB (64 MiB) — the memory-hardness lever.
 * - `iterations`: 3 (time cost).
 * - `parallelism`: 1 lane (single-user, single-shot browser unlock).
 * - `saltLength`: 16 bytes, CSPRNG, unique per derivation, stored in clear.
 * - `hashLength`: 32 bytes raw (a 256-bit AES key, NOT a PHC string).
 * - `v`: parameter-set version, stamped into the wrapped-key blob so a future bump is detectable.
 */
export interface KdfParams {
  /** The KDF algorithm. Always `"argon2id"` in v1. */
  readonly alg: "argon2id";
  /** Memory cost in KiB. 65536 = 64 MiB. */
  readonly memorySize: number;
  /** Time cost (number of passes). */
  readonly iterations: number;
  /** Degree of parallelism (lanes). */
  readonly parallelism: number;
  /** Salt length in bytes. */
  readonly saltLength: number;
  /** Raw derived-key length in bytes (32 = 256-bit AES key). */
  readonly hashLength: number;
  /** Parameter-set version, stamped into the wrapped-key blob for future-proofing. */
  readonly v: number;
}

/**
 * The FROZEN Argon2id parameter set (spec §0/§10). Recorded once here so the client and any future
 * re-derivation use byte-identical settings — a mismatch would make a stored blob undecryptable.
 */
export const ARGON2ID_PARAMS: KdfParams = {
  alg: "argon2id",
  memorySize: 65536, // 64 MiB
  iterations: 3,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32,
  v: 1,
} as const;

// ---------------------------------------------------------------------------
// Byte-length pins (shared across the crypto primitives).
// ---------------------------------------------------------------------------

/** AES-256 key length in bytes (the DEK, and every derived wrapping key). */
export const AES_KEY_BYTES = 32;

/**
 * AES-GCM IV / nonce length in bytes. 96-bit (12-byte) random, fresh per value — the GCM-recommended
 * size and identical to the `WorkflowSecret` envelope (spec §3).
 */
export const GCM_IV_BYTES = 12;

/** AES-GCM authentication tag length in bytes (128-bit). */
export const GCM_TAG_BYTES = 16;

/** X25519 public-key length in bytes. */
export const X25519_PUBLIC_KEY_BYTES = 32;

/** X25519 secret-key length in bytes. */
export const X25519_SECRET_KEY_BYTES = 32;

/** Vault DEK length in bytes (a 256-bit symmetric key). */
export const DEK_BYTES = 32;

// ---------------------------------------------------------------------------
// HKDF domain-separation `info` strings (spec §2 / §4.1). These bind each HKDF
// expansion to a single purpose so the same shared secret can never be reused
// across contexts. Treat them as part of the wire format — changing one makes
// existing blobs undecryptable.
// ---------------------------------------------------------------------------

/** `info` for expanding an X25519 shared secret into a DEK-wrapping KEK (spec §2). */
export const HKDF_INFO_DEK_WRAP = "lazyit/vault-dek-wrap/v1";

/** `info` for expanding recovery-key bytes into a private-key-wrapping key (spec §4.1). */
export const HKDF_INFO_RECOVERY_WRAP = "lazyit/recovery-wrap/v1";

/**
 * The current envelope/wrap version stamped on freshly-produced blobs. Mirrors `WorkflowSecret`'s
 * `keyVersion` semantics, but here it tracks the vault DEK version (spec §3): v1 writes 1 and never
 * rotates; the column is the forward-compat seam for a deferred DEK-rotation.
 */
export const CURRENT_KEY_VERSION = 1;

/** The wrap version stamped on freshly-produced wrapped-DEK blobs (spec §2). */
export const CURRENT_WRAP_VERSION = 1;
