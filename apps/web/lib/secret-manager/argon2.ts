/**
 * Argon2id — the passphrase → private-key-wrapping-key KDF (ADR-0061 §3, crypto-design §1/§4 Copy A).
 *
 * This is lazyit's ONLY memory-hard KDF and the single weakest link in the zero-knowledge envelope: a
 * member's vault passphrase is human-chosen (low entropy), so the at-rest `privateKeyEncByPassphrase`
 * blob must be guarded by a memory-hard KDF to make offline brute-force of a stolen blob ruinously
 * expensive. WebCrypto's only password-KDF is PBKDF2 (NOT memory-hard, GPU/ASIC-cheap), so Argon2id
 * comes from `hash-wasm` — hand-tuned WebAssembly that runs in the browser, in Bun, and in Node, with
 * the `.wasm` base64-inlined (no separate asset, validated by the #366 spike).
 *
 * The FROZEN parameters (`ARGON2ID_PARAMS` — m=64 MiB, t=3, p=1, 16-byte salt, 32-byte out) live in
 * `@lazyit/shared/crypto` so the client and any future re-derivation agree byte-for-byte; a mismatch
 * would make a stored blob undecryptable. This wrapper reads them from that single source of truth and
 * never re-states them.
 *
 * INV-10 discipline: the passphrase and the derived wrapping key are EPHEMERAL — present only in this
 * browser call, never persisted, never logged, never sent to the server. Callers drop the derived key
 * after the one AES-GCM wrap/unwrap that consumes it (see `crypto.ts`).
 */

import { ARGON2ID_PARAMS } from "@lazyit/shared/crypto";
import { argon2id } from "hash-wasm";

/**
 * Derive the 32-byte AES-256 wrapping key from a vault passphrase and its (clear, per-keypair) salt,
 * using Argon2id with the FROZEN `ARGON2ID_PARAMS`. Returns RAW key bytes (`outputType: "binary"`),
 * never a PHC-encoded verifier string — this derives a *wrapping key*, it does not *verify a password*.
 *
 * @param passphrase the user's vault passphrase (UTF-8 string; never persisted, never logged).
 * @param salt       the 16-byte CSPRNG salt stored in clear on the `UserKeypair` (`passphraseSalt`).
 * @returns          a 32-byte (256-bit) AES key, in browser memory only — drop it after use.
 */
export async function deriveKeyArgon2id(
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (salt.length !== ARGON2ID_PARAMS.saltLength) {
    throw new Error(
      `Argon2id salt must be ${ARGON2ID_PARAMS.saltLength} bytes.`,
    );
  }
  const key = await argon2id({
    password: passphrase,
    salt,
    iterations: ARGON2ID_PARAMS.iterations,
    parallelism: ARGON2ID_PARAMS.parallelism,
    memorySize: ARGON2ID_PARAMS.memorySize,
    hashLength: ARGON2ID_PARAMS.hashLength,
    // Raw 32-byte derived key (a wrapping key), NOT a PHC-encoded verifier string.
    outputType: "binary",
  });
  // `outputType: "binary"` guarantees a Uint8Array; the union return type is narrowed here.
  return key as Uint8Array;
}
