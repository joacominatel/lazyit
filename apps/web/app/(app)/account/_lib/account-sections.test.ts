import { describe, expect, test } from "bun:test";
import {
  accountSections,
  activeAccountSection,
  passwordOwner,
  toThemeChoice,
} from "./account-sections";

const keys = (ctx: Parameters<typeof accountSections>[0]) =>
  accountSections(ctx).map((s) => s.key);

describe("accountSections", () => {
  test("everyone sees overview, profile and notifications", () => {
    expect(keys({ aiStatusAvailable: false })).toEqual([
      "overview",
      "profile",
      "notifications",
    ]);
  });

  test("AI needs only a live /ai/status, not ai:connect (AUD-083)", () => {
    expect(keys({ aiStatusAvailable: false })).not.toContain("ai");
    expect(keys({ aiStatusAvailable: true })).toEqual([
      "overview",
      "profile",
      "notifications",
      "ai",
    ]);
  });
});

describe("activeAccountSection", () => {
  test("exact matches", () => {
    expect(activeAccountSection("/account")).toBe("overview");
    expect(activeAccountSection("/profile")).toBe("profile");
    expect(activeAccountSection("/account/notifications")).toBe("notifications");
    expect(activeAccountSection("/account/ai")).toBe("ai");
  });

  test("a trailing slash and nested paths resolve to their section", () => {
    expect(activeAccountSection("/account/")).toBe("overview");
    expect(activeAccountSection("/account/ai/")).toBe("ai");
    expect(activeAccountSection("/account/ai/tokens")).toBe("ai");
  });

  test("the overview never swallows an unknown child, and prefixes respect segments", () => {
    expect(activeAccountSection("/account/unknown")).toBeNull();
    expect(activeAccountSection("/accounting")).toBeNull();
    expect(activeAccountSection("/profiles")).toBeNull();
    expect(activeAccountSection("/dashboard")).toBeNull();
  });

  test("a hidden section is not active", () => {
    const visible = accountSections({ aiStatusAvailable: false });
    expect(activeAccountSection("/account/ai", visible)).toBeNull();
  });
});

describe("passwordOwner", () => {
  test("maps authMode", () => {
    expect(passwordOwner("local")).toBe("lazyit");
    expect(passwordOwner("oidc")).toBe("identity-provider");
  });

  test("an older API (no authMode) or an unknown value is unknown", () => {
    expect(passwordOwner(undefined)).toBe("unknown");
    expect(passwordOwner(null)).toBe("unknown");
    expect(passwordOwner("saml")).toBe("unknown");
  });
});

describe("toThemeChoice", () => {
  test("keeps a known choice and falls back to system", () => {
    expect(toThemeChoice("dark")).toBe("dark");
    expect(toThemeChoice("light")).toBe("light");
    expect(toThemeChoice("system")).toBe("system");
    expect(toThemeChoice(undefined)).toBe("system");
    expect(toThemeChoice("sepia")).toBe("system");
  });
});
