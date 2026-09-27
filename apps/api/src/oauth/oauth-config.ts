/**
 * The authorization server's identity: its issuer and the one resource it issues tokens for.
 *
 * The issuer is PINNED CONFIGURATION — the instance's `WEB_ORIGIN` — and never derived from `Host`
 * (security.md T-30). It exists only when that origin is HTTPS: on a plain-HTTP `lan` instance
 * (ADR-0087, `WEB_ORIGIN` unset) or an `http://` origin, and under `AUTH_MODE=shim`, there is NO
 * authorization server — every AS endpoint answers 404 (ADR-0097 decision 8; the MCP spec: "All
 * authorization server endpoints MUST be served over HTTPS").
 */
export interface OAuthServerConfig {
  /** `https://host[:port]` — no path, no trailing slash. */
  issuer: string;
  /** The canonical MCP resource URI (RFC 8707): `{issuer}/mcp`, no trailing slash. */
  resource: string;
}

/** Resolve the configuration from the environment, or `null` when the authorization server is absent. */
export function resolveOAuthServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthServerConfig | null {
  if (env.AUTH_MODE === 'shim') return null;
  const raw = env.WEB_ORIGIN?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const issuer = url.origin;
  return { issuer, resource: `${issuer}/mcp` };
}

/**
 * Whether a presented `resource` (RFC 8707) names this server's canonical MCP URI. Scheme and host are
 * compared case-insensitively (the MCP spec asks servers to accept upper-case forms); the path must be
 * exactly `/mcp` with no query, fragment or userinfo.
 */
export function isCanonicalResource(
  value: string,
  config: OAuthServerConfig,
): boolean {
  if (value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === config.issuer &&
    url.pathname === '/mcp' &&
    url.search === '' &&
    !value.includes('?') &&
    url.username === '' &&
    url.password === ''
  );
}
