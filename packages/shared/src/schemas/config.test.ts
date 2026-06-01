import { describe, expect, test } from "bun:test";
import {
  ConfigStatusSchema,
  IntegrationModeSchema,
  SetupAdminSchema,
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
    });
    expect(parsed.isConfigured).toBe(false);
    expect(parsed.adminCount).toBe(0);
  });

  test("rejects a negative adminCount and a missing csrfToken", () => {
    expect(
      ConfigStatusSchema.safeParse({
        isConfigured: true,
        adminCount: -1,
        integrationMode: "zitadel",
        devMode: false,
        csrfToken: "x",
      }).success,
    ).toBe(false);
    expect(
      ConfigStatusSchema.safeParse({
        isConfigured: true,
        adminCount: 1,
        integrationMode: "zitadel",
        devMode: false,
        csrfToken: "",
      }).success,
    ).toBe(false);
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
