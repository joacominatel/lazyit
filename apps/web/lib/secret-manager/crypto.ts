/**
 * Secret Manager — client-side crypto orchestration (ADR-0061, crypto-design §1/§2/§4/§6).
 *
 * This module COMPOSES the already-shipped `@lazyit/shared/crypto` primitives into the end-to-end
 * zero-knowledge flows the UI (slice 3b) and the KB chip (slice 4) consume. It is pure async TypeScript
 * — NO React, NO DOM beyond `crypto.getRandomValues` (which `@noble`'s `randomBytes` uses internally and
 * which is available in the browser and in Bun). The Argon2id WASM is the only non-pure dependency and
 * is isolated in `argon2.ts`.
 *
 * THE ZERO-KNOWLEDGE LINE (INV-10) lives here. Every function below treats the vault passphrase, the
 * recovery key, the unwrapped X25519 private key, the unwrapped vault DEK, and every plaintext value as
 * EPHEMERAL browser-only material: they are produced/consumed transiently, dropped after use, NEVER
 * placed in a return value that flows to the server, a React Query cache key, localStorage, or a log.
 * The functions return EITHER the at-rest wire DTOs (base64 blobs + metadata the server stores) OR the
 * transient secret bytes the CALLER holds in local memory — never both crossing a server boundary.
 *
 * THE READ CHAIN (crypto-design §6), each step a function here:
 *   unlock private key  → unwrap vault DEK from your membership → decrypt the item ciphertext.
 *
 * Private-key-at-rest DOUBLE WRAP (crypto-design §4): the 32-byte X25519 private key is sealed TWICE,
 * independently, so losing one unlock path is survivable —
 *   Copy A under  Argon2id(passphrase)  → `privateKeyEncByPassphrase` (memory-hard; low-entropy input)
 *   Copy B under  HKDF(recoveryKeyBytes) → `privateKeyEncByRecovery`   (fast KDF; high-entropy input)
 *
 * GRANT = wrap-to-pubkey (crypto-design §2, ADR §4 "no grant-what-you-can't-read"): {@link wrapDekForMember}
 * FIRST unwraps the DEK from the granter's own membership (proving the granter can read the vault), THEN
 * wraps that DEK to the target's public key. You cannot grant what you cannot unwrap — enforced here in
 * code, not just at the authorization layer.
 */

import type { CreateUserKeypair, UserKeypair } from "@lazyit/shared";
import {
  type SecretEnvelope,
  type WrappedDek,
  ARGON2ID_PARAMS,
  HKDF_INFO_RECOVERY_WRAP,
  generateKeyPair,
  generateRecoveryKey,
  open,
  openBytes,
  recoveryKeyToBytes,
  seal,
  sealBytes,
  unwrapDek,
  wrapDek,
} from "@lazyit/shared/crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { deriveKeyArgon2id } from "./argon2";

/** AES-256 key length — the seal key and the DEK are both 32 bytes. */
const AES_KEY_BYTES = 32;
/** Vault DEK length (a 256-bit symmetric key). */
const DEK_BYTES = 32;
/** Salt length for the Argon2id passphrase wrap and the HKDF recovery wrap (clear, per derivation). */
const SALT_BYTES = ARGON2ID_PARAMS.saltLength; // 16

// ---------------------------------------------------------------------------
// base64 <-> bytes (no Buffer / node:crypto — same defensive pattern as the
// shared crypto leaf; `btoa`/`atob` exist in the browser, Node 16+, and Bun).
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  btoa?: (data: string) => string;
  atob?: (data: string) => string;
};

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
 * Join a {@link SecretEnvelope}'s split `ciphertext` + `authTag` into the single `ciphertext ‖ tag`
 * base64 blob stored in a one-column wrapped-private-key field (`privateKeyEncBy…`). The IV is stored
 * SEPARATELY (its own DTO column), so it is not part of this blob.
 */
