import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
} from "@lazyit/shared";

import { apiFetch } from "../client";

/**
 * Pure data-access for the local-mode password lifecycle (ADR-0086 §F4, F4b). The ONLY place the web
 * talks to `apiFetch` for these three routes; the hooks (../hooks/use-password-lifecycle.ts) wrap them
 * in TanStack mutations and the surfaces (profile panel, forced-change wall, forgot/reset pages)
 * consume the hooks. Routes mirror apps/api/src/auth/local/password-lifecycle.controller.ts.
 *
 * All three are meaningful only in AUTH_MODE=local; the API fails them closed in oidc/shim mode, and
 * the web only ever renders these surfaces when `authMode === "local"`, so the OIDC path is untouched.
 */

/**
 * Change your own password (`POST /auth/change-password`, authenticated human). Verifies the current
 * password, sets the new one, revokes OTHER sessions (epoch bump) and clears any forced-change flag.
 * Returns a FRESH session token minted at the new epoch — the caller must swap it into the Auth.js
 * session (see useChangePassword) or the next request 401s. The current session Bearer is attached
 * automatically by `apiFetch`.
 */
export function changePassword(
  body: ChangePasswordRequest,
): Promise<ChangePasswordResponse> {
  return apiFetch<ChangePasswordResponse>("/auth/change-password", {
    method: "POST",
    body,
  });
}

/**
 * Request a password-reset link (`POST /auth/forgot-password`, PUBLIC). Uniform response regardless of
 * whether the account exists (no user-enumeration) — the UI always shows the same confirmation. No
 * Bearer is sent (the endpoint is public).
 */
export function forgotPassword(
  body: ForgotPasswordRequest,
): Promise<ForgotPasswordResponse> {
  return apiFetch<ForgotPasswordResponse>("/auth/forgot-password", {
    method: "POST",
    body,
  });
}

/**
 * Reset a password with a token (`POST /auth/reset-password`, PUBLIC). Consumes the single-use token
 * from the emailed link and sets the new password; every invalid/expired/used token yields the same
 * generic error. No Bearer is sent (the endpoint is public).
 */
export function resetPassword(
  body: ResetPasswordRequest,
): Promise<ResetPasswordResponse> {
  return apiFetch<ResetPasswordResponse>("/auth/reset-password", {
    method: "POST",
    body,
  });
}
