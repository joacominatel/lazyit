import { useMutation } from "@tanstack/react-query";
import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  ForgotPasswordRequest,
  ResetPasswordRequest,
} from "@lazyit/shared";

import {
  changePassword,
  forgotPassword,
  resetPassword,
} from "../endpoints/auth-password";

/**
 * TanStack mutation hooks for the local-mode password lifecycle (ADR-0086 §F4b). Thin wrappers over
 * the endpoint functions — the surfaces own their own onSuccess (toasts, the fresh-token session
 * swap, navigation). No query invalidation: none of these mutate cached list/detail reads.
 *
 * NB: these mutations deliberately do NOT flow through the global MutationCache auth-expiry / password-
 * change interception in a harmful way — change-password itself is exempt from the forced-change gate
 * server-side, and forgot/reset are public. See handle-password-change-required.ts.
 */

/**
 * Change the caller's own password (`POST /auth/change-password`). Resolves with a FRESH session token
 * the caller MUST swap into the Auth.js session (the epoch bump invalidated the old token). The
 * consuming component does the swap via `useSession().update` + `setSessionToken` in its onSuccess.
 */
export function useChangePassword() {
  return useMutation<ChangePasswordResponse, unknown, ChangePasswordRequest>({
    mutationFn: (body) => changePassword(body),
    // Opt OUT of the global MutationCache auth-expiry / forced-change interception (providers.tsx reads
    // this meta): a wrong CURRENT password returns a 401 that must surface inline on the form, never as
    // a session sign-out; and change-password is itself exempt from the forced-change gate server-side.
    meta: { skipGlobalAuthHandling: true },
  });
}

/** Request a reset link (`POST /auth/forgot-password`, public). Uniform outcome — never enumerates. */
export function useForgotPassword() {
  return useMutation<{ ok: true }, unknown, ForgotPasswordRequest>({
    mutationFn: (body) => forgotPassword(body),
  });
}

/** Reset a password with a token (`POST /auth/reset-password`, public). */
export function useResetPassword() {
  return useMutation<{ ok: true }, unknown, ResetPasswordRequest>({
    mutationFn: (body) => resetPassword(body),
  });
}
