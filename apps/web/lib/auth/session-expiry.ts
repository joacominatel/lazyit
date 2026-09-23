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

/** Query parameter the 401 handler adds when it sends a visitor to /login. */
export const SESSION_EXPIRED_PARAM = "expired";

/** Where the 401 handler sends a visitor whose session is dead. Relative on purpose (#1052). */
export const EXPIRED_SESSION_LOGIN_PATH = `/login?${SESSION_EXPIRED_PARAM}=1`;

/**
 * Whether `/login` may send a signed-in visitor straight into the app. False when the visitor arrived
 * from the 401 handler, whatever the marker's value.
 */
export function mayBounceSignedInVisitor(searchParams: {
  [SESSION_EXPIRED_PARAM]?: string | string[];
}): boolean {
  return searchParams[SESSION_EXPIRED_PARAM] === undefined;
}
