import {
  normalizeClientIp,
  normalizeUserAgent,
  parseUserAgent,
  USER_AGENT_MAX_LENGTH,
} from './user-agent';

/** The small User-Agent reader behind the per-device session list (issue #1420). */
describe('parseUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
      'Edge',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox',
      'Linux',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      'Chrome',
      'Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1',
      'Chrome',
      'iOS',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari',
      'iPadOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      'Opera',
      'Windows',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome',
      'ChromeOS',
    ],
  ])('%s → %s on %s', (ua, browser, os) => {
    expect(parseUserAgent(ua)).toEqual({ browser, os });
  });

  it('answers null for an unknown or missing agent', () => {
    expect(parseUserAgent('curl/8.5.0')).toEqual({ browser: null, os: null });
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null });
  });
});

describe('normalizeUserAgent / normalizeClientIp', () => {
  it('bounds and trims the user agent, and drops a blank or missing one', () => {
    expect(normalizeUserAgent('x'.repeat(2000))).toHaveLength(
      USER_AGENT_MAX_LENGTH,
    );
    expect(normalizeUserAgent('  UA  ')).toBe('UA');
    expect(normalizeUserAgent('   ')).toBeNull();
    expect(normalizeUserAgent(undefined)).toBeNull();
  });

  it('shows an IPv6-mapped IPv4 address as IPv4 and keeps real IPv6', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp('')).toBeNull();
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp('9'.repeat(100))).toBeNull();
  });
});
