import { describe, expect, test } from "bun:test";
import { ChangePasswordResponseSchema } from "./auth-password";
import { LoginRequestSchema, LoginResponseSchema } from "./auth-login";

// ADR-0086 §3 + §8 (#1307) — the local login contract. `rememberMe` is optional and defaults to false so
// an older client that never sends it keeps the default 12h session; `expiresAt` tells the web when the
// minted token stops being accepted by time (`null` = "keep me signed in", no time-based expiry).
describe("auth-login schemas (ADR-0086 §3/§8)", () => {
  const credentials = { identifier: "alice@example.com", password: "pw" };
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Smith",
    username: "alice",
    role: "MEMBER",
  };

  describe("LoginRequestSchema.rememberMe", () => {
    test("defaults to false when omitted (older clients keep today's behavior)", () => {
      const parsed = LoginRequestSchema.parse(credentials);
      expect(parsed.rememberMe).toBe(false);
    });

    test("accepts an explicit true", () => {
      expect(
        LoginRequestSchema.parse({ ...credentials, rememberMe: true })
          .rememberMe,
      ).toBe(true);
    });

    test("accepts an explicit false", () => {
      expect(
        LoginRequestSchema.parse({ ...credentials, rememberMe: false })
          .rememberMe,
      ).toBe(false);
    });

    test("rejects a non-boolean (a form string is never coerced)", () => {
      expect(
        LoginRequestSchema.safeParse({ ...credentials, rememberMe: "true" })
          .success,
      ).toBe(false);
      expect(
        LoginRequestSchema.safeParse({ ...credentials, rememberMe: 1 }).success,
      ).toBe(false);
    });
  });

  describe("LoginResponseSchema.expiresAt", () => {
    test("accepts an epoch-seconds expiry", () => {
      expect(
        LoginResponseSchema.safeParse({
          token: "t",
          expiresAt: 1_900_000_000,
          user,
        }).success,
      ).toBe(true);
    });

    test("accepts null (no time-based expiry)", () => {
      expect(
        LoginResponseSchema.safeParse({ token: "t", expiresAt: null, user })
          .success,
      ).toBe(true);
    });

    test("rejects a missing or non-integer expiry", () => {
      expect(
        LoginResponseSchema.safeParse({ token: "t", user }).success,
      ).toBe(false);
      expect(
        LoginResponseSchema.safeParse({ token: "t", expiresAt: 1.5, user })
          .success,
      ).toBe(false);
    });
  });

  describe("ChangePasswordResponseSchema.expiresAt", () => {
    test("carries the re-minted token's expiry, null included", () => {
      expect(
        ChangePasswordResponseSchema.safeParse({ token: "t", expiresAt: null })
          .success,
      ).toBe(true);
      expect(
        ChangePasswordResponseSchema.safeParse({
          token: "t",
          expiresAt: 1_900_000_000,
        }).success,
      ).toBe(true);
      expect(ChangePasswordResponseSchema.safeParse({ token: "t" }).success).toBe(
        false,
      );
    });
  });
});
