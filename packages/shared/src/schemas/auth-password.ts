import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../constants/local-auth";
import { ZitadelPasswordSchema } from "./primitives";

/**
 * Local-mode password-lifecycle wire contracts — ADR-0086 §F4 (AUTH_MODE=local). Shared so the API's
 * DTOs and the F4b web forms validate ONE definition. Every *new* password is validated against the
 * SAME {@link ZitadelPasswordSchema} the first-run `/setup` and admin temp-password use (one strength
 * policy, no drift — see `password-policy.test.ts`). A *current* password is only length-bounded (it was
 * already accepted at set-time under whatever policy applied then, so re-imposing today's regex on it is
 * wrong; the KDF cap {@link PASSWORD_MAX_LENGTH} still applies as anti-DoS).
 */

/**
 * The machine-readable code the `mustChangePassword` enforcement gate returns (as a `403`) on every
 * non-exempt route until the user changes their one-time credential. The web (F4b) branches on this code
 * to render the forced-change screen. Kept here as the single source of truth for both sides.
 */
export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED" as const;

/**
 * Self-service change-password (`POST /auth/change-password`, authenticated human, local mode). The
 * server verifies `currentPassword` against the stored hash (generic 401 on mismatch), then sets
 * `newPassword`, bumps `sessionEpoch` (killing OTHER sessions), and clears `mustChangePassword`.
 */
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: ZitadelPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/**
 * The change-password response: a FRESH session token minted at the new `sessionEpoch`, so the caller who
 * just changed their own password stays logged in even though the epoch bump revoked their prior token.
 */
export const ChangePasswordResponseSchema = z.object({
  token: z.string().min(1),
});
export type ChangePasswordResponse = z.infer<
  typeof ChangePasswordResponseSchema
>;

/**
 * Forgot-password (`POST /auth/forgot-password`, PUBLIC, local mode). `identifier` is an email OR username
 * (resolved against the live user table). The response is ALWAYS the same uniform body regardless of
 * whether the account exists / an email was sent — NO user-enumeration (ADR-0086 §F4 / SECURITY GAP #7).
 */
export const ForgotPasswordRequestSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/** The uniform forgot-password response — identical whether or not the account exists (no enumeration). */
export const ForgotPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ForgotPasswordResponse = z.infer<
  typeof ForgotPasswordResponseSchema
>;

/**
 * Reset-password (`POST /auth/reset-password`, PUBLIC, local mode). `token` is the raw CSPRNG value from
 * the emailed link (the server stores only its SHA-256, single-use, ≤1h TTL). On success the server sets
 * `newPassword`, bumps `sessionEpoch`, consumes the token and invalidates the user's other reset tokens.
 * Every failure (unknown / expired / used token) is the SAME generic error — no oracle.
 */
export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: ZitadelPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/** The reset-password success response. */
export const ResetPasswordResponseSchema = z.object({
  ok: z.literal(true),
});
export type ResetPasswordResponse = z.infer<
  typeof ResetPasswordResponseSchema
>;
