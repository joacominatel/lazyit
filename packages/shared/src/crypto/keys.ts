/**
 * X25519 keypairs + the DEK wrap/unwrap "grant" primitive (spec §2) — pure, framework-agnostic.
 *
 * Wrapping a DEK to a recipient's public key is ECIES-style over X25519:
 *   wrap   = fresh ephemeral keypair → ECDH with recipient pub → HKDF-SHA256(info=DEK-wrap) → AES-GCM
 *   unwrap = ECDH(recipient priv, ephemeral pub) → same HKDF → AES-GCM-decrypt
 *
 * HKDF is MANDATORY (spec §2): the raw X25519 shared secret is NEVER fed to AES-GCM directly. The
 * `info` string ({@link HKDF_INFO_DEK_WRAP}) domain-separates this wrap from every other ECDH use.
 *
 * Crypto enforcement of "no grant-what-you-can't-read" (INV-9 twin / INV-10): you can only WRAP a DEK
 * you can already UNWRAP — the server cannot mint a wrapped DEK, and an ADMIN never wrapped into a
 * vault cannot conjure one. That property is structural; this module only provides the primitives.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { openBytes, sealBytes, type SecretEnvelope } from "./aead";
import {
  AES_KEY_BYTES,
  CURRENT_WRAP_VERSION,
  DEK_BYTES,
  HKDF_INFO_DEK_WRAP,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
} from "./params";

/** An X25519 keypair (32-byte secret + 32-byte public), raw bytes. */
export interface X25519KeyPair {
  /** 32-byte X25519 secret key — NEVER stored in clear; wrapped at rest (spec §4). */
  secretKey: Uint8Array;
  /** 32-byte X25519 public key — stored in clear (DEKs are wrapped to it). */
  publicKey: Uint8Array;
}

/**
 * A DEK wrapped to a recipient's public key — the at-rest blob on a `VaultMembership` row (spec §2).
 * `ephemeralPublicKey`, `wrapNonce`, and `wrappedDek` are base64; `wrapVersion` is an integer.
 * None of it discloses the DEK without the recipient's private key.
 */
export interface WrappedDek {
  /** base64 ephemeral X25519 public key (32B) used for this wrap. */
  ephemeralPublicKey: string;
  /** base64 AES-GCM nonce (12B) for the wrap. */
  wrapNonce: string;
  /** base64 AES-GCM ciphertext ‖ tag of the wrapped DEK. */
  wrappedDek: string;
  /** Wrap version stamp (see spec §3 keyVersion semantics). */
  wrapVersion: number;
}

/** Generate a fresh X25519 keypair (CSPRNG via noble's cross-platform randomness). */
export function generateKeyPair(): X25519KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

/** Derive the X25519 public key for a given secret key (spec §3). */
export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== X25519_SECRET_KEY_BYTES) {
    throw new Error(`X25519 secret key must be ${X25519_SECRET_KEY_BYTES} bytes.`);
  }
  return x25519.getPublicKey(secretKey);
}

/**
 * Expand a raw X25519 shared secret into a 32-byte AES key-encryption-key (KEK) via HKDF-SHA256 with
 * the DEK-wrap domain separator. Internal — never feed the raw shared secret to AES-GCM (spec §2).
 */
function deriveDekWrapKek(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    sharedSecret,
    undefined, // salt = ∅ (spec §2 step 3)
    utf8ToBytes(HKDF_INFO_DEK_WRAP),
    AES_KEY_BYTES,
  );
}

/**
 * Wrap a 32-byte DEK to a recipient's X25519 public key (spec §2, the "grant" primitive). Draws a
 * fresh ephemeral keypair per call → forward-secrecy of the wrap and a unique KEK/nonce per
 * `VaultMembership` row. The output is safe for the server to store — only the recipient's private
 * key can unwrap it.
 *
 * @param dek          the 32-byte vault DEK to wrap.
 * @param recipientPublicKey the recipient's 32-byte X25519 public key.
 */
export function wrapDek(
  dek: Uint8Array,
  recipientPublicKey: Uint8Array,
): WrappedDek {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes.`);
  }
  if (recipientPublicKey.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new Error(`Recipient public key must be ${X25519_PUBLIC_KEY_BYTES} bytes.`);
  }
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, recipientPublicKey);
  const kek = deriveDekWrapKek(shared);
  // Reuse the AEAD envelope (same split discipline), then re-shape to the wrapped-DEK blob columns.
  const envelope = sealBytes(kek, dek, CURRENT_WRAP_VERSION);
  return {
    ephemeralPublicKey: toBase64(ephemeral.publicKey),
    wrapNonce: envelope.iv,
    wrappedDek: joinCipherAndTag(envelope),
    wrapVersion: envelope.keyVersion,
  };
}

/**
 * Unwrap a {@link WrappedDek} with the recipient's X25519 secret key (spec §2). Mirrors {@link wrapDek}:
 * ECDH(secret, ephemeralPub) → same HKDF KEK → AES-GCM-decrypt. A wrong key or any tamper throws the
 * generic, payload-free decrypt error (§8).
 *
 * @param wrapped          the at-rest wrapped-DEK blob.
 * @param recipientSecretKey the recipient's 32-byte X25519 secret key.
 */
export function unwrapDek(
  wrapped: WrappedDek,
  recipientSecretKey: Uint8Array,
): Uint8Array {
  if (recipientSecretKey.length !== X25519_SECRET_KEY_BYTES) {
    throw new Error(`Recipient secret key must be ${X25519_SECRET_KEY_BYTES} bytes.`);
  }
  const ephemeralPublicKey = fromBase64(wrapped.ephemeralPublicKey);
  const shared = x25519.getSharedSecret(recipientSecretKey, ephemeralPublicKey);
  const kek = deriveDekWrapKek(shared);
  const { ciphertext, authTag } = splitCipherAndTag(wrapped.wrappedDek);
  return openBytes(kek, {
    ciphertext,
    iv: wrapped.wrapNonce,
    authTag,
    keyVersion: wrapped.wrapVersion,
  });
}

// ---------------------------------------------------------------------------
// Local base64 + envelope re-shaping helpers. A WrappedDek stores `wrappedDek`
// as a single ciphertext‖tag base64 string (matching the §2 blob), whereas the
// AEAD layer works in the split {ciphertext, authTag} form — we bridge here.
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  btoa?: (data: string) => string;
  atob?: (data: string) => string;
};

function toBase64(bytes: Uint8Array): string {
  if (typeof g.btoa !== "function") {
    throw new Error("base64 encoder unavailable in this environment.");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return g.btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
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

/** Join a split envelope's `ciphertext` + `authTag` into the single ciphertext‖tag base64 blob. */
function joinCipherAndTag(envelope: SecretEnvelope): string {
  const ct = fromBase64(envelope.ciphertext);
  const tag = fromBase64(envelope.authTag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  return toBase64(joined);
}

/** Split a single ciphertext‖tag base64 blob back into the `{ ciphertext, authTag }` base64 pair. */
function splitCipherAndTag(blob: string): { ciphertext: string; authTag: string } {
  const bytes = fromBase64(blob);
  const ct = bytes.subarray(0, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  return { ciphertext: toBase64(ct), authTag: toBase64(tag) };
}
