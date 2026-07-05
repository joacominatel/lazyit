import { resolveCorsOrigin } from './cors-origin';

describe('resolveCorsOrigin (CORS origin — LAN host-agnostic mode, issue #1035)', () => {
  it('reflects the request Origin (returns `true`) when AUTH_TRUST_HOST=true', () => {
    expect(resolveCorsOrigin({ AUTH_TRUST_HOST: 'true' })).toBe(true);
  });

  it('uses the fixed WEB_ORIGIN when AUTH_TRUST_HOST is not set (byte-identical to prior)', () => {
    expect(
      resolveCorsOrigin({ WEB_ORIGIN: 'https://lazyit.example.com' }),
    ).toBe('https://lazyit.example.com');
  });

  it('falls back to the localhost dev server when neither var is set', () => {
    expect(resolveCorsOrigin({})).toBe('http://localhost:3000');
  });

  it('does not coerce loosely — AUTH_TRUST_HOST=false keeps the fixed origin', () => {
    expect(
      resolveCorsOrigin({
        AUTH_TRUST_HOST: 'false',
        WEB_ORIGIN: 'https://x.test',
      }),
    ).toBe('https://x.test');
  });
});
