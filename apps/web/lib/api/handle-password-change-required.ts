/**
 * Global reaction to the forced-password-change gate (ADR-0086 §F4b, control 2).
 *
 * In AUTH_MODE=local a user holding a one-time credential (admin-set temp password, or a
 * `mustChangePassword` flag) is walled off by the API's `MustChangePasswordGuard`: EVERY non-exempt
 * route returns `403 { code: 'PASSWORD_CHANGE_REQUIRED' }` until they rotate it. The exempt routes are
 * `POST /auth/change-password` (the escape hatch) and `GET /users/me` — everything else is refused.
 *
 * This is the UX half of that enforcement: on the FIRST such 403 from `apiFetch`, hard-navigate the
 * user to the blocking `/change-password` wall (a full-page `window.location.assign`, not a soft SPA
 * push — they must not be able to click past it). Wired once into the TanStack QueryCache/MutationCache
 * `onError` in providers.tsx, exactly like {@link handleAuthExpiry} does for a 401.
 *
 * OIDC/shim mode: the guard never fires there (the flag only exists in local mode), so this code path
 * is inert — no gating, byte-identical behaviour.
 *
 * Idempotency / loop-guard, mirroring handle-auth-expiry:
 *   (1) latch on a module-level flag so a burst of concurrent 403s triggers exactly one navigation
 *       (the hard navigation reloads the module, resetting the latch naturally), and
 *   (2) no-op when already ON the wall (`/change-password`) so the wall — which only calls exempt
 *       endpoints — can never bounce in a redirect loop.
 */

import { PASSWORD_CHANGE_REQUIRED_CODE } from "@lazyit/shared";
import { ApiError } from "./client";

/** The blocking forced-change wall the user is sent to (and must complete) before using the app. */
export const CHANGE_PASSWORD_PATH = "/change-password";

/** Latch so concurrent 403s from a batch of queries trigger exactly one navigation. */
let redirecting = false;

function onChangePasswordRoute(): boolean {
  if (typeof window === "undefined") return true; // never act server-side
  return window.location.pathname.startsWith(CHANGE_PASSWORD_PATH);
}

/**
 * If `error` is the forced-change 403 from the API, hard-navigate to the `/change-password` wall.
 * Idempotent: safe to call from every query/mutation error; only the first matching 403 acts, and it
 * no-ops once already on the wall. Returns true when it handled a forced-change (so callers may
 * suppress the error toast).
 */
export function handlePasswordChangeRequired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (code !== PASSWORD_CHANGE_REQUIRED_CODE) return false;

  if (redirecting || onChangePasswordRoute()) return true;

  redirecting = true;
  window.location.assign(CHANGE_PASSWORD_PATH);
  return true;
}

/** Test-only: reset the module latch between cases. */
export function __resetPasswordChangeLatch(): void {
  redirecting = false;
}
