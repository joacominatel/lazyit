import { describe, expect, test } from "bun:test";
import { hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import {
  generateKeyPair,
  publicKeyFromSecret,
  unwrapDek,
  wrapDek,
  type WrappedDek,
} from "./keys";
import {
  CURRENT_WRAP_VERSION,
  DEK_BYTES,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
} from "./params";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("X25519 ECDH — RFC 7748 §6.1 known-answer vector", () => {
  // The canonical Alice/Bob test vector from RFC 7748 section 6.1.
  const ALICE_PRIV = hexToBytes(
    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  );
  const ALICE_PUB =
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  const BOB_PRIV = hexToBytes(
    "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  );
  const BOB_PUB =
    "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
  const SHARED =
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

  test("derives the RFC public keys", () => {
    expect(hex(publicKeyFromSecret(ALICE_PRIV))).toBe(ALICE_PUB);
    expect(hex(publicKeyFromSecret(BOB_PRIV))).toBe(BOB_PUB);
  });

  test("computes the RFC shared secret from both sides", () => {
    const ab = x25519.getSharedSecret(ALICE_PRIV, hexToBytes(BOB_PUB));
    const ba = x25519.getSharedSecret(BOB_PRIV, hexToBytes(ALICE_PUB));
    expect(hex(ab)).toBe(SHARED);
    expect(hex(ba)).toBe(SHARED);
  });
});

describe("generateKeyPair", () => {
  test("produces 32-byte keys that agree via ECDH", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.secretKey.length).toBe(X25519_SECRET_KEY_BYTES);
    expect(a.publicKey.length).toBe(X25519_PUBLIC_KEY_BYTES);
    const sa = x25519.getSharedSecret(a.secretKey, b.publicKey);
    const sb = x25519.getSharedSecret(b.secretKey, a.publicKey);
    expect(hex(sa)).toBe(hex(sb));
  });

  test("derives a matching public key from a secret key", () => {
    const kp = generateKeyPair();
    expect(hex(publicKeyFromSecret(kp.secretKey))).toBe(hex(kp.publicKey));
  });
});

describe("wrapDek / unwrapDek (the grant primitive)", () => {
  test("two parties agree: a member unwraps a DEK wrapped to their public key", () => {
    const member = generateKeyPair();
    const dek = new Uint8Array(DEK_BYTES);
    for (let i = 0; i < dek.length; i++) dek[i] = (i * 7) & 0xff;

    const wrapped = wrapDek(dek, member.publicKey);
    expect(wrapped.wrapVersion).toBe(CURRENT_WRAP_VERSION);
    const unwrapped = unwrapDek(wrapped, member.secretKey);
    expect([...unwrapped]).toEqual([...dek]);
  });

  test("each wrap uses a fresh ephemeral key + nonce (forward-secret wrap)", () => {
    const member = generateKeyPair();
    const dek = new Uint8Array(DEK_BYTES).fill(0x42);
    const w1 = wrapDek(dek, member.publicKey);
    const w2 = wrapDek(dek, member.publicKey);
    expect(w1.ephemeralPublicKey).not.toBe(w2.ephemeralPublicKey);
    expect(w1.wrapNonce).not.toBe(w2.wrapNonce);
    expect(w1.wrappedDek).not.toBe(w2.wrappedDek);
    // Both still unwrap to the same DEK.
    expect([...unwrapDek(w1, member.secretKey)]).toEqual([...dek]);
    expect([...unwrapDek(w2, member.secretKey)]).toEqual([...dek]);
  });

  test("a non-member (wrong secret key) cannot unwrap — throws, leaks nothing", () => {
    const member = generateKeyPair();
    const intruder = generateKeyPair();
    const dek = new Uint8Array(DEK_BYTES).fill(0x11);
    const wrapped = wrapDek(dek, member.publicKey);
    expect(() => unwrapDek(wrapped, intruder.secretKey)).toThrow(
      "authentication failed or wrong key",
    );
  });

  test("a tampered wrappedDek throws", () => {
    const member = generateKeyPair();
    const dek = new Uint8Array(DEK_BYTES).fill(0x99);
    const wrapped = wrapDek(dek, member.publicKey);
    const g = globalThis as unknown as {
      atob: (s: string) => string;
      btoa: (s: string) => string;
    };
    const raw = g.atob(wrapped.wrappedDek);
    const flipped =
      String.fromCharCode(raw.charCodeAt(0) ^ 0xff) + raw.slice(1);
    const tampered: WrappedDek = { ...wrapped, wrappedDek: g.btoa(flipped) };
    expect(() => unwrapDek(tampered, member.secretKey)).toThrow();
  });
});
