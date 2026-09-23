/**
 * The /login bounce guard for a dead session (#1307).
 *
 * `/login` sends an already-signed-in visitor straight back into the app. That is right for a live
 * session and wrong for one whose API token is dead but whose Auth.js cookie still reads as valid — a
 * token revoked from another device, a cookie issued before #1307, a clock disagreement. There the
 * global 401 handler signs out and navigates to /login, and if the cookie has not been cleared yet (or a
 * concurrent response re-set it), /login would bounce back into the app, which 401s again: the reload
 * loop. The 401 handler therefore lands on /login with this marker, and /login never bounces a visitor
 * that carries it. The worst case is showing the sign-in form to someone who is still signed in.
 */

import { safeInternalPath } from "@/lib/utils/safe-redirect";

/** Query parameter the 401 handler adds when it sends a visitor to /login. */
export const SESSION_EXPIRED_PARAM = "expired";

/** Route prefixes that are the sign-in flow itself: never a 401 target, never a destination to return to. */
export const AUTH_ROUTE_PREFIXES = ["/login", "/api/auth"];

/**
 * Where the 401 handler sends a visitor whose session is dead: `/login` with the marker, plus the page
 * they were on as `callbackUrl`, so a fresh sign-in lands them back there — the same destination the
 * proxy carries for a signed-out visitor. Relative on purpose (#1052).
 *
 * The destination goes through the open-redirect guard (#495), and an auth route is never carried: a
 * `callbackUrl` pointing at `/login` would only nest the sign-in screen inside itself. `/login` applies
 * the same guard again when it reads the parameter.
 */
export function expiredSessionLoginPath(location: {
  pathname: string;
  search: string;
}): string {
  const params = new URLSearchParams({ [SESSION_EXPIRED_PARAM]: "1" });
  const raw = `${location.pathname}${location.search}`;
  const destination = safeInternalPath(raw);
  if (
    destination === raw &&
    !AUTH_ROUTE_PREFIXES.some((prefix) => destination.startsWith(prefix))
  ) {
    params.set("callbackUrl", destination);
  }
  return `/login?${params.toString()}`;
}

/**
 * Whether `/login` may send a signed-in visitor straight into the app. False when the visitor arrived
 * from the 401 handler, whatever the marker's value.
 */
export function mayBounceSignedInVisitor(searchParams: {
  [SESSION_EXPIRED_PARAM]?: string | string[];
}): boolean {
  return searchParams[SESSION_EXPIRED_PARAM] === undefined;
}
