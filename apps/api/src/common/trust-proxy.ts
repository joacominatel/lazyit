/**
 * Resolve Express's `trust proxy` value from the TRUST_PROXY env (SEC-010). Express honours
 * X-Forwarded-For only when this is set, and the value bounds HOW MANY appended hops it trusts:
 *
 *   - unset / "" / "false" / "0"  → `false`: no proxy trusted, `req.ip` is the socket address and a
 *     forged X-Forwarded-For is ignored. This is the safe DEFAULT for dev (no reverse proxy).
 *   - a positive integer (e.g. "1") → trust that many rightmost hops; `req.ip` becomes the first
 *     address LEFT of the trusted hops. Behind Caddy use "1" (one proxy hop).
 *   - "true"                       → trust all hops (only safe when an upstream you control always
 *     overwrites XFF; prefer the explicit hop count).
 *
 * Anything else (negative, non-integer, garbage) fails closed to `false`. Pure — kept out of main.ts
 * (which drags the whole AppModule graph) so it unit-tests in isolation.
 */
export function parseTrustProxy(raw: string | undefined): number | boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}
