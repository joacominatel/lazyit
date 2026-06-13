/**
 * AEAD — AES-256-GCM seal/open over the Secret Manager at-rest envelope (spec §3).
 *
 * Pure and framework-agnostic (`@noble/ciphers`, no `node:crypto`, no `window`). The produced
 * envelope is **byte-identical** to the engine's `WorkflowSecret` store
 * (`apps/api/src/workflow-engine/secrets/secret.service.ts`): `{ ciphertext, iv, authTag, keyVersion }`,
 * all base64 text.
 *
 * THE #1 DETAIL — the split/join (spec §3, CTO ratification §10):
 *   `@noble/ciphers` `gcm(key, iv).encrypt(pt)` returns `ciphertext ‖ tag` concatenated (the tag is
 *   the trailing 16 bytes). `node:crypto` exposes the tag separately via `cipher.getAuthTag()`. To
 *   keep both stores wire-compatible, on WRITE we SPLIT the noble output into `ciphertext` (all but
 *   the last 16 bytes) + `authTag` (the last 16 bytes); on READ we RE-CONCATENATE
 *   `ciphertext ‖ authTag` before calling `decrypt`. Get this wrong and the two stores diverge.
 *
 * Failure discipline (spec §8 / §10): a decrypt failure throws a GENERIC error — it never carries the
 * plaintext, the key, or any input. A GCM tag mismatch is indistinguishable from a wrong key, which
 * is correct.
 */

import { gcm } from "@noble/ciphers/aes.js";
import {
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
} from "@noble/ciphers/utils.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  AES_KEY_BYTES,
  CURRENT_KEY_VERSION,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
} from "./params";

/**
 * The AES-256-GCM at-rest envelope — mirrors the `WorkflowSecret` column shape byte-for-byte. All
 * fields are base64 text except the integer `keyVersion`.
 */
export interface SecretEnvelope {
  /** base64 ciphertext (the GCM output WITHOUT the trailing 16-byte tag). */
  ciphertext: string;
  /** base64 IV/nonce (96-bit, fresh per value). */
  iv: string;
  /** base64 GCM auth tag (the trailing 16 bytes of the GCM output). */
  authTag: string;
  /** Which key/DEK version produced this envelope. */
  keyVersion: number;
}

/** A generic, payload-free decrypt error — mirrors `secret.service.ts`'s `reveal()` catch (§8). */
const DECRYPT_ERROR_MESSAGE =
  "Failed to decrypt (authentication failed or wrong key).";

// ---------------------------------------------------------------------------
// base64 helpers (no Buffer / no node:crypto — `@lazyit/shared` is a pure leaf).
// `globalThis.btoa`/`atob` exist in the browser, Node 16+, and Bun; the build's
// `lib: ["ES2023"]` does not type them, so we reference them defensively.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  btoa?: (data: string) => string;
  atob?: (data: string) => string;
};

/** Encode raw bytes to a base64 string. */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof g.btoa !== "function") {
    throw new Error("base64 encoder unavailable in this environment.");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return g.btoa(binary);
}

/** Decode a base64 string to raw bytes. Throws on malformed input. */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof g.atob !== "function") {
    throw new Error("base64 decoder unavailable in this environment.");
  }
  const binary = g.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Seal a UTF-8 plaintext under a 32-byte AES-256-GCM key, producing the at-rest envelope. A fresh
 * 96-bit random IV is drawn per call (never reuse an IV with a key). The noble `ciphertext ‖ tag`
 * output is SPLIT into the separate `ciphertext` + `authTag` columns (spec §3).
 *
 * @param key   32-byte AES-256 key (the DEK, or a derived wrapping key).
 * @param value the UTF-8 plaintext to encrypt.
 * @param keyVersion the version stamp for the envelope (defaults to the current key version).
 */
export function seal(
  key: Uint8Array,
  value: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): SecretEnvelope {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes.`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = gcm(key, iv).encrypt(utf8ToBytes(value));
  // SPLIT: ciphertext = all but the trailing 16-byte tag; authTag = the trailing 16 bytes.
  const ciphertext = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const authTag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    keyVersion,
  };
}

/**
 * Open an at-rest envelope back to its UTF-8 plaintext. RE-CONCATENATES `ciphertext ‖ authTag`
 * before decrypting (the inverse of {@link seal}'s split, spec §3). GCM verifies the tag — any
 * tamper or wrong key throws a GENERIC, payload-free error (§8).
 *
 * @param key      the 32-byte AES-256 key.
 * @param envelope the at-rest `{ ciphertext, iv, authTag, keyVersion }`.
 */
export function open(key: Uint8Array, envelope: SecretEnvelope): string {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes.`);
  }
  try {
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const authTag = base64ToBytes(envelope.authTag);
    // RE-CONCATENATE the noble `ciphertext ‖ tag` layout before decrypt.
    const sealed = concatBytes(ciphertext, authTag);
    const plaintext = gcm(key, iv).decrypt(sealed);
    return bytesToUtf8(plaintext);
  } catch {
    // Tag failure or wrong key — never leak the payload, the key, or the input.
    throw new Error(DECRYPT_ERROR_MESSAGE);
  }
}

/**
 * Seal raw bytes (rather than a UTF-8 string) under an AES-256-GCM key — the form the key-wrap
 * primitives need (wrapping a 32-byte DEK or private key). Same split discipline as {@link seal}.
 */
export function sealBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  keyVersion: number = CURRENT_KEY_VERSION,
): SecretEnvelope {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes.`);
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const sealed = gcm(key, iv).encrypt(plaintext);
  const ciphertext = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const authTag = sealed.subarray(sealed.length - GCM_TAG_BYTES);
  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    keyVersion,
  };
}

/**
 * Open an envelope back to raw bytes (the inverse of {@link sealBytes}). Re-concatenates and
 * decrypts; throws the same generic error on failure.
 */
export function openBytes(key: Uint8Array, envelope: SecretEnvelope): Uint8Array {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES key must be ${AES_KEY_BYTES} bytes.`);
  }
  try {
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    const authTag = base64ToBytes(envelope.authTag);
    const sealed = concatBytes(ciphertext, authTag);
    return gcm(key, iv).decrypt(sealed);
  } catch {
    throw new Error(DECRYPT_ERROR_MESSAGE);
  }
}
