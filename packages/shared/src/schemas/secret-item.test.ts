import { describe, expect, it } from "bun:test";
import {
  CreateSecretItemSchema,
  SecretEnvelopeSchema,
  SecretItemSchema,
  UpdateSecretItemSchema,
} from "./secret-item";

const ITEM_ID = "clitem000000000000000000";
const VAULT_ID = "clvault00000000000000000";
const ISO = "2026-06-13T00:00:00.000Z";
// Valid base64 blobs (the at-rest envelope columns).
const CIPHERTEXT = "Y2lwaGVydGV4dA==";
const IV = "aXZpdml2aXZpdg==";
const AUTHTAG = "YXV0aFRhZ2F1dGhUYWc=";

const envelope = {
  ciphertext: CIPHERTEXT,
  iv: IV,
  authTag: AUTHTAG,
  keyVersion: 1,
};

describe("SecretEnvelopeSchema — WorkflowSecret-mirroring shape", () => {
  it("accepts a base64 envelope with keyVersion ≥ 1", () => {
    expect(SecretEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects a non-base64 ciphertext", () => {
    expect(
      SecretEnvelopeSchema.safeParse({ ...envelope, ciphertext: "not base64!!" })
        .success,
    ).toBe(false);
  });

  it("rejects keyVersion < 1", () => {
    expect(
      SecretEnvelopeSchema.safeParse({ ...envelope, keyVersion: 0 }).success,
    ).toBe(false);
  });
});

describe("SecretItemSchema — read shape INCLUDES the envelope (client decrypts)", () => {
  it("accepts a full item row with metadata + ciphertext", () => {
    expect(
      SecretItemSchema.safeParse({
        id: ITEM_ID,
        vaultId: VAULT_ID,
        handle: "prod_db_root",
        label: "Production DB root password",
        ...envelope,
        kind: "GENERIC",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a missing ciphertext (the read shape carries the blob)", () => {
    expect(
      SecretItemSchema.safeParse({
        id: ITEM_ID,
        vaultId: VAULT_ID,
        handle: "prod_db_root",
        label: "Production DB root password",
        iv: IV,
        authTag: AUTHTAG,
        keyVersion: 1,
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("CreateSecretItemSchema — client posts metadata + sealed envelope", () => {
  it("accepts metadata + a base64 envelope", () => {
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "prod_db_root",
        label: "Production DB root password",
        ...envelope,
      }).success,
    ).toBe(true);
  });

  it("rejects a plaintext `value` field (no plaintext ever transits the server)", () => {
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "prod_db_root",
        label: "Production DB root password",
        ...envelope,
        value: "hunter2",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing envelope field", () => {
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "prod_db_root",
        label: "Production DB root password",
        ciphertext: CIPHERTEXT,
        iv: IV,
        keyVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts an explicit typed kind, and omitting kind is valid (ADR-0075)", () => {
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "host_key",
        label: "Host SSH key",
        kind: "SSH_KEY",
        ...envelope,
      }).success,
    ).toBe(true);
    // kind is optional on the wire (the service fills GENERIC) — omitting it is accepted.
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "legacy",
        label: "Legacy plain value",
        ...envelope,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown kind value", () => {
    expect(
      CreateSecretItemSchema.safeParse({
        handle: "x",
        label: "x",
        kind: "PASSWORD",
        ...envelope,
      }).success,
    ).toBe(false);
  });
});

describe("UpdateSecretItemSchema — partial metadata / re-encrypted value", () => {
  it("accepts a label-only edit", () => {
    expect(
      UpdateSecretItemSchema.safeParse({ label: "Renamed" }).success,
    ).toBe(true);
  });

  it("accepts a full re-encrypted envelope", () => {
    expect(UpdateSecretItemSchema.safeParse({ ...envelope }).success).toBe(true);
  });

  it("rejects an unknown field (strictObject)", () => {
    expect(
      UpdateSecretItemSchema.safeParse({ label: "x", value: "y" }).success,
    ).toBe(false);
  });
});
