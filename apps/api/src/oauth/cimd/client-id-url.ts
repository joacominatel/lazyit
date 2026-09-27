import { CIMD_MAX_CLIENT_ID_LENGTH } from './cimd.constants';

/**
 * Whether an authorization request's `client_id` claims to be a Client Identifier URL, i.e. names a CIMD
 * client. lazyit's own client ids never start with `https://` (DCR mints `lzc_…`), so the prefix is an
 * unambiguous switch (draft §"Supporting Both Pre-Registered and Unregistered Clients"). Whether the URL is
 * ACCEPTABLE is {@link parseClientIdUrl}'s question.
 */
export function looksLikeClientIdUrl(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/**
 * Parse a Client Identifier URL (draft §"Client Identifier URL"), or `null` when it is not one lazyit will
 * fetch:
 *   - `https` only; no userinfo; no fragment; a path other than `/` (the draft says "MUST contain a path"
 *     and "`/` is NOT RECOMMENDED" — lazyit refuses the root);
 *   - no `.`/`..` segments — enforced, together with every other normalization, by requiring the string to
 *     be exactly the WHATWG serialization of itself (`href === raw`). A non-canonical spelling (upper-case
 *     host, an explicit `:443`, `%2e%2e`, a missing path) is refused rather than silently normalized: the
 *     id is compared by simple string comparison, so the string that was fetched must be the string that
 *     is stored and matched against the document's `client_id` and the allowlist.
 * A query is allowed (the draft says SHOULD NOT, not MUST NOT). A port is allowed.
 */
export function parseClientIdUrl(raw: string): URL | null {
  if (raw.length === 0 || raw.length > CIMD_MAX_CLIENT_ID_LENGTH) return null;
  if (!looksLikeClientIdUrl(raw) || raw.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  // Any `@` before the path is userinfo whatever the parser concluded; refuse it outright.
  if (raw.slice('https://'.length).split('/')[0].includes('@')) return null;
  if (url.hostname === '' || url.pathname === '/' || url.pathname === '') {
    return null;
  }
  if (url.href !== raw) return null;
  return url;
}

/**
 * The domain the consent screen shows as VERIFIED for a CIMD client: the host of its Client Identifier URL
 * (port included when it is not the default), which is what fetching the document proved control of.
 */
export function clientIdDomain(clientId: string): string | null {
  const url = parseClientIdUrl(clientId);
  return url ? url.host : null;
}
