/**
 * lazyit-fetch — the CLIENT-SIDE decrypt chain (ADR-0080, extends ADR-0061). This is the ONE place OUTSIDE
 * the browser that turns a service-account token + the server's CIPHERTEXT into plaintext. The API is a
 * ciphertext custodian and NEVER runs any of this (INV-10) — the token-derived KEK, and every unwrap, live
 * here.
 *
 * THE CHAIN (mirrors the human read chain of `apps/web/lib/secret-manager/crypto.ts`, but keyed to the SA
 * token instead of a human passphrase):
 *
 *   token ──Argon2id(salt, kdfParams)──▶ KEK
 *   KEK   ──AES-256-GCM open───────────▶ SA X25519 private key   (from keypair.privateKeyEnc)
 *   priv  ──X25519 unwrapDek───────────▶ vault DEK               (from membership, the DEK wrapped to the SA)
 *   DEK   ──AES-256-GCM open───────────▶ each item's plaintext value
 *
 * We REUSE the shipped, merge-gated `@lazyit/shared/crypto` primitives (`open`/`openBytes`/`unwrapDek`) so
 * the CLI can NEVER drift from what the browser produced — NEVER hand-roll crypto. Argon2id comes from
 * `hash-wasm` (the same WASM the browser uses), driven with the STORED `kdfParams` from the fetch response
 * so a future parameter bump stays decryptable.
 */

import { argon2id } from "hash-wasm";
import {
  ARGON2ID_PARAMS,
  generateKeyPair,
  open,
  openBytes,
  seal,
  sealBytes,
  unwrapDek,
  wrapDek,
  type SecretEnvelope,
  type WrappedDek,
} from "@lazyit/shared/crypto";
import type { KdfParamsShape, ServiceAccountVaultFetch } from "@lazyit/shared";

/** GCM auth-tag length in bytes (the trailing 16 bytes of a joined `ciphertext ‖ tag` blob). */
const GCM_TAG_BYTES = 16;

