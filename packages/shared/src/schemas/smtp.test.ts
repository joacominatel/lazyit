import { describe, expect, test } from "bun:test";
import {
  SMTP_SECURITY_MODES,
  SendTestEmailSchema,
  SmtpSecuritySchema,
  SmtpSettingsSchema,
  UpdateSmtpSettingsSchema,
} from "./smtp";

// Instance SMTP settings (issue #615, ADR-0079). These guard the WIRE shapes `api` (config store) and
// `web` (the Settings → Instance → SMTP form) agree on — most importantly the WRITE-ONLY password.

describe("SMTP security modes (closed set)", () => {
  test("the enum mirrors SMTP_SECURITY_MODES exactly", () => {
    expect(SmtpSecuritySchema.options).toEqual([...SMTP_SECURITY_MODES]);
  });
  test("rejects an unknown mode", () => {
    expect(SmtpSecuritySchema.safeParse("ssl").success).toBe(false);
  });
});

describe("SmtpSettings read shape is write-only (no password)", () => {
  test("has passwordSet, NEVER a password field", () => {
    const shape = SmtpSettingsSchema.shape;
    expect("passwordSet" in shape).toBe(true);
    expect("password" in shape).toBe(false);
  });

  test("accepts a fully-configured redacted row", () => {
    const parsed = SmtpSettingsSchema.safeParse({
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "mailer@example.com",
      passwordSet: true,
      fromAddress: "it@example.com",
      fromName: "lazyit",
      rejectUnauthorized: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("UpdateSmtpSettings write shape", () => {
  test("password is optional (omit keeps the stored value)", () => {
    const parsed = UpdateSmtpSettingsSchema.safeParse({
      enabled: false,
      security: "starttls",
      rejectUnauthorized: true,
    });
    expect(parsed.success).toBe(true);
  });

  test("a non-empty password is accepted (set/rotate)", () => {
    const parsed = UpdateSmtpSettingsSchema.safeParse({
      enabled: true,
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      username: "u",
      password: "s3cret",
      fromAddress: "it@example.com",
      rejectUnauthorized: false,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an out-of-range port and a non-email from address", () => {
    expect(
      UpdateSmtpSettingsSchema.safeParse({
        enabled: true,
        port: 70000,
        security: "none",
        rejectUnauthorized: true,
      }).success,
    ).toBe(false);
    expect(
      UpdateSmtpSettingsSchema.safeParse({
        enabled: true,
        security: "none",
        fromAddress: "not-an-email",
        rejectUnauthorized: true,
      }).success,
    ).toBe(false);
  });
});

describe("SendTestEmail", () => {
  test("requires a valid email address", () => {
    expect(SendTestEmailSchema.safeParse({ to: "a@b.co" }).success).toBe(true);
    expect(SendTestEmailSchema.safeParse({ to: "nope" }).success).toBe(false);
  });
});
