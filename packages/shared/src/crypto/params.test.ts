import { describe, expect, test } from "bun:test";
import { hexToBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  AES_KEY_BYTES,
  ARGON2ID_PARAMS,
  CURRENT_KEY_VERSION,
  CURRENT_WRAP_VERSION,
  DEK_BYTES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  HKDF_INFO_DEK_WRAP,
  HKDF_INFO_RECOVERY_WRAP,
  X25519_PUBLIC_KEY_BYTES,
  X25519_SECRET_KEY_BYTES,
} from "./params";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("ARGON2ID_PARAMS (FROZEN — spec §0/§10)", () => {
  test("matches the ratified OWASP/RFC 9106 interactive baseline", () => {
    expect(ARGON2ID_PARAMS).toEqual({
      alg: "argon2id",
      memorySize: 65536,
      iterations: 3,
      parallelism: 1,
      saltLength: 16,
      hashLength: 32,
      v: 1,
    });
  });
});

describe("byte-length pins", () => {
  test("are the spec-pinned values", () => {
    expect(AES_KEY_BYTES).toBe(32);
    expect(GCM_IV_BYTES).toBe(12);
    expect(GCM_TAG_BYTES).toBe(16);
    expect(X25519_PUBLIC_KEY_BYTES).toBe(32);
    expect(X25519_SECRET_KEY_BYTES).toBe(32);
    expect(DEK_BYTES).toBe(32);
    expect(CURRENT_KEY_VERSION).toBe(1);
    expect(CURRENT_WRAP_VERSION).toBe(1);
  });
});

describe("HKDF info strings (domain separation)", () => {
  test("are the exact spec-pinned values", () => {
    expect(HKDF_INFO_DEK_WRAP).toBe("lazyit/vault-dek-wrap/v1");
    expect(HKDF_INFO_RECOVERY_WRAP).toBe("lazyit/recovery-wrap/v1");
  });

  test("differ, so the same shared secret never derives the same key across contexts", () => {
    expect(HKDF_INFO_DEK_WRAP).not.toBe(HKDF_INFO_RECOVERY_WRAP);
  });
});

describe("HKDF-SHA256 — RFC 5869 Test Case 1 (known-answer)", () => {
  test("derives the RFC OKM", () => {
    const ikm = hexToBytes("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
    const salt = hexToBytes("000102030405060708090a0b0c");
    const info = hexToBytes("f0f1f2f3f4f5f6f7f8f9");
    const okm = hkdf(sha256, ikm, salt, info, 42);
    expect(hex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });
});
