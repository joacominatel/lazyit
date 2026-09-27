/**
 * Resolve the ORIGIN a password-reset link is built against for the ADMIN-initiated reset
 * (`POST /users/:id/reset-password`, issue #1268). Pure + framework-agnostic so it unit-tests without a
 * request object.
 *
 * Two sources, in order:
 *
 *  1. `WEB_ORIGIN` — the pinned public origin. Always authoritative when set; this is the only source the
 *     PUBLIC `POST /auth/forgot-password` flow ever uses.
 *  2. The INCOMING REQUEST's host, and ONLY when `AUTH_TRUST_HOST === 'true'`. That is the host-agnostic
 *     plain-HTTP LAN deploy of [[0087-plain-http-lan-deployment-axis]], where an UNSET `WEB_ORIGIN` is the
 *     correct configuration (the instance is reached at whatever LAN IP DHCP handed it), not an operator
 *     mistake. Without this branch the email delivery would be permanently unavailable on that deployment
 *     shape for no good reason.
 *
 * WHY THE REQUEST HOST IS ONLY TRUSTED HERE. A `Host` / `X-Forwarded-Host` header is attacker-controllable
 * in the general case, and here it shapes a URL that lands in someone else's mailbox — the classic
 * host-header password-reset poisoning bug. Trusting it is defensible ONLY because this specific caller is
 * an authenticated `user:manage` admin driving their own browser through the reverse proxy that terminates
 * the connection: the header they send is the address they themselves reached the instance at, and an
 * attacker who could already forge it would need the admin's session first. That reasoning does NOT
 * transfer to the anonymous, unauthenticated forgot-password flow, so this helper must never be wired
 * into {@link ../auth/local/password-lifecycle.service PasswordLifecycleService.forgotPassword} — that
 * path stays `WEB_ORIGIN`-only, and skips the email when it is unset.
 */

/** The request headers this resolver reads. A subset of Node's `IncomingHttpHeaders`. */
export interface ResetLinkOriginHeaders {
  host?: string | string[] | undefined;
  'x-forwarded-host'?: string | string[] | undefined;
  'x-forwarded-proto'?: string | string[] | undefined;
}

/**
 * A hostname (or bracketed IPv6 literal) with an optional port — the only shape accepted from a header.
 * Anything else (a path, a scheme, whitespace, an embedded credential, a CRLF) yields no origin rather
 * than a half-valid URL, so a malformed header degrades to `origin-unknown` instead of a broken link.
 */
const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** The first value of a possibly-repeated header, and the first entry of a comma-joined proxy list. */
function firstHeaderValue(
  raw: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(',')[0]?.trim() || undefined;
}

/** Drop trailing slashes so `${origin}/reset-password` never produces a double slash. */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * The origin to build an admin reset link against, or `null` when none can be determined (the caller
 * reports that as the `origin-unknown` capability reason / 409).
 */
export function resolveResetLinkOrigin(
  env: NodeJS.ProcessEnv,
  headers: ResetLinkOriginHeaders,
): string | null {
  const pinned = env.WEB_ORIGIN?.trim();
  if (pinned) return normalizeOrigin(pinned);

  // Host-agnostic LAN mode only (ADR-0087). Outside it, an unset WEB_ORIGIN IS a misconfiguration and we
  // say so rather than silently trusting a header.
  if (env.AUTH_TRUST_HOST !== 'true') return null;

  const host =
    firstHeaderValue(headers['x-forwarded-host']) ??
    firstHeaderValue(headers.host);
  if (!host || !HOST_PATTERN.test(host)) return null;

  // ADR-0087's LAN mode is plain HTTP by design, so `http` is the correct default; an operator who
  // fronted it with TLS gets `https` from the proxy's X-Forwarded-Proto.
  const forwardedProto = firstHeaderValue(
    headers['x-forwarded-proto'],
  )?.toLowerCase();
  const proto =
    forwardedProto === 'https' || forwardedProto === 'http'
      ? forwardedProto
      : 'http';

  return `${proto}://${host}`;
}
