/**
 * Round-trip + multi-member-grant tests for the Secret Manager client-side crypto orchestration
 * (ADR-0061, crypto-design §1/§2/§4/§6). Runs under `bun test` against the SOURCE crypto layer (the
 * tsconfig `paths` alias maps `@lazyit/shared/crypto` → source so bun loads it as ESM).
 *
 * The suite proves the four flows the contract guarantees and, crucially, the INV-10 discipline: the
 * produced wire DTOs carry ONLY base64 blobs + metadata — no passphrase, recovery key, private key, DEK,
 * or plaintext value. Argon2id runs for real here (m=64 MiB, t=3) so each `bootstrapKeypair` is ~sub-second
 * but not free; the suite keeps bootstraps to the minimum needed.
 */

import { expect, test } from "bun:test";
import {
  bootstrapKeypair,
  createVaultMaterial,
  openItem,
  sealItem,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  unwrapDekFromMembership,
  wrapDekForMember,
} from "./crypto";
import { getMyKeypair } from "./endpoints/keypair"; // import-only smoke (endpoints must compile/resolve)

/** Re-assemble a stored `UserKeypair` shape from a `CreateUserKeypair` wire DTO (server would add ids/dates). */
function asUserKeypair(
  wire: Awaited<ReturnType<typeof bootstrapKeypair>>["wire"],
) {
  return {
    id: "ckxtestkeypair000000000000",
    userId: "00000000-0000-4000-8000-000000000000",
    ...wire,
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    deletedAt: null,
  };
}

/** A wrapped-DEK membership shape (the four blob fields) from a `WrappedDek`. */
type Wrapped = ReturnType<typeof createVaultMaterial>["selfWrap"];

const PASSPHRASE = "correct horse battery staple";
const VALUE = "Pr0d-DB-root::s3cr3t!value/with+symbols";

test("bootstrap → unlockWithPassphrase recovers the same private key", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const keypair = asUserKeypair(wire);

  const priv = await unlockWithPassphrase(keypair, PASSPHRASE);
  expect(priv).toBeInstanceOf(Uint8Array);
  expect(priv.length).toBe(32);

  // Prove the unlocked private key matches the published public key via a wrap→unwrap self round-trip:
  // a DEK wrapped TO the published public key must unwrap with the unlocked private key.
  const material = createVaultMaterial(base64ToBytes(wire.publicKey));
  const dek = unwrapDekFromMembership(priv, material.selfWrap);
  expect(dek).toEqual(material.dek);
});

test("bootstrap → unlockWithRecoveryKey recovers the SAME private key as the passphrase path", async () => {
  const { wire, recoveryKeyDisplay } = await bootstrapKeypair(PASSPHRASE);
  const keypair = asUserKeypair(wire);

  const fromPass = await unlockWithPassphrase(keypair, PASSPHRASE);
  const fromRecovery = await unlockWithRecoveryKey(keypair, recoveryKeyDisplay);

  // Both unlock paths must yield the identical 32-byte X25519 private key (the double-wrap, §4).
  expect(fromRecovery).toEqual(fromPass);
  expect(fromRecovery.length).toBe(32);
});

test("createVaultMaterial → unwrapDekFromMembership(self) returns the same DEK", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const keypair = asUserKeypair(wire);
  const priv = await unlockWithPassphrase(keypair, PASSPHRASE);

  const { dek, selfWrap } = createVaultMaterial(base64ToBytes(wire.publicKey));
  const unwrapped = unwrapDekFromMembership(priv, selfWrap);
  expect(unwrapped).toEqual(dek);
  expect(unwrapped.length).toBe(32);
});

test("sealItem → openItem round-trips a value (and the envelope is base64-only ciphertext)", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const { dek } = createVaultMaterial(base64ToBytes(wire.publicKey));

  const envelope = sealItem(dek, VALUE);
  // Envelope is ciphertext + metadata ONLY — the plaintext must not appear anywhere in it.
  expect(envelope.ciphertext).not.toContain(VALUE);
  expect(JSON.stringify(envelope)).not.toContain(VALUE);
  expect(envelope.keyVersion).toBe(1);

  const recovered = openItem(dek, envelope);
  expect(recovered).toBe(VALUE);
});

test("multi-member grant: A grants B; B decrypts the value end-to-end", async () => {
  // --- A bootstraps and creates a vault ---
  const a = await bootstrapKeypair(PASSPHRASE);
  const aKeypair = asUserKeypair(a.wire);
  const aPriv = await unlockWithPassphrase(aKeypair, PASSPHRASE);
  const aPub = base64ToBytes(a.wire.publicKey);
  const { dek: vaultDek, selfWrap: aMembership } = createVaultMaterial(aPub);

  // A encrypts a secret item under the vault DEK.
  const item = sealItem(vaultDek, VALUE);

  // --- B bootstraps (distinct keypair) ---
  const b = await bootstrapKeypair("a different passphrase for B");
  const bKeypair = asUserKeypair(b.wire);
  const bPub = base64ToBytes(b.wire.publicKey);

  // --- A grants B: wrap the DEK to B's public key, using A's OWN membership (proof A can read it) ---
  const bMembership: Wrapped = wrapDekForMember(aPriv, aMembership, bPub);

  // --- B unlocks B's private key, unwraps the B-wrap, opens the item ---
  const bPriv = await unlockWithPassphrase(bKeypair, "a different passphrase for B");
  const bDek = unwrapDekFromMembership(bPriv, bMembership);
  expect(bDek).toEqual(vaultDek); // the granted member recovers the SAME DEK
  expect(openItem(bDek, item)).toBe(VALUE); // …and decrypts the original value
});

