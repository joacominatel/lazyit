import { describe, expect, it } from "bun:test";
import {
  CreateVaultMembershipSchema,
  UpdateVaultMembershipSchema,
  VaultMembershipSchema,
  WrappedDekSchema,
} from "./vault-membership";

const MEMBERSHIP_ID = "clmem0000000000000000000";
const VAULT_ID = "clvault00000000000000000";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ISO = "2026-06-13T00:00:00.000Z";
const EPH = "ZXBoZW1lcmFsUHViS2V5";
const NONCE = "d3JhcE5vbmNl";
const WRAPPED = "d3JhcHBlZERlaw==";

const wrap = {
  ephemeralPublicKey: EPH,
  wrapNonce: NONCE,
  wrappedDek: WRAPPED,
  wrapVersion: 1,
};

describe("WrappedDekSchema — the wrapped-DEK blob set", () => {
  it("accepts a base64 wrapped DEK", () => {
    expect(WrappedDekSchema.safeParse(wrap).success).toBe(true);
  });

  it("rejects a non-base64 wrappedDek", () => {
    expect(
      WrappedDekSchema.safeParse({ ...wrap, wrappedDek: "not base64!!" })
        .success,
    ).toBe(false);
  });
});

describe("VaultMembershipSchema — read shape (carries the wrapped DEK, never the clear DEK)", () => {
  it("accepts a membership row (createdAt + updatedAt, NO deletedAt)", () => {
    expect(
      VaultMembershipSchema.safeParse({
        id: MEMBERSHIP_ID,
        vaultId: VAULT_ID,
        userId: USER_ID,
        ...wrap,
        createdAt: ISO,
        updatedAt: ISO,
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid userId (the User is the uuid User)", () => {
    expect(
      VaultMembershipSchema.safeParse({
        id: MEMBERSHIP_ID,
        vaultId: VAULT_ID,
        userId: "clnot00000000000000000000",
        ...wrap,
        createdAt: ISO,
        updatedAt: ISO,
      }).success,
    ).toBe(false);
  });
});

describe("CreateVaultMembershipSchema — grant = post a wrapped DEK", () => {
  it("accepts a target userId + wrapped DEK", () => {
    expect(
      CreateVaultMembershipSchema.safeParse({ userId: USER_ID, ...wrap })
        .success,
    ).toBe(true);
  });

  it("rejects a missing wrapped-DEK field", () => {
    expect(
      CreateVaultMembershipSchema.safeParse({
        userId: USER_ID,
        ephemeralPublicKey: EPH,
        wrapNonce: NONCE,
        wrapVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a clear `dek` field (the server never receives an unwrapped DEK)", () => {
    expect(
      CreateVaultMembershipSchema.safeParse({
        userId: USER_ID,
        ...wrap,
        dek: "Y2xlYXJEZWs=",
      }).success,
    ).toBe(false);
  });
});

describe("UpdateVaultMembershipSchema — re-wrap on peer-reset", () => {
  it("accepts a fresh wrapped-DEK blob (no userId — identity is fixed)", () => {
    expect(UpdateVaultMembershipSchema.safeParse({ ...wrap }).success).toBe(
      true,
    );
  });

  it("rejects a userId in the body (the membership identity cannot change)", () => {
    expect(
      UpdateVaultMembershipSchema.safeParse({ ...wrap, userId: USER_ID })
        .success,
    ).toBe(false);
  });
});
