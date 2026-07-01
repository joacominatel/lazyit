import type {
  SendTestEmail,
  SendTestEmailResult,
  SmtpSettings,
  UpdateSmtpSettings,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Pure data-access functions for the instance SMTP settings (ADR-0079, #615) — the ONLY place that
 * talks to `apiFetch` for SMTP. Hooks (../hooks/use-smtp-settings.ts) wrap these in TanStack Query; the
 * Settings → Instance → SMTP editor consumes the hooks, never these directly (ADR-0020).
 *
 * Routes mirror apps/api/src/config (all gated `settings:manage`). The GET never 404s for "unset" — the
 * API returns an explicit disabled default (`enabled: false`) so the form always has a concrete shape to
 * render (the AssetTagScheme convention). The password is WRITE-ONLY: the read shape exposes only
 * `passwordSet`, never the value; the PUT keeps the stored password when `password` is omitted/empty.
 */
const BASE = "/config/smtp";

/**
 * Read the current SMTP settings (`GET /config/smtp`). Returns the persisted (redacted) row or — when
 * nothing was ever configured — an explicit disabled default. `settings:manage` (403 otherwise); the
 * password is never returned, only `passwordSet`.
 */
export function getSmtpSettings(signal?: AbortSignal): Promise<SmtpSettings> {
  return apiFetch<SmtpSettings>(BASE, { signal });
}

/**
 * Upsert the SMTP settings (`PUT /config/smtp`, `settings:manage`). The password is write-only: OMIT it
 * (or send empty) to keep the stored password, send a non-empty value to set/rotate it. Returns the
 * persisted (redacted) settings. 409 if a password is supplied while the server key `SMTP_SECRET_KEY` is
 * unset (its message explains the operator must set the key); 400 on a body the shared schema rejects.
 */
export function updateSmtpSettings(
  body: UpdateSmtpSettings,
): Promise<SmtpSettings> {
  return apiFetch<SmtpSettings>(BASE, { method: "PUT", body });
}

/**
 * Send a one-off test email (`POST /config/smtp/test`, `settings:manage`) using the CURRENTLY SAVED
 * config (save first, then test — email need not be enabled). Always HTTP 200: inspect `ok`; on failure
 * `error` is a short, non-secret message the editor surfaces.
 */
export function sendTestEmail(
  body: SendTestEmail,
): Promise<SendTestEmailResult> {
  return apiFetch<SendTestEmailResult>(`${BASE}/test`, {
    method: "POST",
    body,
  });
}
