import { SetupCsrfService } from './setup-csrf.service';

describe('SetupCsrfService', () => {
  let service: SetupCsrfService;

  beforeEach(() => {
    service = new SetupCsrfService();
  });

  it('issues a token that verifies', () => {
    const token = service.issue();
    expect(typeof token).toBe('string');
    expect(service.verify(token)).toBe(true);
  });

  it('rejects an undefined / empty / malformed token', () => {
    expect(service.verify(undefined)).toBe(false);
    expect(service.verify('')).toBe(false);
    expect(service.verify('not-a-token')).toBe(false);
    expect(service.verify('a.b')).toBe(false); // too few parts
    expect(service.verify('a.b.c.d')).toBe(false); // too many parts
  });

  it('rejects a token with a tampered signature', () => {
    const token = service.issue();
    const [exp, nonce] = token.split('.');
    const forged = `${exp}.${nonce}.deadbeef`;
    expect(service.verify(forged)).toBe(false);
  });

  it('rejects a token with a tampered expiry (signature no longer matches)', () => {
    const token = service.issue();
    const [, nonce, sig] = token.split('.');
    const future = `${Date.now() + 9_000_000}.${nonce}.${sig}`;
    expect(service.verify(future)).toBe(false);
  });

  it('rejects an expired token', () => {
    const issuedAt = 1_000_000;
    const token = service.issue(issuedAt);
    // Far past the 30-minute TTL.
    expect(service.verify(token, issuedAt + 60 * 60 * 1000)).toBe(false);
  });

  it('cannot be verified by a different signing key (a different process)', () => {
    const token = service.issue();
    const other = new SetupCsrfService();
    expect(other.verify(token)).toBe(false);
  });
});
