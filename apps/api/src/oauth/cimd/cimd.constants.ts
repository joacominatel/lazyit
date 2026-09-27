/**
 * The fixed numbers of CIMD — OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document;
 * ADR-0097 decision 8; mcp-and-oauth.md §4 F2, §15). Like the rest of `oauth.constants.ts`, changing one is a
 * security decision, not a tuning knob.
 */

/** The most bytes read from a metadata document; past it the fetch fails (draft §"Maximum Response Size": 5 KB). */
export const CIMD_MAX_DOCUMENT_BYTES = 5 * 1024;

/**
 * The TOTAL time budget of one document fetch (connect → headers → body). The consent page waits for it, so
 * it is short; a stalled or trickling server is cut off here.
 */
export const CIMD_FETCH_DEADLINE_MS = 5 * 1000;

/** The per-socket idle timeout of one document fetch. */
export const CIMD_FETCH_IDLE_TIMEOUT_MS = 3 * 1000;

/**
 * Cache lifetime bounds (draft §"Metadata Caching": respect HTTP cache headers, within the server's own
 * bounds). `Cache-Control: max-age` is clamped into [MIN, MAX]; a response without a usable lifetime
 * (`no-store`, `no-cache`, no header) is cached for {@link CIMD_CACHE_DEFAULT_TTL_MS}, or MIN for `no-store` /
 * `no-cache` — never zero, so the consent page and its decision do not each fetch.
 */
export const CIMD_CACHE_MIN_TTL_MS = 5 * 60 * 1000;
export const CIMD_CACHE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const CIMD_CACHE_DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * How long a BUNDLED copy stands in after a failed fetch before the next fetch attempt. Short: the network
 * copy is authoritative and is retried as soon as this lapses.
 */
export const CIMD_BUNDLED_RETRY_MS = CIMD_CACHE_MIN_TTL_MS;

/**
 * Per user: how many metadata documents may be fetched over the network (cache misses only). Every fetch is
 * an outbound request to a host the request names, so a signed-in user cannot turn the consent page into a
 * request generator. Past it the client is refused (or served from its bundled copy).
 */
export const CIMD_FETCH_RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 };

/** The longest Client Identifier URL accepted (the shared `client_id` parameter bound). */
export const CIMD_MAX_CLIENT_ID_LENGTH = 2048;
