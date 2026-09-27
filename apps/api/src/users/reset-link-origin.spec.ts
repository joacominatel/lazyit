import { resolveResetLinkOrigin } from './reset-link-origin';

/**
 * resolveResetLinkOrigin (issue #1268) — which origin an ADMIN-initiated reset link is built against.
 * The security-load-bearing part is the SECOND source: a request `Host` shapes a URL that lands in
 * someone else's mailbox, so the header is only ever consulted in ADR-0087's host-agnostic LAN mode, and
 * only for shapes that cannot smuggle a different destination into the link.
 */
describe('resolveResetLinkOrigin', () => {
  const lanHeaders = { host: '192.168.1.40:3000' };

  describe('WEB_ORIGIN (the pinned origin)', () => {
    it('wins over any request header', () => {
      expect(
        resolveResetLinkOrigin(
          { WEB_ORIGIN: 'https://lazyit.example.com', AUTH_TRUST_HOST: 'true' },
          { host: 'evil.example.net', 'x-forwarded-host': 'evil.example.net' },
        ),
      ).toBe('https://lazyit.example.com');
    });

    it('strips trailing slashes so the link never contains a double slash', () => {
      expect(
        resolveResetLinkOrigin(
          { WEB_ORIGIN: 'https://lazyit.example.com//' },
          {},
        ),
      ).toBe('https://lazyit.example.com');
    });

    it('treats a blank WEB_ORIGIN as unset', () => {
      expect(
        resolveResetLinkOrigin({ WEB_ORIGIN: '   ' }, lanHeaders),
      ).toBeNull();
    });
  });

  describe('without AUTH_TRUST_HOST', () => {
    it('never derives an origin from the request, even with a plausible Host', () => {
      expect(resolveResetLinkOrigin({}, lanHeaders)).toBeNull();
    });

    it('does not coerce loosely — AUTH_TRUST_HOST=false stays off', () => {
      expect(
        resolveResetLinkOrigin({ AUTH_TRUST_HOST: 'false' }, lanHeaders),
      ).toBeNull();
      expect(
        resolveResetLinkOrigin({ AUTH_TRUST_HOST: '1' }, lanHeaders),
      ).toBeNull();
    });
  });

  describe('AUTH_TRUST_HOST=true (ADR-0087 host-agnostic LAN mode)', () => {
    const env = { AUTH_TRUST_HOST: 'true' };

    it('derives http://<host> from Host — the LAN deploy where an unset WEB_ORIGIN is correct', () => {
      expect(resolveResetLinkOrigin(env, { host: '192.168.1.40:3000' })).toBe(
        'http://192.168.1.40:3000',
      );
    });

    it('prefers X-Forwarded-Host over Host (the proxy knows the address the admin used)', () => {
      expect(
        resolveResetLinkOrigin(env, {
          host: 'api-internal:3001',
          'x-forwarded-host': 'lazyit.lan',
        }),
      ).toBe('http://lazyit.lan');
    });

    it('honours an https X-Forwarded-Proto', () => {
      expect(
        resolveResetLinkOrigin(env, {
          host: 'lazyit.lan',
          'x-forwarded-proto': 'https',
        }),
      ).toBe('https://lazyit.lan');
    });

    it('takes the first hop of a comma-joined proxy chain', () => {
      expect(
        resolveResetLinkOrigin(env, {
          'x-forwarded-host': 'lazyit.lan, inner.proxy',
          'x-forwarded-proto': 'https, http',
        }),
      ).toBe('https://lazyit.lan');
    });

    it('falls back to http for a garbage or absent proto (never an arbitrary scheme)', () => {
      expect(
        resolveResetLinkOrigin(env, {
          host: 'lazyit.lan',
          'x-forwarded-proto': 'javascript',
        }),
      ).toBe('http://lazyit.lan');
    });

    it('supports a bracketed IPv6 literal with a port', () => {
      expect(resolveResetLinkOrigin(env, { host: '[fd00::1]:3000' })).toBe(
        'http://[fd00::1]:3000',
      );
    });

    it.each([
      ['a host carrying a path', 'lazyit.lan/../evil.example.net'],
      ['a host carrying a scheme', 'https://evil.example.net'],
      ['a host carrying embedded credentials', 'evil.example.net@lazyit.lan'],
      ['a host carrying a CRLF injection', 'lazyit.lan\r\nX-Injected: 1'],
      ['a host carrying a query', 'lazyit.lan?x=1'],
      ['a whitespace-only host', '   '],
      ['an empty host', ''],
    ])(
      'yields no origin for %s rather than a half-valid link',
      (_label, host) => {
        expect(resolveResetLinkOrigin(env, { host })).toBeNull();
      },
    );

    it('yields no origin when the request carries no host at all', () => {
      expect(resolveResetLinkOrigin(env, {})).toBeNull();
    });
  });
});
