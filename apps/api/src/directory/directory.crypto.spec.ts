import {
  decryptBindPassword,
  DirectorySecretKeyMissingError,
  encryptBindPassword,
  isDirectorySecretKeyConfigured,
  resolveDirectorySecretKey,
} from './directory.crypto';
import { DIRECTORY_SECRET_KEY_ENV } from './directory.constants';

// Directory bind-password crypto (ADR-0091) — AES-256-GCM under DIRECTORY_SECRET_KEY. The security
// invariant: encrypt→decrypt round-trips, a wrong/absent key fails cleanly, nothing leaks the plaintext,
// and the key is OPTIONAL (lazy — the app boots without it; only a bind-password write requires it).

const KEY_A =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_B =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

describe('Directory bind-password crypto', () => {
  const original = process.env[DIRECTORY_SECRET_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[DIRECTORY_SECRET_KEY_ENV];
    else process.env[DIRECTORY_SECRET_KEY_ENV] = original;
  });

  it('round-trips a bind password without leaking the cleartext', () => {
    process.env[DIRECTORY_SECRET_KEY_ENV] = KEY_A;
    const envelope = encryptBindPassword('bind-s3cret!');
    expect(envelope.ciphertext).not.toContain('bind');
    expect(JSON.stringify(envelope)).not.toContain('bind-s3cret');
    expect(decryptBindPassword(envelope)).toBe('bind-s3cret!');
  });

  it('fails to decrypt under a DIFFERENT key (GCM auth) without leaking the payload', () => {
    process.env[DIRECTORY_SECRET_KEY_ENV] = KEY_A;
    const envelope = encryptBindPassword('secret-bind');
    process.env[DIRECTORY_SECRET_KEY_ENV] = KEY_B;
    expect(() => decryptBindPassword(envelope)).toThrow(
      /authentication failed/i,
    );
    try {
      decryptBindPassword(envelope);
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-bind');
    }
  });

  it('is OPTIONAL: unset key → not configured, and a write throws the mapped-to-409 error', () => {
    delete process.env[DIRECTORY_SECRET_KEY_ENV];
    expect(isDirectorySecretKeyConfigured()).toBe(false);
    expect(resolveDirectorySecretKey()).toBeNull();
    expect(() => encryptBindPassword('x')).toThrow(
      DirectorySecretKeyMissingError,
    );
  });

  it('rejects a SET-but-wrong-length key loudly', () => {
    process.env[DIRECTORY_SECRET_KEY_ENV] = 'too-short';
    expect(() => resolveDirectorySecretKey()).toThrow(
      DirectorySecretKeyMissingError,
    );
    expect(isDirectorySecretKeyConfigured()).toBe(false);
  });
});
