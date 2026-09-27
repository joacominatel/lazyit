import { isCanonicalResource, resolveOAuthServerConfig } from './oauth-config';

describe('resolveOAuthServerConfig — the issuer is pinned, HTTPS only', () => {
  it('derives the issuer and the canonical /mcp resource from an https WEB_ORIGIN', () => {
    expect(
      resolveOAuthServerConfig({
        AUTH_MODE: 'local',
        WEB_ORIGIN: 'https://lazyit.example.com/',
      }),
    ).toEqual({
      issuer: 'https://lazyit.example.com',
      resource: 'https://lazyit.example.com/mcp',
    });
  });

  it('keeps a non-default port and drops any path', () => {
    expect(
      resolveOAuthServerConfig({
        AUTH_MODE: 'local',
        WEB_ORIGIN: 'https://it.internal:8443/app',
      })?.issuer,
    ).toBe('https://it.internal:8443');
  });

  it('has NO authorization server on a plain-HTTP lan instance (WEB_ORIGIN unset)', () => {
    expect(
      resolveOAuthServerConfig({ AUTH_MODE: 'local', AUTH_TRUST_HOST: 'true' }),
    ).toBeNull();
  });

  it('has no authorization server on an http:// origin', () => {
    expect(
      resolveOAuthServerConfig({
        AUTH_MODE: 'local',
        WEB_ORIGIN: 'http://lazyit.example.com',
      }),
    ).toBeNull();
  });

  it('has no authorization server under the shim', () => {
    expect(
      resolveOAuthServerConfig({
        AUTH_MODE: 'shim',
        WEB_ORIGIN: 'https://lazyit.example.com',
      }),
    ).toBeNull();
  });

  it('ignores a malformed WEB_ORIGIN', () => {
    expect(
      resolveOAuthServerConfig({ AUTH_MODE: 'local', WEB_ORIGIN: 'not a url' }),
    ).toBeNull();
  });
});

describe('isCanonicalResource — RFC 8707 audience', () => {
  const config = {
    issuer: 'https://lazyit.example.com',
    resource: 'https://lazyit.example.com/mcp',
  };

  it('accepts the canonical URI, tolerating upper-case scheme and host', () => {
    expect(isCanonicalResource('https://lazyit.example.com/mcp', config)).toBe(
      true,
    );
    expect(isCanonicalResource('HTTPS://LAZYIT.EXAMPLE.COM/mcp', config)).toBe(
      true,
    );
  });

  it.each([
    'https://evil.example.com/mcp',
    'https://lazyit.example.com/',
    'https://lazyit.example.com/mcp/',
    'https://lazyit.example.com/api/mcp',
    'https://lazyit.example.com/mcp?x=1',
    'https://lazyit.example.com/mcp#frag',
    'http://lazyit.example.com/mcp',
    'https://user@lazyit.example.com/mcp',
    'not a uri',
  ])('refuses %s', (value) => {
    expect(isCanonicalResource(value, config)).toBe(false);
  });
});
