import {
  classifyMcpRedirectUri,
  isMcpRedirectUriAllowed,
  type McpClientAllowlistEntry,
} from '@lazyit/shared';

/**
 * The client trust policy (ADR-0097 decision 13 + its 2026-09-23 amendment) as pure functions. The
 * shared contract (`classifyMcpRedirectUri`, `isMcpRedirectUriAllowed`) states the per-URI rule; this
 * file applies it to a whole client and to the redirect of one authorization request.
 */

/** The allowlist inputs, as the policy service resolves them from `ai_settings`. */
export interface ClientTrustPolicy {
  /** The EFFECTIVE allowlist: curated defaults minus removed ids, plus the admin's entries. */
  allowlist: readonly McpClientAllowlistEntry[];
  /** `mcpAllowAnyHttpsClient`: admits https non-loopback redirects, never loopback or private-use. */
  allowAnyHttpsClient: boolean;
}

/** The parts of an `OAuthClient` row the policy reads. */
export interface PolicyClient {
  kind: string;
  clientId: string;
  redirectUris: readonly string[];
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Parse a redirect URI with the WHATWG `URL` parser, or `null` when it cannot be one: unparseable (an
 * out-of-range port such as `:99999`), carrying userinfo (`http://localhost:80@evil.com/…` — the host
 * is `evil.com`, whatever a regex reading the prefix concludes), or carrying a fragment. This check
 * stands on its own: it does not rely on the shared classifier's regexes.
 */
function parseRedirect(uri: string): URL | null {
  if (uri.length === 0 || uri.length > 2048 || uri.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || uri.includes('@')) {
    return null;
  }
  return url;
}

/** Whether a parsed http(s) URL points at a loopback address — decided from the PARSED hostname. */
function isLoopbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
  );
}

/**
 * Whether a redirect URI may ever be registered: an https, loopback or private-use URI
 * (`classifyMcpRedirectUri`) with no fragment and no userinfo (RFC 6749 §3.1.2) that the URL parser
 * accepts. The shared classification must agree with the parsed URL: `loopback` only when the parsed
 * hostname is loopback, and plain `http` only on a loopback hostname. Plain http off loopback and every
 * browser-interpreted scheme (`javascript:`, `data:`, `file:` …) are refused here, before any allowlist.
 */
export function isRegistrableRedirectUri(uri: string): boolean {
  const url = parseRedirect(uri);
  if (!url) return false;
  const kind = classifyMcpRedirectUri(uri);
  if (kind === null) return false;
  const loopback = isLoopbackUrl(url);
  if (kind === 'loopback' && !loopback) return false;
  if (url.protocol === 'http:' && !loopback) return false;
  if (kind === 'https' && (url.protocol !== 'https:' || loopback)) return false;
  return true;
}

/** Whether the client is identified by an allowlisted CIMD `client_id` URL (never a DCR client). */
function isCimdListed(
  client: PolicyClient,
  policy: ClientTrustPolicy,
): boolean {
  return (
    client.kind !== 'dcr' &&
    policy.allowlist.some(
      (entry) =>
        entry.match.kind === 'cimd_url' && entry.match.url === client.clientId,
    )
  );
}

/**
 * Whether ONE redirect URI of this client is admitted: a CIMD-listed client's own (registrable) redirects
 * are trusted through its verified domain; any other client needs the URI itself admitted by an entry or,
 * for https only, the "any HTTPS client" toggle.
 */
export function isRedirectAdmitted(
  client: PolicyClient,
  uri: string,
  policy: ClientTrustPolicy,
): boolean {
  if (!isRegistrableRedirectUri(uri)) return false;
  if (isCimdListed(client, policy)) return true;
  return isMcpRedirectUriAllowed(
    uri,
    policy.allowlist,
    policy.allowAnyHttpsClient,
  );
}

/**
 * Whether the client may connect at all: EVERY registered redirect must be admitted, so a registration
 * cannot smuggle an unlisted redirect next to a listed one. `client_name` plays no part.
 */
export function isClientAllowed(
  client: PolicyClient,
  policy: ClientTrustPolicy,
): boolean {
  return (
    client.redirectUris.length > 0 &&
    client.redirectUris.every((uri) => isRedirectAdmitted(client, uri, policy))
  );
}

/** Loopback http redirects compare without their port (RFC 8252 §7.3); nothing else is normalized. */
const LOOPBACK_HTTP_PORT =
  /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+(?=\/|$)/i;
const LOOPBACK_HTTP =
  /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?=\/|$)/i;

function withoutLoopbackPort(uri: string): string {
  return uri.replace(LOOPBACK_HTTP_PORT, '$1');
}

/**
 * EXACT redirect matching (RFC 9700 §2.1, INV-AI-9): the requested URI must equal a registered one
 * character for character — case, trailing slash and query included. The only exception is the port
 * of a loopback `http` redirect, which native clients choose at run time.
 */
export function matchesRegisteredRedirect(
  requested: string,
  registered: readonly string[],
): boolean {
  // Unparseable (e.g. port 99999) or userinfo-carrying URIs never match: the request is refused before
  // any code row is written, instead of failing later when the redirect is built.
  const url = parseRedirect(requested);
  if (!url) return false;
  if (registered.includes(requested)) return true;
  if (!LOOPBACK_HTTP.test(requested) || !isLoopbackUrl(url)) return false;
  const candidate = withoutLoopbackPort(requested);
  return registered.some((uri) => withoutLoopbackPort(uri) === candidate);
}

/** The host the consent screen shows for a redirect: the URL host, or the scheme of a hostless URI. */
export function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.host) return url.host;
    return url.protocol.replace(/:$/, '');
  } catch {
    return uri.split(':')[0] ?? uri;
  }
}

/** Whether a redirect is a loopback address (the consent screen adds a warning). */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parseRedirect(uri);
  return url !== null && isLoopbackUrl(url);
}
