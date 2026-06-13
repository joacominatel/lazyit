import { describe, expect, it } from "bun:test";
import {
  CreateSecretVaultSchema,
  SecretVaultSchema,
  UpdateSecretVaultSchema,
} from "./secret-vault";

const VAULT_ID = "clvault00000000000000000";
const ISO = "2026-06-13T00:00:00.000Z";

describe("SecretVaultSchema — read shape (metadata only)", () => {
  it("accepts a well-formed live vault row", () => {
    expect(
      SecretVaultSchema.safeParse({
        id: VAULT_ID,
        name: "Production",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(true);
  });

  it("accepts a soft-deleted vault (deletedAt set)", () => {
    expect(
      SecretVaultSchema.safeParse({
        id: VAULT_ID,
        name: "Production",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: ISO,
      }).success,
    ).toBe(true);
  });

  it("rejects a non-cuid id", () => {
    expect(
      SecretVaultSchema.safeParse({
        id: "not-a-cuid",
        name: "Production",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(
      SecretVaultSchema.safeParse({
        id: VAULT_ID,
        name: "",
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("CreateSecretVaultSchema — name-only, no DEK on the wire", () => {
  it("accepts a name", () => {
    expect(CreateSecretVaultSchema.safeParse({ name: "Vault A" }).success).toBe(
      true,
    );
  });

  it("trims the name", () => {
    const parsed = CreateSecretVaultSchema.parse({ name: "  Vault A  " });
    expect(parsed.name).toBe("Vault A");
  });

  it("rejects a blank name", () => {
    expect(CreateSecretVaultSchema.safeParse({ name: "   " }).success).toBe(
      false,
    );
  });

  it("rejects an extra field (strictObject — no DEK/ciphertext leaks onto the wire)", () => {
    expect(
      CreateSecretVaultSchema.safeParse({ name: "Vault A", dek: "YWJj" })
        .success,
    ).toBe(false);
  });
});

describe("UpdateSecretVaultSchema", () => {
  it("accepts a new name", () => {
    expect(UpdateSecretVaultSchema.safeParse({ name: "Renamed" }).success).toBe(
      true,
    );
  });

  it("rejects an empty body (name is required)", () => {
    expect(UpdateSecretVaultSchema.safeParse({}).success).toBe(false);
  });
});
