import { describe, expect, test } from "bun:test";
import {
  ConfigStatusSchema,
  IntegrationModeSchema,
  SetupAdminSchema,
  SetupPasswordSchema,
  SetupResultSchema,
} from "./config";

describe("IntegrationModeSchema", () => {
  test("accepts the two supported IdP modes", () => {
    expect(IntegrationModeSchema.parse("zitadel")).toBe("zitadel");
    expect(IntegrationModeSchema.parse("generic-oidc")).toBe("generic-oidc");
  });

  test("rejects an unknown mode", () => {
    expect(IntegrationModeSchema.safeParse("byoi").success).toBe(false);
  });
});

describe("ConfigStatusSchema", () => {
  test("accepts a well-formed status payload", () => {
    const parsed = ConfigStatusSchema.parse({
      isConfigured: false,
      adminCount: 0,
      integrationMode: "zitadel",
      devMode: true,
      csrfToken: "abc.def",
      requiresAdminPassword: true,
    });
    expect(parsed.isConfigured).toBe(false);
    expect(parsed.adminCount).toBe(0);
    expect(parsed.requiresAdminPassword).toBe(true);
  });

  test("rejects a negative adminCount and a missing csrfToken", () => {
    expect(
      ConfigStatusSchema.safeParse({
        isConfigured: true,
        adminCount: -1,
        integrationMode: "zitadel",
        devMode: false,
        csrfToken: "x",
        requiresAdminPassword: false,
      }).success,
    ).toBe(false);
    expect(
      ConfigStatusSchema.safeParse({
        isConfigured: true,
        adminCount: 1,
        integrationMode: "zitadel",
        devMode: false,
        csrfToken: "",
        requiresAdminPassword: false,
      }).success,
    ).toBe(false);
  });
});

describe("SetupPasswordSchema", () => {
  test("accepts a password meeting every rule", () => {
    expect(SetupPasswordSchema.parse("Abcdef1!")).toBe("Abcdef1!");
  });

  test("rejects when too short (< 8 chars)", () => {
    expect(SetupPasswordSchema.safeParse("Abc1!").success).toBe(false);
  });

  test("rejects when missing an uppercase letter", () => {
    expect(SetupPasswordSchema.safeParse("abcdef1!").success).toBe(false);
  });

  test("rejects when missing a lowercase letter", () => {
    expect(SetupPasswordSchema.safeParse("ABCDEF1!").success).toBe(false);
  });

  test("rejects when missing a digit", () => {
    expect(SetupPasswordSchema.safeParse("Abcdefg!").success).toBe(false);
  });

  test("rejects when missing a symbol", () => {
    expect(SetupPasswordSchema.safeParse("Abcdefg1").success).toBe(false);
  });

  test("rejects when longer than 70 characters", () => {
    // 71 chars that otherwise satisfy every complexity rule — the .max(70) cap must still reject it.
    const tooLong = "A1!" + "a".repeat(68);
    expect(tooLong.length).toBe(71);
    expect(SetupPasswordSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("SetupAdminSchema", () => {
  test("normalizes the email (trim + lowercase) and trims names", () => {
    const parsed = SetupAdminSchema.parse({
      email: "  Admin@Example.COM ",
      firstName: " Ada ",
      lastName: " Lovelace ",
    });
    expect(parsed.email).toBe("admin@example.com");
    expect(parsed.firstName).toBe("Ada");
    expect(parsed.lastName).toBe("Lovelace");
  });

  test("rejects an unknown key (e.g. a smuggled role) — strictObject", () => {
    expect(
      SetupAdminSchema.safeParse({
        email: "a@b.com",
        firstName: "Ada",
        lastName: "Lovelace",
        role: "ADMIN",
      }).success,
    ).toBe(false);
  });

  test("rejects empty names and a bad email", () => {
    expect(
      SetupAdminSchema.safeParse({
        email: "not-an-email",
        firstName: "Ada",
        lastName: "Lovelace",
      }).success,
    ).toBe(false);
    expect(
      SetupAdminSchema.safeParse({
        email: "a@b.com",
        firstName: "",
        lastName: "Lovelace",
      }).success,
    ).toBe(false);
  });
});

describe("SetupResultSchema", () => {
  test("accepts a successful setup result", () => {
    const parsed = SetupResultSchema.parse({
      success: true,
      adminId: "00000000-0000-0000-0000-000000000000",
      email: "admin@example.com",
      mirrored: false,
      setupCompletedAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.mirrored).toBe(false);
  });
});
