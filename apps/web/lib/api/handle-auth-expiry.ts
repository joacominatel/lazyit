/**
 * Global reaction to an expired/invalid session (issue #600).
 *
 * The Auth.js JWT stores the IdP access token once at sign-in and never refreshes it
 * (no `offline_access`, no rotating-refresh — that is the DEFERRED follow-up). Once the
 * IdP access token expires the app cookie is still valid (default 30-day maxAge), so the
 * user stays "signed in" in the UI while every authenticated API call attaches an expired
 * Bearer and the API returns 401. That is a stuck-but-signed-in state with no recovery.
 *
 * The lazy correct fix (CEO decision: "lazy 401-redirect first") is a single global
 * reaction: on a 401 from `apiFetch`, sign the dead session out and redirect to /login.
 * This is wired once into the TanStack QueryCache/MutationCache `onError` in providers.tsx
 * so no per-call wiring is needed. `signOut({ redirect: false })` clears the cookie without
 * following Auth.js's server-resolved absolute URL (the same call the UserMenu uses); we then
 * navigate client-side to the RELATIVE /login so the destination stays on the current host
 * (host-agnostic LAN mode would otherwise resolve to `http://0.0.0.0:3000` — issue #1052).
 *
 * Idempotency / loop-guard: `signOut` triggers a full-page navigation to /login, but many
 * in-flight queries can 401 at once and the login page itself is public. We therefore
 * (1) latch on a module-level flag so only the FIRST 401 fires sign-out, and
 * (2) no-op when already on an auth route (/login, /api/auth/*) so a transient 401 there
 * can never bounce the user in a redirect loop.
 */

import { signOut } from "next-auth/react";
import { ApiError } from "./client";

/** Latch so concurrent 401s from a batch of queries trigger exactly one sign-out. */
let signingOut = false;

/** Route prefixes where a 401 must NOT trigger a redirect (avoid a sign-out loop). */
const AUTH_ROUTE_PREFIXES = ["/login", "/api/auth"];

function onAuthRoute(): boolean {
  if (typeof window === "undefined") return true; // never act server-side
  return AUTH_ROUTE_PREFIXES.some((p) => window.location.pathname.startsWith(p));
}

/**
 * If `error` is a 401 from the API, sign the dead session out and redirect to /login.
 * Idempotent: safe to call from every query/mutation error; only the first 401 acts.
 * Returns true when it handled an auth-expiry (so callers may suppress the error toast).
 */
export function handleAuthExpiry(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false;
  if (signingOut || onAuthRoute()) return true;

  signingOut = true;
  // #1052: sign out WITHOUT a server-resolved absolute redirect, then navigate client-side to a
  // RELATIVE path (mirrors the UserMenu sign-out). In host-agnostic LAN mode (AUTH_URL unset) a
  // `callbackUrl` redirect resolves against the Next standalone bind host and lands on
  // `http://0.0.0.0:3000/login`; a relative navigation stays on the current host in every mode.
  void signOut({ redirect: false }).then(() => {
    window.location.assign("/login");
  });
  return true;
}

/** Test-only: reset the module latch between cases. */
export function __resetAuthExpiryLatch(): void {
  signingOut = false;
}
