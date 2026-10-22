import type { JWTPayload } from 'jose';

/**
 * Clock-skew tolerance, in seconds, between lazyit's clock (which stamps the cutoff) and the IdP's clock
 * (which stamps `iat` / `auth_time`). A token stamped up to this long BEFORE the cutoff is still accepted.
 *
 * Why it errs that way: if the IdP's clock runs behind lazyit's, a sign-in made right after the cutoff
 * would otherwise carry an `iat` slightly before it and be refused, locking the user out of the very
 * re-login the action asks for. The price is that a token minted at the IdP in the last 30 seconds before
 * the cutoff survives. Thirty seconds matches the web's own refresh skew (`apps/web/auth.ts`).
 */
export const OIDC_CUTOFF_SKEW_SECONDS = 30;

/**
 * Whether an IdP access token predates the user's OIDC cutoff (`User.oidcTokensNotBefore`, #1715).
 *
 * - No cutoff (`null`, every user until they use the action) → never refused. This is the upgrade path.
 * - `iat` earlier than the cutoff (minus the skew) → refused. `iat` is REQUIRED in a JWT access token
 *   (RFC 9068 §2.2), and the API already demands JWT access tokens (auth-bootstrap runbook).
 * - `auth_time`, when the token carries it, earlier than the cutoff (minus the skew) → refused too. This is
 *   what ends a session on another device for good: the web renews its access token with a refresh token,
 *   and a renewed token has a FRESH `iat` but keeps the ORIGINAL `auth_time`. Without it, an idle device
 *   would come back with a renewed token and pass. A real sign-in after the cutoff has a later `auth_time`,
 *   because the web always asks the IdP for `prompt=login`.
 * - Neither claim present as a number while a cutoff exists → refused (fail closed): the token's age
 *   cannot be established.
 */
export function issuedBeforeOidcCutoff(
  payload: JWTPayload,
  cutoff: Date | null | undefined,
): boolean {
  if (!cutoff) {
    return false;
  }
  const notBefore =
    Math.floor(cutoff.getTime() / 1000) - OIDC_CUTOFF_SKEW_SECONDS;
  const iat = typeof payload.iat === 'number' ? payload.iat : null;
  const authTime =
    typeof payload['auth_time'] === 'number' ? payload['auth_time'] : null;
  if (iat === null && authTime === null) {
    return true;
  }
  return (
    (iat !== null && iat < notBefore) ||
    (authTime !== null && authTime < notBefore)
  );
}
