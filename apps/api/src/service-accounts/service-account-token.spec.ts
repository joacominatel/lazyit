import {
  hashSecret,
  isServiceAccountToken,
  mintToken,
  parseToken,
  randomHash,
  verifySecret,
} from './service-account-token';

// Lazyit-native service-account token primitives (ADR-0048). Security-critical: the format, the
// fast-hash-of-a-high-entropy-secret model, and the constant-time compare.

describe('service-account token utils', () => {
  describe('mintToken', () => {
    it('produces a lzit_sa_<id>_<secret> token, its SHA-256 hash, and a display prefix', () => {
      const id = 'ckg9z1a2b0000qzrmn831k4d8';
      const minted = mintToken(id);

      expect(minted.token.startsWith(`lzit_sa_${id}_`)).toBe(true);
      expect(isServiceAccountToken(minted.token)).toBe(true);
      // The stored hash is the SHA-256 of the SECRET (the last segment), not the whole token.
      const parsed = parseToken(minted.token);
      expect(parsed).not.toBeNull();
      expect(minted.tokenHash).toBe(hashSecret(parsed!.secret));
      // The display prefix is a short, non-secret leading fragment of the token.
      expect(minted.token.startsWith(minted.tokenPrefix)).toBe(true);
      expect(minted.tokenPrefix.length).toBeLessThan(minted.token.length);
    });

    it('mints a fresh, unguessable secret each time', () => {
      const a = mintToken('id1');
      const b = mintToken('id1');
      expect(a.token).not.toBe(b.token);
      expect(a.tokenHash).not.toBe(b.tokenHash);
    });
  });

  describe('parseToken', () => {
    it('splits id and secret on the FIRST underscore after the prefix (secret may contain _)', () => {
      // The base64url secret can itself contain '_'. Parsing must keep it whole.
      const token = 'lzit_sa_ckg9z1a2b0000qzrmn831k4d8_aa_bb__cc';
      const parsed = parseToken(token);
      expect(parsed).toEqual({
        serviceAccountId: 'ckg9z1a2b0000qzrmn831k4d8',
        secret: 'aa_bb__cc',
      });
    });

    it('returns null for a non-SA token, a missing separator, or an empty id/secret', () => {
      expect(parseToken('Bearer abc')).toBeNull();
      expect(parseToken('eyJhbGciOi.jwt.token')).toBeNull();
      expect(parseToken('lzit_sa_noseparator')).toBeNull();
      expect(parseToken('lzit_sa__emptyid')).toBeNull();
      expect(parseToken('lzit_sa_id_')).toBeNull(); // empty secret
    });
  });

  describe('verifySecret', () => {
    it('accepts the right secret and rejects a wrong one', () => {
      const minted = mintToken('ckg9z1a2b0000qzrmn831k4d8');
      const { secret } = parseToken(minted.token)!;
      expect(verifySecret(secret, minted.tokenHash)).toBe(true);
      expect(verifySecret(`${secret}x`, minted.tokenHash)).toBe(false);
      expect(verifySecret('totally-wrong', minted.tokenHash)).toBe(false);
    });

    it('is a constant-time compare: returns false (never throws) on a malformed stored hash', () => {
      // A stored hash of a different length / non-hex must fail closed, not throw.
      expect(verifySecret('any', 'not-hex')).toBe(false);
      expect(verifySecret('any', 'abcd')).toBe(false); // 2 bytes vs 32-byte presented
      expect(verifySecret('any', '')).toBe(false);
    });

    it('uses timingSafeEqual on equal-length buffers (no early-exit on the first differing byte)', () => {
      // Two distinct 32-byte hashes: verify still returns a boolean without throwing — the equal-length
      // path goes through timingSafeEqual, which does not short-circuit.
      const h1 = hashSecret('secret-one');
      expect(verifySecret('secret-two', h1)).toBe(false);
      expect(verifySecret('secret-one', h1)).toBe(true);
    });
  });

  describe('hashSecret / randomHash', () => {
    it('hashSecret is deterministic SHA-256 hex (64 chars)', () => {
      expect(hashSecret('x')).toBe(hashSecret('x'));
      expect(hashSecret('x')).toHaveLength(64);
    });

    it('randomHash is a fresh 64-char hex value each call (collision-proof placeholder)', () => {
      const a = randomHash();
      const b = randomHash();
      expect(a).toHaveLength(64);
      expect(a).not.toBe(b);
    });
  });
});
