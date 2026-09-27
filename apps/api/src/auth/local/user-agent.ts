/**
 * A deliberately small User-Agent reader for the per-device session list (issue #1420, ADR-0086 §9).
 *
 * The CEO asked for "browser + OS" per session without a new heavy dependency, and the list only needs a
 * human label ("Firefox on Windows"), not device detection. So this recognises the handful of browser and
 * OS families a small IT team actually signs in with and answers `null` for anything else — the raw UA is
 * still returned alongside, so nothing is lost. A User-Agent is self-reported by the client: these labels
 * are informational, never an identity or a security signal.
 *
 * Order matters: Chromium-based browsers also say "Chrome" and "Safari", and Chrome also says "Safari", so
 * the more specific tokens are tested first.
 */

/** Longest User-Agent stored on a session row; anything past it is cut (a UA is unbounded client input). */
export const USER_AGENT_MAX_LENGTH = 512;

/** Longest client IP stored on a session row (an IPv6 literal with a zone fits well within it). */
export const SESSION_IP_MAX_LENGTH = 64;

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bWindows\b/, 'Windows'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\biPad\b/, 'iPadOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** The browser and OS families named by a User-Agent, each `null` when unrecognised. */
export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
}

/** Read the browser and OS family out of a User-Agent string. Never throws. */
export function parseUserAgent(
  userAgent: string | null | undefined,
): ParsedUserAgent {
  if (!userAgent) {
    return { browser: null, os: null };
  }
  const match = (table: ReadonlyArray<readonly [RegExp, string]>) =>
    table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  return { browser: match(BROWSERS), os: match(SYSTEMS) };
}

/** Normalise a request's User-Agent header for storage: trimmed, bounded, `null` when absent or blank. */
export function normalizeUserAgent(value: unknown): string | null {
  const raw: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, USER_AGENT_MAX_LENGTH);
}

/**
 * Normalise Express's resolved client address (`req.ip`, already `trust proxy`-aware — SEC-010) for
 * storage: an IPv4 address the socket reports in its IPv6-mapped form (`::ffff:203.0.113.7`) is shown as
 * plain IPv4, and anything oversized or blank is dropped.
 */
export function normalizeClientIp(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_IP_MAX_LENGTH) {
    return null;
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}
