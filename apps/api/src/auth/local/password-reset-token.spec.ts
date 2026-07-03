import { createHash } from 'node:crypto';
import { hashResetToken, mintResetToken } from './password-reset-token';

/**
 * password-reset-token unit tests (ADR-0086 §F4 / SECURITY GAP #7). The token security properties:
 * CSPRNG entropy (≥128-bit), deterministic SHA-256 hash-at-rest (the raw is recoverable ONLY from the
 * emailed link, never from the stored hash), and URL-safety of the raw value.
 */
describe('password-reset-token primitives (ADR-0086 §F4)', () => {
  describe('hashResetToken', () => {
    it('is SHA-256(raw) as lowercase hex (deterministic, 64 chars)', () => {
      const raw = 'some-raw-token';
      const expected = createHash('sha256').update(raw).digest('hex');
      expect(hashResetToken(raw)).toBe(expected);
      expect(hashResetToken(raw)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is a one-way digest: different raws produce different hashes', () => {
      expect(hashResetToken('a')).not.toBe(hashResetToken('b'));
    });
  });

  describe('mintResetToken', () => {
    it('returns a raw token + its matching hash-at-rest', () => {
      const { raw, tokenHash } = mintResetToken();
      expect(typeof raw).toBe('string');
      expect(tokenHash).toBe(hashResetToken(raw));
      // The stored hash is NOT the raw token (hash-at-rest — a DB leak never yields a usable token).
      expect(tokenHash).not.toBe(raw);
    });

    it('is high-entropy (32 bytes = 256 bits) and URL-safe base64url', () => {
      const { raw } = mintResetToken();
      // base64url of 32 bytes is 43 chars, no padding, only [A-Za-z0-9_-].
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('is unique per mint (CSPRNG, no collisions across a batch)', () => {
      const raws = new Set<string>();
      const hashes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const { raw, tokenHash } = mintResetToken();
        raws.add(raw);
        hashes.add(tokenHash);
      }
      expect(raws.size).toBe(1000);
      expect(hashes.size).toBe(1000);
    });
  });
});
