/**
 * Round-trip + defensive-parse tests for the typed-secret codec (ADR-0075). Proves: (1) GENERIC is a
 * passthrough plain string (back-compat — never JSON-wrapped), (2) each typed kind survives an
 * encode→parse round-trip, (3) optional empty fields are dropped on encode, and (4) the parser NEVER
 * throws — a legacy/mismatched value under a typed `kind` degrades to a GENERIC raw payload.
 */

import { expect, test } from "bun:test";
import {
  encodeSecretPayload,
  parseSecretPayload,
  type TypedSecret,
} from "./typed-secret";

test("GENERIC is a plain-string passthrough (NOT JSON-wrapped)", () => {
  const encoded = encodeSecretPayload({ kind: "GENERIC", value: "s3cr3t!" });
  expect(encoded).toBe("s3cr3t!");
  expect(parseSecretPayload("GENERIC", encoded)).toEqual({
    kind: "GENERIC",
    value: "s3cr3t!",
  });
});

test("SSH_KEY round-trips and drops empty optionals", () => {
  const payload: TypedSecret = {
    kind: "SSH_KEY",
    value: { privateKey: "-----BEGIN-----\nabc\n-----END-----", passphrase: "" },
  };
  const encoded = encodeSecretPayload(payload);
  // Empty passphrase dropped.
  expect(JSON.parse(encoded)).toEqual({
    privateKey: "-----BEGIN-----\nabc\n-----END-----",
  });
  expect(parseSecretPayload("SSH_KEY", encoded)).toEqual({
    kind: "SSH_KEY",
    value: { privateKey: "-----BEGIN-----\nabc\n-----END-----" },
  });
});

test("TOTP round-trips with numeric digits/period", () => {
  const payload: TypedSecret = {
    kind: "TOTP",
    value: {
      secret: "GEZDGNBVGY3TQOJQ",
      issuer: "Acme",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    },
  };
  const encoded = encodeSecretPayload(payload);
  expect(parseSecretPayload("TOTP", encoded)).toEqual(payload);
});

test("CERTIFICATE round-trips", () => {
  const payload: TypedSecret = {
    kind: "CERTIFICATE",
    value: { certificate: "CERT", chain: "CHAIN" },
  };
  const encoded = encodeSecretPayload(payload);
  expect(parseSecretPayload("CERTIFICATE", encoded)).toEqual(payload);
});

test("legacy GENERIC value under a typed kind degrades to raw (never throws)", () => {
  // A plain (non-JSON) value that the row's kind now claims is SSH_KEY — must not throw.
  const parsed = parseSecretPayload("SSH_KEY", "plain-legacy-value");
  expect(parsed).toEqual({ kind: "GENERIC", value: "plain-legacy-value" });
});

test("JSON missing the required field degrades to raw", () => {
  const parsed = parseSecretPayload("TOTP", JSON.stringify({ issuer: "Acme" }));
  expect(parsed.kind).toBe("GENERIC");
});
