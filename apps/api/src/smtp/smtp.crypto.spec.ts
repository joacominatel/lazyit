import {
  decryptSmtpPassword,
  encryptSmtpPassword,
  isSmtpSecretKeyConfigured,
  resolveSmtpSecretKey,
  SmtpSecretKeyMissingError,
} from './smtp.crypto';
import { SMTP_SECRET_KEY_ENV } from './email.constants';

// SMTP password crypto (ADR-0079) — AES-256-GCM under SMTP_SECRET_KEY. The core security invariant:
// encrypt→decrypt round-trips, a wrong/absent key fails cleanly, and nothing leaks the plaintext.

const KEY_A =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_B =
  'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

describe('SMTP password crypto', () => {
  const original = process.env[SMTP_SECRET_KEY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[SMTP_SECRET_KEY_ENV];
    else process.env[SMTP_SECRET_KEY_ENV] = original;
  });

  it('round-trips a password (encrypt then decrypt returns the original)', () => {
    process.env[SMTP_SECRET_KEY_ENV] = KEY_A;
    const envelope = encryptSmtpPassword('sup3r-s3cret!');
    // The envelope never carries the cleartext.
    expect(envelope.ciphertext).not.toContain('sup3r');
    expect(JSON.stringify(envelope)).not.toContain('sup3r');
    expect(decryptSmtpPassword(envelope)).toBe('sup3r-s3cret!');
  });

  it('uses a fresh IV per call (two encryptions of the same value differ)', () => {
    process.env[SMTP_SECRET_KEY_ENV] = KEY_A;
    const a = encryptSmtpPassword('same');
    const b = encryptSmtpPassword('same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to decrypt under a DIFFERENT key (GCM auth) without leaking the payload', () => {
    process.env[SMTP_SECRET_KEY_ENV] = KEY_A;
    const envelope = encryptSmtpPassword('secret-value');
    process.env[SMTP_SECRET_KEY_ENV] = KEY_B;
    expect(() => decryptSmtpPassword(envelope)).toThrow(
      /authentication failed/i,
    );
    try {
      decryptSmtpPassword(envelope);
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-value');
    }
  });

  it('throws SmtpSecretKeyMissingError when the key is UNSET at write time', () => {
    delete process.env[SMTP_SECRET_KEY_ENV];
    expect(() => encryptSmtpPassword('x')).toThrow(SmtpSecretKeyMissingError);
    expect(isSmtpSecretKeyConfigured()).toBe(false);
    expect(resolveSmtpSecretKey()).toBeNull();
  });

  it('rejects a SET-but-wrong-length key loudly', () => {
    process.env[SMTP_SECRET_KEY_ENV] = 'too-short';
    expect(() => resolveSmtpSecretKey()).toThrow(SmtpSecretKeyMissingError);
    expect(isSmtpSecretKeyConfigured()).toBe(false);
  });

  it('accepts a 64-char hex key and reports configured', () => {
    process.env[SMTP_SECRET_KEY_ENV] = KEY_A;
    expect(resolveSmtpSecretKey()).toHaveLength(32);
    expect(isSmtpSecretKeyConfigured()).toBe(true);
  });
});