// ── base64 <-> bytes (the CLI runs on Bun/Node, so `Buffer` is available; the shared leaf can't use it) ──

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Split a joined `ciphertext ‖ tag` blob (the one-column wrapped-private-key form) + its separate IV into a
 * {@link SecretEnvelope} (the inverse of the browser's `joinSealedBlob`). `keyVersion` is metadata only
 * (GCM does not use it to decrypt), so any value round-trips.
 */
function envelopeFromBlob(
  blobB64: string,
  ivB64: string,
  keyVersion = 1,
): SecretEnvelope {
  const bytes = b64ToBytes(blobB64);
  const ct = bytes.subarray(0, bytes.length - GCM_TAG_BYTES);
  const tag = bytes.subarray(bytes.length - GCM_TAG_BYTES);
  return {
    ciphertext: bytesToB64(ct),
    iv: ivB64,
    authTag: bytesToB64(tag),
    keyVersion,
  };
}

/** Join a split envelope's `ciphertext` + `authTag` into the single `ciphertext ‖ tag` blob (for the self-check). */
function joinBlob(envelope: SecretEnvelope): string {
  const ct = b64ToBytes(envelope.ciphertext);
  const tag = b64ToBytes(envelope.authTag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  return bytesToB64(joined);
}

/**
 * Derive the 32-byte AES KEK from the SA token via Argon2id, using the STORED KDF params (robust to a
 * future parameter bump — the CLI re-derives with exactly what the browser wrapped under). The token plays
 * the role the human vault passphrase plays; it is the only credential and is never sent anywhere except
 * the Authorization header of the (authenticated) fetch request.
 */
export async function deriveKek(
  token: string,
  saltB64: string,
  kdf: KdfParamsShape,
): Promise<Uint8Array> {
  const key = await argon2id({
    password: token,
    salt: b64ToBytes(saltB64),
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    memorySize: kdf.memorySize,
    hashLength: kdf.hashLength,
    // Raw 32-byte wrapping key, NOT a PHC verifier string.
    outputType: "binary",
  });
  return key as Uint8Array;
}

/** Unlock the SA's X25519 private key from the token-derived KEK (AES-256-GCM open over the wrapped blob). */
export function unlockPrivateKey(
  kek: Uint8Array,
  keypair: { privateKeyEnc: string; privateKeyIv: string },
): Uint8Array {
  return openBytes(
    kek,
    envelopeFromBlob(keypair.privateKeyEnc, keypair.privateKeyIv),
  );
}

/**
 * The FULL decrypt of a headless fetch response → a `{ handle: plaintext }` map. Runs the whole chain
 * locally; the returned plaintext never leaves this process except as the caller chooses to emit it. A
 * wrong token, a tampered blob, or a private key that was never wrapped into a membership throws the
 * generic, payload-free decrypt error (no key/plaintext in the message).
 */
export async function decryptVault(
  token: string,
  fetched: ServiceAccountVaultFetch,
): Promise<Record<string, string>> {
  const kek = await deriveKek(
    token,
    fetched.keypair.privateKeySalt,
    fetched.keypair.kdfParams,
  );
  const privateKey = unlockPrivateKey(kek, fetched.keypair);
  const dek = unwrapDek(fetched.membership as WrappedDek, privateKey);
  const out: Record<string, string> = {};
  for (const item of fetched.items) {
    out[item.handle] = open(dek, {
      ciphertext: item.ciphertext,
      iv: item.iv,
      authTag: item.authTag,
      keyVersion: item.keyVersion,
    });
  }
  return out;
}

/**
 * The built-in SELF-CHECK (`lazyit-fetch --self-check`). Runs the ENTIRE token → KEK → private-key → DEK →
 * value chain end-to-end WITHOUT a server: it wraps a private key under a token-derived KEK exactly as the
 * browser does, wraps a DEK to the SA public key, seals a value under the DEK, then decrypts it back with
 * {@link decryptVault} and asserts the plaintext round-trips. If this passes, the CLI's crypto agrees with
 * the shipped `@lazyit/shared/crypto` primitives byte-for-byte. Throws on any mismatch.
 */
export async function selfCheck(): Promise<void> {
  const token = "lzit_sa_selfcheck_" + "A".repeat(43);
  const expected = "s3cr3t-value-ñ"; // include a non-ASCII char to exercise UTF-8

  // 1. Wrap a fresh X25519 private key under Argon2id(token) — the SA keypair the browser would upload.
  const kp = generateKeyPair();
  const salt = crypto.getRandomValues(
    new Uint8Array(ARGON2ID_PARAMS.saltLength),
  );
  const saltB64 = bytesToB64(salt);
  const kek = await deriveKek(token, saltB64, ARGON2ID_PARAMS);
  const sealedPriv = sealBytes(kek, kp.secretKey);

  // 2. Wrap a fresh DEK to the SA public key, and seal a value under that DEK.
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = wrapDek(dek, kp.publicKey);
  const itemEnvelope = seal(dek, expected);

  // 3. Assemble the exact fetch wire shape the server would return, then decrypt it back.
  const fetched: ServiceAccountVaultFetch = {
    vaultId: "cselfcheck0000000000000000",
    keypair: {
      privateKeyEnc: joinBlob(sealedPriv),
      privateKeySalt: saltB64,
      privateKeyIv: sealedPriv.iv,
      kdfParams: { ...ARGON2ID_PARAMS },
    },
    membership: wrapped,
    items: [
      {
        handle: "self-check-secret",
        label: "Self-check secret",
        kind: "GENERIC",
        ...itemEnvelope,
      },
    ],
  };

  const out = await decryptVault(token, fetched);
  if (out["self-check-secret"] !== expected) {
    throw new Error("self-check FAILED: decrypted value did not round-trip");
  }
}
