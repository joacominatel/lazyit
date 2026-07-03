import { describe, expect, test } from "bun:test";
import {
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  PASSWORD_CHANGE_REQUIRED_CODE,
  ResetPasswordRequestSchema,
} from "./auth-password";

// ADR-0086 §F4 (F4a) — the local-mode password-lifecycle wire contracts. The *new* password on both
// change + reset must satisfy the SAME Zitadel-default strength as `/setup` (delegated to
// ZitadelPasswordSchema); a *current* password is only length-bounded.
describe("auth-password schemas (ADR-0086 §F4)", () => {
  test("PASSWORD_CHANGE_REQUIRED_CODE is the stable gate code", () => {
    expect(PASSWORD_CHANGE_REQUIRED_CODE).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  describe("ChangePasswordRequestSchema", () => {
    test("accepts a strong new password", () => {
      expect(
        ChangePasswordRequestSchema.safeParse({
          currentPassword: "whatever-old",
          newPassword: "Abcdef1!",
        }).success,
      ).toBe(true);
    });

    test("rejects a weak new password (policy)", () => {
      expect(
        ChangePasswordRequestSchema.safeParse({
          currentPassword: "whatever-old",
          newPassword: "weak",
        }).success,
      ).toBe(false);
    });

    test("rejects an empty current password", () => {
      expect(
        ChangePasswordRequestSchema.safeParse({
          currentPassword: "",
          newPassword: "Abcdef1!",
        }).success,
      ).toBe(false);
    });
  });

  describe("ForgotPasswordRequestSchema", () => {
    test("trims the identifier and requires non-empty", () => {
      expect(
        ForgotPasswordRequestSchema.parse({ identifier: "  a@b.co " })
          .identifier,
      ).toBe("a@b.co");
      expect(
        ForgotPasswordRequestSchema.safeParse({ identifier: "   " }).success,
      ).toBe(false);
    });
  });

  describe("ForgotPasswordResponseSchema", () => {
    test("is the uniform { ok: true } body", () => {
      expect(ForgotPasswordResponseSchema.parse({ ok: true }).ok).toBe(true);
    });
  });

  describe("ResetPasswordRequestSchema", () => {
    test("requires a token and a strong new password", () => {
      expect(
        ResetPasswordRequestSchema.safeParse({
          token: "raw-token",
          newPassword: "Abcdef1!",
        }).success,
      ).toBe(true);
      expect(
        ResetPasswordRequestSchema.safeParse({
          token: "",
          newPassword: "Abcdef1!",
        }).success,
      ).toBe(false);
      expect(
        ResetPasswordRequestSchema.safeParse({
          token: "raw-token",
          newPassword: "weak",
        }).success,
      ).toBe(false);
    });
  });
});
