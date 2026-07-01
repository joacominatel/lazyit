import { z } from "zod";

/**
 * Instance SMTP settings — the single source of truth for `api` (config store + validation) and
 * `web` (the Settings → Instance → SMTP form) of the outbound-email connection (issue #615, ADR-0079).
 *
 * SMTP is INSTANCE CONFIGURATION, following the singleton `AssetTagScheme` precedent (ADR-0063): ONE
 * admin-only row, gated by `settings:manage`. It unlocks an EMAIL CHANNEL behind the existing in-app
 * notification bell (ADR-0056) — a curated set of operational nudges is also emailed when email is
 * enabled. Delivery rides the BullMQ/Valkey worker layer (ADR-0053), fail-soft: an email failure never
 * blocks the notification or the originating request.
 *
 * SECRET DISCIPLINE (INV-6-style, mirrors the WorkflowSecret write-only shape): the SMTP password is a
 * SERVER-MANAGED machine credential (the server MUST read it to authenticate against the relay — the
 * explicit inverse of the zero-knowledge Secret Manager, INV-10). It is encrypted at rest (AES-256-GCM
 * under `SMTP_SECRET_KEY`) and is WRITE-ONLY on the wire: the read shape exposes only `passwordSet`
 * (configured yes/no), never the ciphertext or the cleartext.
 */

/**
 * The transport security mode. Deliberately a small closed set (no free-form `secure`/`tls` booleans on
 * the wire) so the web can render a clear radio and the api maps each mode to nodemailer unambiguously:
 *   - `none`     — plaintext SMTP, no TLS (port 25 on a trusted internal network). nodemailer:
 *                  `secure:false, ignoreTLS:true`.
 *   - `starttls` — plaintext connect then upgrade to TLS via STARTTLS (port 587, most providers).
 *                  nodemailer: `secure:false, requireTLS:true` (fails cleanly if the server can't upgrade).
 *   - `tls`      — implicit TLS from the first byte (port 465). nodemailer: `secure:true`.
 */
export const SMTP_SECURITY_MODES = ["none", "starttls", "tls"] as const;
export const SmtpSecuritySchema = z.enum(SMTP_SECURITY_MODES);
export type SmtpSecurity = z.infer<typeof SmtpSecuritySchema>;

/**
 * The REDACTED read shape returned by `GET /config/smtp` — the write-only projection of the settings row
 * (never carries the password). `passwordSet` is the "a password is configured" signal (mirrors the
 * WorkflowSecret `configured` descriptor). When no row has ever been written the api returns an explicit
 * DISABLED default (enabled false, empty fields) — never a 404 — so the form always renders a concrete
 * shape (the AssetTagScheme convention).
 */
export const SmtpSettingsSchema = z.object({
  /** Master switch for OUTBOUND EMAIL. When false, no notification is ever emailed (test still works). */
  enabled: z.boolean(),
  /** SMTP relay hostname. Null until configured. */
  host: z.string().nullable(),
  /** SMTP relay port (1–65535). Null until configured. */
  port: z.number().int().min(1).max(65535).nullable(),
  /** Transport security mode. */
  security: SmtpSecuritySchema,
  /** SMTP auth username. Null when the relay is open/unauthenticated on a trusted network. */
  username: z.string().nullable(),
  /** Whether an encrypted password is stored (write-only: the value itself is NEVER returned). */
  passwordSet: z.boolean(),
  /** Envelope From address (the address messages are sent from). Null until configured. */
  fromAddress: z.string().nullable(),
  /** Optional human display name for the From header (e.g. "lazyit"). */
  fromName: z.string().nullable(),
  /**
   * TLS cert verification. Default true (secure): reject a relay whose certificate can't be verified.
   * An admin may set false to allow a self-signed cert on a self-hosted relay (opt-in insecurity).
   */
  rejectUnauthorized: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SmtpSettings = z.infer<typeof SmtpSettingsSchema>;

/**
 * The `PUT /config/smtp` write shape. Wholesale upsert of the config fields. The PASSWORD is write-only:
 *   - OMITTED (or empty string) → the stored password is LEFT UNCHANGED (so re-saving the form after a
 *     read — which never receives the password — does not wipe it).
 *   - a non-empty string → the new password is encrypted and stored (set/rotate).
 * There is no "clear password" affordance in v1 (a rare need — flip to an open relay by nulling
 * `username`; the api only sends `auth` when a username is present). See ADR-0079 forks.
 *
 * Host/port/fromAddress are optional-nullable so a half-filled draft can be saved with `enabled:false`;
 * the api refuses to send (and the test refuses to run) until host + port + fromAddress are present.
 */
export const UpdateSmtpSettingsSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  security: SmtpSecuritySchema,
  username: z.string().trim().max(255).nullish(),
  /** Write-only: omitted/empty keeps the stored password; a non-empty value sets/rotates it. */
  password: z.string().max(1024).optional(),
  fromAddress: z.email().max(255).nullish(),
  fromName: z.string().trim().max(255).nullish(),
  rejectUnauthorized: z.boolean(),
});
export type UpdateSmtpSettings = z.infer<typeof UpdateSmtpSettingsSchema>;

/**
 * `POST /config/smtp/test` body — send a real one-off test email to `to`, using the CURRENTLY SAVED
 * config (the admin saves first, then tests). Runs inline (not queued) so the admin gets immediate
 * pass/fail feedback.
 */
export const SendTestEmailSchema = z.object({
  to: z.email(),
});
export type SendTestEmail = z.infer<typeof SendTestEmailSchema>;

/**
 * `POST /config/smtp/test` response — a clean pass/fail. On failure `error` is a short, non-secret
 * message (e.g. "connection refused", "authentication failed") the form surfaces; it never carries the
 * password or raw stack detail.
 */
export const SendTestEmailResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type SendTestEmailResult = z.infer<typeof SendTestEmailResultSchema>;