function joinSealedBlob(envelope: SecretEnvelope): string {
  const ct = base64ToBytes(envelope.ciphertext);
  const tag = base64ToBytes(envelope.authTag);
  const joined = new Uint8Array(ct.length + tag.length);
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  return bytesToBase64(joined);
}

/**
 * Rebuild a {@link SecretEnvelope} from a stored `ciphertext ‖ tag` blob + its separate base64 IV — the
 * inverse of {@link joinSealedBlob}. Splits off the trailing 16-byte GCM tag so `openBytes` can verify.
 */
function envelopeFromBlob(blob: string, ivBase64: string): SecretEnvelope {
  const bytes = base64ToBytes(blob);
  const ct = bytes.subarray(0, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  return {
    ciphertext: bytesToBase64(ct),
    iv: ivBase64,
    authTag: bytesToBase64(tag),
    keyVersion: ARGON2ID_PARAMS.v,
  };
}

/**
 * Derive the HKDF-SHA256 wrapping key for the recovery-key copy of the private key (crypto-design §4
 * Copy B). The recovery key is HIGH-entropy (125-bit Crockford-base32), so a fast KDF (HKDF) is correct;
 * Argon2id is reserved for the low-entropy passphrase. The `info` string domain-separates this wrap.
 */
function deriveRecoveryWrapKey(
  recoveryKeyBytes: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  return hkdf(
    sha256,
    recoveryKeyBytes,
    salt,
    utf8ToBytes(HKDF_INFO_RECOVERY_WRAP),
    AES_KEY_BYTES,
  );
}

/**
 * The result of {@link bootstrapKeypair}: the wire DTO to POST, plus the recovery-key DISPLAY string.
 * The display string is shown to the user EXACTLY ONCE (the service-account shown-once precedent) and
 * MUST be dropped immediately after — never persisted, never logged, never sent to the server. The
 * server stores only the recovery-key-WRAPPED private-key blob inside `wire`.
 */
export interface BootstrappedKeypair {
  /** The `CreateUserKeypair` DTO — base64 blobs + metadata ONLY. Safe to POST to `/secret-manager/keypair`. */
  wire: CreateUserKeypair;
  /** The recovery key as `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` — SHOWN ONCE, NEVER persisted/logged/sent. */
  recoveryKeyDisplay: string;
}

/**
 * Bootstrap a brand-new user keypair (ADR §3, crypto-design §4). Runs entirely in the browser:
 *   1. generate a fresh X25519 keypair;
 *   2. generate a fresh recovery key (shown once);
 *   3. seal the private key under Argon2id(passphrase) → Copy A;
 *   4. seal the private key under HKDF(recoveryKeyBytes) → Copy B;
 *   5. assemble the `CreateUserKeypair` wire DTO (public key in clear + both wrapped blobs + salts/IVs).
 *
 * The passphrase, the recovery key, the two derived wrapping keys, and the unwrapped private key are all
 * EPHEMERAL — none of them appears in `wire`. Only the public key and the two AES-GCM-sealed private-key
 * copies (with their clear salts/IVs) are returned for the server to store.
 *
 * @param passphrase the user's chosen vault passphrase (UTF-8; never persisted/logged/sent).
 */
export async function bootstrapKeypair(
  passphrase: string,
): Promise<BootstrappedKeypair> {
  const keyPair = generateKeyPair();
  const recovery = generateRecoveryKey();

  // Copy A — Argon2id(passphrase) over the private key.
  const passphraseSalt = randomBytes(SALT_BYTES);
  const passphraseKey = await deriveKeyArgon2id(passphrase, passphraseSalt);
  const sealedByPassphrase = sealBytes(passphraseKey, keyPair.secretKey);

  // Copy B — HKDF(recoveryKeyBytes) over the same private key.
  const recoverySalt = randomBytes(SALT_BYTES);
  const recoveryKey = deriveRecoveryWrapKey(recovery.bytes, recoverySalt);
  const sealedByRecovery = sealBytes(recoveryKey, keyPair.secretKey);

  const wire: CreateUserKeypair = {
    publicKey: bytesToBase64(keyPair.publicKey),
    privateKeyEncByPassphrase: joinSealedBlob(sealedByPassphrase),
    passphraseSalt: bytesToBase64(passphraseSalt),
    passphraseIv: sealedByPassphrase.iv,
    kdfParams: {
      alg: ARGON2ID_PARAMS.alg,
      memorySize: ARGON2ID_PARAMS.memorySize,
      iterations: ARGON2ID_PARAMS.iterations,
      parallelism: ARGON2ID_PARAMS.parallelism,
      saltLength: ARGON2ID_PARAMS.saltLength,
      hashLength: ARGON2ID_PARAMS.hashLength,
      v: ARGON2ID_PARAMS.v,
    },
    privateKeyEncByRecovery: joinSealedBlob(sealedByRecovery),
    recoverySalt: bytesToBase64(recoverySalt),
    recoveryIv: sealedByRecovery.iv,
  };

  return { wire, recoveryKeyDisplay: recovery.display };
}

/**
 * Unlock the X25519 private key from the passphrase-wrapped copy (Copy A). Re-derives the Argon2id
 * wrapping key from the stored `passphraseSalt`, then AES-GCM-decrypts `privateKeyEncByPassphrase`.
 * A wrong passphrase or a tampered blob throws the generic, payload-free decrypt error (no plaintext,
 * no key material in the message).
 *
 * @returns the 32-byte X25519 private key — browser memory only; the caller drops it after use.
 */
export async function unlockWithPassphrase(
  keypair: UserKeypair,
  passphrase: string,
): Promise<Uint8Array> {
  const salt = base64ToBytes(keypair.passphraseSalt);
  const wrappingKey = await deriveKeyArgon2id(passphrase, salt);
  const envelope = envelopeFromBlob(
    keypair.privateKeyEncByPassphrase,
    keypair.passphraseIv,
  );
  return openBytes(wrappingKey, envelope);
}

/**
 * Unlock the X25519 private key from the recovery-key-wrapped copy (Copy B). Decodes the displayed
 * recovery key to its canonical bytes, re-derives the HKDF wrapping key from the stored `recoverySalt`,
 * then AES-GCM-decrypts `privateKeyEncByRecovery`. A wrong recovery key or a tampered blob throws the
 * generic, payload-free decrypt error.
 *
 * @param recoveryKey the displayed `XXXXX-…` recovery key (with or without hyphens).
 * @returns the 32-byte X25519 private key — browser memory only; the caller drops it after use.
 */
export async function unlockWithRecoveryKey(
  keypair: UserKeypair,
  recoveryKey: string,
): Promise<Uint8Array> {
  const recoveryKeyBytes = recoveryKeyToBytes(recoveryKey);
  const salt = base64ToBytes(keypair.recoverySalt);
  const wrappingKey = deriveRecoveryWrapKey(recoveryKeyBytes, salt);
  const envelope = envelopeFromBlob(
    keypair.privateKeyEncByRecovery,
    keypair.recoveryIv,
  );
  return openBytes(wrappingKey, envelope);
}

/**
 * The material produced when creating a vault (crypto-design §3): the freshly-generated DEK (browser
 * memory only — never sent) and the creator's SELF-WRAP of that DEK to their own public key, which IS
 * the wire shape posted as the creator's first `VaultMembership`.
 */
export interface VaultMaterial {
  /** The 32-byte vault DEK — EPHEMERAL browser material; NEVER sent to the server in clear. */
  dek: Uint8Array;
  /** The DEK wrapped to the creator's own public key — base64 blobs + metadata, safe to POST. */
  selfWrap: WrappedDek;
}

/**
 * Create the crypto material for a new vault (ADR §2/§3): generate a fresh 256-bit DEK in the browser
 * and wrap it to the creator's OWN public key (their first membership). The creator must post `selfWrap`
 * as the vault's initial membership; the raw `dek` stays in browser memory only (to encrypt the first
 * items) and is dropped after.
 *
 * @param myPublicKey the creator's 32-byte X25519 public key (raw bytes).
 */
export function createVaultMaterial(myPublicKey: Uint8Array): VaultMaterial {
  const dek = randomBytes(DEK_BYTES);
  const selfWrap = wrapDek(dek, myPublicKey);
  return { dek, selfWrap };
}

/**
 * Unwrap the vault DEK from the caller's own `VaultMembership` row (crypto-design §2/§6 step 2), using
 * their unlocked X25519 private key. This is the bridge between "I can unlock my private key" and "I can
 * read this vault". A tampered blob or a private key that was never wrapped into this membership throws
 * the generic decrypt error.
 *
 * @param privateKey the caller's unlocked 32-byte X25519 private key.
 * @param membership the caller's wrapped-DEK blob set (`ephemeralPublicKey`/`wrapNonce`/`wrappedDek`/`wrapVersion`).
 * @returns the 32-byte vault DEK — browser memory only; drop it after use.
 */
export function unwrapDekFromMembership(
  privateKey: Uint8Array,
  membership: WrappedDek,
): Uint8Array {
  return unwrapDek(membership, privateKey);
}

/**
 * Seal a plaintext secret value under the vault DEK (crypto-design §3) → the at-rest `SecretEnvelope`
 * (`{ ciphertext, iv, authTag, keyVersion }`, byte-identical to `WorkflowSecret`). The plaintext never
 * leaves this call; only the ciphertext envelope is returned for the server to store.
 *
 * @param dek   the unwrapped 32-byte vault DEK.
 * @param value the UTF-8 plaintext value to encrypt.
 */
export function sealItem(dek: Uint8Array, value: string): SecretEnvelope {
  return seal(dek, value);
}

/**
 * Open a `SecretItem`'s at-rest envelope back to its UTF-8 plaintext value (crypto-design §3/§6 step 3),
 * using the unwrapped vault DEK. GCM verifies the tag; any tamper or wrong DEK throws the generic,
 * payload-free decrypt error. The returned plaintext is browser-only — never cache or log it.
 *
 * @param dek  the unwrapped 32-byte vault DEK.
 * @param item the at-rest envelope (`{ ciphertext, iv, authTag, keyVersion }`).
 */
export function openItem(dek: Uint8Array, item: SecretEnvelope): string {
  return open(dek, item);
}

/**
 * The GRANT primitive (crypto-design §2, ADR §4 "no grant-what-you-can't-read"). To add a member you
 * must yourself be able to READ the vault: this FIRST unwraps the DEK from the granter's own membership
 * (proving the granter holds it), THEN wraps that DEK to the target member's public key. The fresh
 * ephemeral keypair inside `wrapDek` gives a unique wrap per row. The returned `WrappedDek` is the wire
 * shape posted as the target's new `VaultMembership` — base64 blobs + metadata only.
 *
 * The DEK is unwrapped transiently inside this function and never returned — the only outputs are the
 * granter's (already-stored) membership and the new wrapped blob for the target.
 *
 * @param myPrivateKey    the granter's unlocked 32-byte X25519 private key.
 * @param myMembership    the granter's own wrapped-DEK blob set (their proof they can read the vault).
 * @param targetPublicKey the target member's 32-byte X25519 public key (raw bytes).
 */
export function wrapDekForMember(
  myPrivateKey: Uint8Array,
  myMembership: WrappedDek,
  targetPublicKey: Uint8Array,
): WrappedDek {
  // "Only grant what you can unwrap": unwrap FIRST (throws if the granter cannot read the vault).
  const dek = unwrapDek(myMembership, myPrivateKey);
  return wrapDek(dek, targetPublicKey);
}