test("grant requires the granter's UNWRAPPED DEK: a non-member cannot wrap a vault", async () => {
  // A creates a vault; C is an outsider who holds A's membership blob but NOT A's private key.
  const a = await bootstrapKeypair(PASSPHRASE);
  const aPub = base64ToBytes(a.wire.publicKey);
  const { selfWrap: aMembership } = createVaultMaterial(aPub);

  const c = await bootstrapKeypair("outsider passphrase");
  const cKeypair = asUserKeypair(c.wire);
  const cPriv = await unlockWithPassphrase(cKeypair, "outsider passphrase");
  const target = await bootstrapKeypair("target passphrase");
  const targetPub = base64ToBytes(target.wire.publicKey);

  // C tries to grant using A's membership but C's OWN private key — C was never wrapped into the vault,
  // so the unwrap inside wrapDekForMember fails (no grant-what-you-can't-read).
  expect(() => wrapDekForMember(cPriv, aMembership, targetPub)).toThrow();
});

test("wrong passphrase throws a generic, payload-free error", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const keypair = asUserKeypair(wire);

  let caught: unknown;
  try {
    await unlockWithPassphrase(keypair, "WRONG passphrase");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  // The error must NOT leak the passphrase, the private key, or any blob bytes.
  expect(message).not.toContain("WRONG passphrase");
  expect(message).not.toContain(wire.privateKeyEncByPassphrase);
  expect(message).not.toContain(wire.passphraseSalt);
});

test("tampered ciphertext blob throws a generic, payload-free error", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const { dek } = createVaultMaterial(base64ToBytes(wire.publicKey));
  const envelope = sealItem(dek, VALUE);

  // Flip a byte in the ciphertext → GCM tag verification must fail.
  const tampered = {
    ...envelope,
    ciphertext: flipFirstChar(envelope.ciphertext),
  };
  let caught: unknown;
  try {
    openItem(dek, tampered);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).not.toContain(VALUE);
  // The generic decrypt message carries no key/plaintext (mirrors reveal()'s catch, §8).
  expect(message.toLowerCase()).toContain("decrypt");
});

test("wire DTO discipline (INV-10): bootstrap wire contains ONLY base64/metadata — no secret material", async () => {
  const { wire, recoveryKeyDisplay } = await bootstrapKeypair(PASSPHRASE);
  const serialized = JSON.stringify(wire);

  // The passphrase, recovery key, and any derived plaintext must be structurally ABSENT from the wire.
  expect(serialized).not.toContain(PASSPHRASE);
  expect(serialized).not.toContain(recoveryKeyDisplay);
  // The recovery key (sans hyphens) must also not leak.
  expect(serialized).not.toContain(recoveryKeyDisplay.replace(/-/g, ""));

  // Every blob field is non-empty base64; kdfParams is the FROZEN Argon2id set.
  for (const field of [
    wire.publicKey,
    wire.privateKeyEncByPassphrase,
    wire.passphraseSalt,
    wire.passphraseIv,
    wire.privateKeyEncByRecovery,
    wire.recoverySalt,
    wire.recoveryIv,
  ]) {
    expect(typeof field).toBe("string");
    expect(field.length).toBeGreaterThan(0);
    expect(isBase64(field)).toBe(true);
  }
  expect(wire.kdfParams).toEqual({
    alg: "argon2id",
    memorySize: 65536,
    iterations: 3,
    parallelism: 1,
    saltLength: 16,
    hashLength: 32,
    v: 1,
  });
});

test("wire DTO discipline (INV-10): a vault self-wrap + sealed item carry no DEK/value", async () => {
  const { wire } = await bootstrapKeypair(PASSPHRASE);
  const { dek, selfWrap } = createVaultMaterial(base64ToBytes(wire.publicKey));
  const item = sealItem(dek, VALUE);

  const dekBase64 = bytesToBase64(dek);
  // The wrapped membership must NOT contain the raw DEK bytes (it is the DEK ENCRYPTED to a pubkey).
  expect(JSON.stringify(selfWrap)).not.toContain(dekBase64);
  // The sealed item must NOT contain the plaintext or the raw DEK.
  const itemJson = JSON.stringify(item);
  expect(itemJson).not.toContain(VALUE);
  expect(itemJson).not.toContain(dekBase64);
  // Every membership/item field is base64/int metadata only.
  for (const field of [
    selfWrap.ephemeralPublicKey,
    selfWrap.wrapNonce,
    selfWrap.wrappedDek,
    item.ciphertext,
    item.iv,
    item.authTag,
  ]) {
    expect(isBase64(field)).toBe(true);
  }
  expect(typeof selfWrap.wrapVersion).toBe("number");
});

test("endpoint wrappers are import-resolvable (compile/runtime smoke)", () => {
  // The endpoint functions are thin fetch wrappers — assert they exist (not invoked; no server here).
  expect(typeof getMyKeypair).toBe("function");
});

// ---------------------------------------------------------------------------
// Local test helpers (no node:crypto / Buffer — match the browser/bun surface).
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary);
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Flip the first base64 character to a different one (a deterministic single-byte tamper). */
function flipFirstChar(b64: string): string {
  const first = b64[0];
  const replacement = first === "A" ? "B" : "A";
  return replacement + b64.slice(1);
}
