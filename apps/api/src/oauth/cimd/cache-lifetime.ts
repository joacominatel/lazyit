import {
  CIMD_CACHE_DEFAULT_TTL_MS,
  CIMD_CACHE_MAX_TTL_MS,
  CIMD_CACHE_MIN_TTL_MS,
} from './cimd.constants';

/**
 * How long a fetched metadata document is served from the cache: the response's `Cache-Control` honoured
 * WITHIN lazyit's bounds (draft §"Metadata Caching" allows server-defined lower and upper bounds):
 *   - `max-age=N` (or `s-maxage`, preferred as the shared-cache directive) → N seconds, clamped to
 *     [{@link CIMD_CACHE_MIN_TTL_MS}, {@link CIMD_CACHE_MAX_TTL_MS}];
 *   - `no-store` / `no-cache` → the minimum (lazyit still needs the registration between the consent page and
 *     its decision, and never re-fetches more often than this);
 *   - otherwise `Expires` relative to `Date` (or now), clamped the same way;
 *   - nothing usable → {@link CIMD_CACHE_DEFAULT_TTL_MS}.
 */
export function cacheLifetimeMs(headers: Headers, now: number): number {
  const clamp = (ms: number) =>
    Math.min(CIMD_CACHE_MAX_TTL_MS, Math.max(CIMD_CACHE_MIN_TTL_MS, ms));
  const cacheControl = (headers.get('cache-control') ?? '').toLowerCase();
  const directives = new Map<string, string | null>();
  for (const part of cacheControl.split(',')) {
    const [rawKey, ...rest] = part.trim().split('=');
    const key = rawKey?.trim();
    if (!key) continue;
    const value =
      rest.length > 0 ? rest.join('=').trim().replace(/^"|"$/g, '') : null;
    if (!directives.has(key)) directives.set(key, value);
  }
  if (directives.has('no-store') || directives.has('no-cache')) {
    return CIMD_CACHE_MIN_TTL_MS;
  }
  for (const key of ['s-maxage', 'max-age']) {
    const value = directives.get(key);
    if (value !== undefined && value !== null && /^\d{1,10}$/.test(value)) {
      return clamp(Number(value) * 1000);
    }
  }
  const expires = headers.get('expires');
  if (expires) {
    const expiresAt = Date.parse(expires);
    const dateHeader = headers.get('date');
    const base = dateHeader ? Date.parse(dateHeader) : Number.NaN;
    if (!Number.isNaN(expiresAt)) {
      return clamp(expiresAt - (Number.isNaN(base) ? now : base));
    }
  }
  return CIMD_CACHE_DEFAULT_TTL_MS;
}
