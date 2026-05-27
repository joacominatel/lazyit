/**
 * Client-side session token store for automatic Bearer injection in apiFetch.
 *
 * The Auth.js access token is set here by SessionTokenSync (rendered in the app
 * layout) and read by apiFetch as a fallback when no explicit `token` is passed.
 *
 * SSR safety: all reads/writes are guarded by `typeof window !== "undefined"` so
 * the module-level variable is never shared across server-side requests.
 * Server components that call apiFetch directly must pass the token explicitly
 * via `await auth()` — this store is a client-side convenience only.
 */

let _token: string | undefined;

/** Returns the current session Bearer token, or undefined if not yet set. */
export function getSessionToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return _token;
}

/** Called by SessionTokenSync after Auth.js session resolves on the client. */
export function setSessionToken(token: string | undefined): void {
  if (typeof window === "undefined") return;
  _token = token;
}
