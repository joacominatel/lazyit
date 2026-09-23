import { signOut } from "next-auth/react";

import { logout } from "@/lib/api/endpoints/auth-session";

/** How long sign-out waits for the API to revoke the session before ending the local one anyway. */
export const LOGOUT_TIMEOUT_MS = 3000;

/**
 * A user-initiated sign-out (#1307, ADR-0086 §8): revoke the session server-side, then drop the Auth.js
 * cookie and land on /login.
 *
 * Revoking first matters for a "keep me signed in" session, which never expires by time: without it a
 * copied cookie would outlive the sign-out. In local mode the revocation ends the user's sessions on
 * every device; in OIDC mode the API answers a no-op 204. The revocation never blocks signing out — a
 * 401 (already revoked), a network failure or a slow API all fall through to the local sign-out.
 *
 * Only a deliberate sign-out revokes. The global 401 handler (lib/api/handle-auth-expiry.ts) signs out a
 * session the API already rejected; revoking there could end every device's session over one spurious
 * 401.
 */
export async function signOutAndRevoke(): Promise<void> {
  try {
    await logout({ signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) });
  } catch {
    // Already revoked, unreachable or too slow — sign out locally regardless.
  }
  // #1052: sign out WITHOUT letting Auth.js follow the server-resolved absolute URL, then navigate
  // client-side to a RELATIVE path. In host-agnostic LAN mode (AUTH_URL unset) the server origin is the
  // Next standalone bind host `0.0.0.0`, so a `callbackUrl` redirect would land on
  // `http://0.0.0.0:3000/login`; a relative navigation stays on the current host in every mode.
  await signOut({ redirect: false });
  // A full-page load on purpose: it discards every in-memory trace of the session (query cache, token
  // store, the unlocked secret session), which a client-side router push would keep.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/login");
}
