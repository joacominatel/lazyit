/**
 * The headers the web's server-side sign-in forwards to `POST /auth/login` (#1420, ADR-0086 §9).
 *
 * The browser never calls the API's login itself: Auth.js's Credentials `authorize` does, from the web
 * container. Without these two headers every `UserSession` row would record the web container's address
 * and Node's user agent — and the login rate limit would be per web container instead of per client.
 *
 * - `User-Agent` — the browser's, as received. Informational only (the API parses browser and OS from it).
 * - `X-Forwarded-For` — EXACTLY as received from the reverse proxy: not appended to, not reordered, not
 *   synthesized when absent, never taken from `X-Real-IP` or reduced to its leftmost entry. The API runs
 *   with `trust proxy` = 1 hop (SEC-010), so it takes the RIGHTMOST entry — the one Caddy appended from the
 *   real TCP peer. A client-forged value sits to the left of it and is ignored. Adding a hop here would
 *   shift that window by one and hand the choice of address to the client; that is why this passes the
 *   header through untouched and nothing else.
 *
 * An absent (or empty) header is simply not sent. Pure, so both rules are unit-tested.
 */
export function loginClientHeaders(
  incoming: Headers | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!incoming) return out;
  const userAgent = incoming.get("user-agent");
  if (userAgent) out["User-Agent"] = userAgent;
  const forwardedFor = incoming.get("x-forwarded-for");
  if (forwardedFor) out["X-Forwarded-For"] = forwardedFor;
  return out;
}
