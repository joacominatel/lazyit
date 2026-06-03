import { parseTrustProxy } from './trust-proxy';

/**
 * SEC-010: `parseTrustProxy` turns the TRUST_PROXY env into Express's `trust proxy` value. The
 * default (unset/blank/false/0) MUST be `false` so dev — with no reverse proxy — keeps `req.ip` as
 * the socket address and ignores a forged X-Forwarded-For. A positive integer trusts that many proxy
 * hops (Caddy = 1); invalid input fails closed to `false`.
 */
describe('parseTrustProxy', () => {
  it('returns false when unset (dev default — XFF ignored)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  it.each(['', '   ', 'false', 'FALSE', '0'])(
    'returns false for the disabling value %p',
    (raw) => {
      expect(parseTrustProxy(raw)).toBe(false);
    },
  );

  it('returns the hop count for a positive integer (Caddy = 1)', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('returns true for "true" (trust all hops)', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it.each(['-1', '0.5', 'abc', 'NaN'])(
    'falls back to false for the invalid value %p (fail closed)',
    (raw) => {
      expect(parseTrustProxy(raw)).toBe(false);
    },
  );
});
