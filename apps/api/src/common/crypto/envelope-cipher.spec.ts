import {
  ENVELOPE_KEY_VERSION,
  EnvelopeCipher,
  EnvelopeDecryptError,
  EnvelopeKeyMissingError,
} from './envelope-cipher';

const HEX_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const OTHER_HEX_KEY =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

function cipherWith(key: string | undefined, purpose = 'test.secret') {
  return new EnvelopeCipher('TEST_SECRET_KEY', purpose, {
    TEST_SECRET_KEY: key,
  });
}

/** Flip one byte of a base64 field. */
function flip(b64: string): string {
  const bytes = Buffer.from(b64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

describe('EnvelopeCipher', () => {
  describe('round trip', () => {
    it('decrypts what it encrypted, with a fresh IV per value', () => {
      const cipher = cipherWith(HEX_KEY);
      const a = cipher.encrypt('sk-live-123');
      const b = cipher.encrypt('sk-live-123');
      expect(cipher.decrypt(a)).toBe('sk-live-123');
      expect(a.iv).not.toBe(b.iv);
      expect(a.ciphertext).not.toBe(b.ciphertext);
      expect(a.keyVersion).toBe(ENVELOPE_KEY_VERSION);
    });

    it('never carries the plaintext in the envelope', () => {
      const envelope = cipherWith(HEX_KEY).encrypt('sk-live-secret-value');
      expect(JSON.stringify(envelope)).not.toContain('sk-live-secret-value');
    });

    it('accepts a base64 and a raw 32-byte key as well as hex', () => {
      const base64 = Buffer.alloc(32, 7).toString('base64');
      const raw = 'a'.repeat(32);
      for (const key of [base64, raw]) {
        const cipher = cipherWith(key);
        expect(cipher.decrypt(cipher.encrypt('x'))).toBe('x');
      }
    });

    it('round-trips unicode', () => {
      const cipher = cipherWith(HEX_KEY);
      expect(cipher.decrypt(cipher.encrypt('clé—🔑'))).toBe('clé—🔑');
    });
  });

  describe('tamper detection', () => {
    const cipher = cipherWith(HEX_KEY);
    const envelope = cipher.encrypt('sk-live-123');

    it.each(['ciphertext', 'iv', 'authTag'] as const)(
      'refuses a tampered %s',
      (field) => {
        expect(() =>
          cipher.decrypt({ ...envelope, [field]: flip(envelope[field]) }),
        ).toThrow(EnvelopeDecryptError);
      },
    );

    it('refuses a truncated auth tag', () => {
      expect(() =>
        cipher.decrypt({
          ...envelope,
          authTag: Buffer.from(envelope.authTag, 'base64')
            .subarray(0, 4)
            .toString('base64'),
        }),
      ).toThrow(EnvelopeDecryptError);
    });

    it('refuses an envelope written for another purpose under the same key', () => {
      const other = cipherWith(HEX_KEY, 'other.secret');
      expect(() => other.decrypt(envelope)).toThrow(EnvelopeDecryptError);
    });

    it('refuses an unknown key version', () => {
      expect(() => cipher.decrypt({ ...envelope, keyVersion: 99 })).toThrow(
        EnvelopeDecryptError,
      );
    });

    it('never echoes the plaintext or ciphertext in the error', () => {
      try {
        cipher.decrypt({ ...envelope, authTag: flip(envelope.authTag) });
        throw new Error('expected a throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain('sk-live-123');
        expect(message).not.toContain(envelope.ciphertext);
      }
    });
  });

  describe('wrong or absent key', () => {
    it('a different key cannot decrypt', () => {
      const envelope = cipherWith(HEX_KEY).encrypt('sk-live-123');
      expect(() => cipherWith(OTHER_HEX_KEY).decrypt(envelope)).toThrow(
        EnvelopeDecryptError,
      );
    });

    it('an absent key is not configured and refuses to encrypt or decrypt', () => {
      const envelope = cipherWith(HEX_KEY).encrypt('sk-live-123');
      const absent = cipherWith(undefined);
      expect(absent.isConfigured()).toBe(false);
      expect(() => absent.encrypt('x')).toThrow(EnvelopeKeyMissingError);
      expect(() => absent.decrypt(envelope)).toThrow(EnvelopeKeyMissingError);
    });

    it('a blank or malformed key counts as absent, naming the env var', () => {
      for (const key of ['   ', 'too-short', 'ab'.repeat(20)]) {
        const cipher = cipherWith(key);
        expect(cipher.isConfigured()).toBe(false);
        expect(() => cipher.encrypt('x')).toThrow(/TEST_SECRET_KEY/);
      }
    });

    it('reads the env on every call (a key set later is picked up without a restart)', () => {
      const env: NodeJS.ProcessEnv = {};
      const cipher = new EnvelopeCipher('LATE_KEY', 'p', env);
      expect(cipher.isConfigured()).toBe(false);
      env.LATE_KEY = HEX_KEY;
      expect(cipher.isConfigured()).toBe(true);
      expect(cipher.decrypt(cipher.encrypt('ok'))).toBe('ok');
    });
  });
});
