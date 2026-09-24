import { createHash } from 'node:crypto';
import {
  hashOpaqueToken,
  isS256Challenge,
  mintAuthorizationCode,
  mintClientId,
  mintOpaqueToken,
  safeEqual,
  verifyPkceS256,
} from './oauth-crypto';

const s256 = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

describe('oauth-crypto', () => {
  describe('verifyPkceS256 — PKCE is required and S256-only', () => {
    const verifier = 'a'.repeat(43);

    it('accepts the verifier whose SHA-256 is the challenge', () => {
      expect(verifyPkceS256(verifier, s256(verifier))).toBe(true);
    });

    it('refuses a different verifier', () => {
      expect(verifyPkceS256('b'.repeat(43), s256(verifier))).toBe(false);
    });

    it('refuses the "plain" method: a verifier equal to the challenge does not verify', () => {
      const plain = 'p'.repeat(43);
      expect(verifyPkceS256(plain, plain)).toBe(false);
    });

    it('refuses a missing verifier (no PKCE downgrade)', () => {
      expect(verifyPkceS256(undefined, s256(verifier))).toBe(false);
    });

    it('refuses verifiers outside RFC 7636 §4.1 (too short, too long, bad characters)', () => {
      const short = 'a'.repeat(42);
      const long = 'a'.repeat(129);
      const bad = `${'a'.repeat(42)}!`;
      expect(verifyPkceS256(short, s256(short))).toBe(false);
      expect(verifyPkceS256(long, s256(long))).toBe(false);
      expect(verifyPkceS256(bad, s256(bad))).toBe(false);
    });

    it('recognizes only S256-shaped challenges', () => {
      expect(isS256Challenge(s256(verifier))).toBe(true);
      expect(isS256Challenge('short')).toBe(false);
      expect(isS256Challenge(`${s256(verifier)}=`)).toBe(false);
    });
  });

  describe('opaque tokens', () => {
    it('mints a prefixed 256-bit token and returns only its SHA-256 for storage', () => {
      const minted = mintOpaqueToken('lzit_oat_');
      expect(minted.value).toMatch(/^lzit_oat_[A-Za-z0-9_-]{43}$/);
      expect(minted.hash).toBe(hashOpaqueToken(minted.value));
      expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(minted.hash).not.toContain(minted.value.slice(9));
    });

    it('never mints the same token twice', () => {
      const values = new Set(
        Array.from({ length: 50 }, () => mintOpaqueToken('lzit_ort_').value),
      );
      expect(values.size).toBe(50);
    });

    it('mints codes and client ids of the expected shape', () => {
      expect(mintAuthorizationCode().value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(mintClientId()).toMatch(/^lzc_[A-Za-z0-9_-]{22}$/);
    });

    it('compares in constant time and fails on length mismatch', () => {
      expect(safeEqual('abc', 'abc')).toBe(true);
      expect(safeEqual('abc', 'abd')).toBe(false);
      expect(safeEqual('abc', 'abcd')).toBe(false);
    });
  });
});
