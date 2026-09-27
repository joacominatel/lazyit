import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A generic AES-256-GCM at-rest envelope keyed by an ENV VAR NAME (ADR-0097 decision 7; security.md §6.5;
 * provider-and-runtime.md §12). It generalizes the per-subsystem helpers `smtp.crypto.ts` and
 * `directory.crypto.ts` — same envelope shape, same key-resolution rules — so a new subsystem gets its own
 * key axis ("one key per subsystem", ADR-0054/0079) without copying the crypto again. SMTP and directory
 * are not migrated onto it.
 *
 * node:crypto, not `@lazyit/shared/crypto`: the api's CommonJS Jest must never load the ESM `@noble/*`
 * that subpath pulls in (the `smtp.crypto.ts` rationale).
 *
 * Key posture: the key is OPTIONAL and resolved LAZILY, on every call, so the API boots without it and a
 * subsystem that never stores a secret never needs it. Writing without a usable key throws
 * {@link EnvelopeKeyMissingError} (the edge maps it to 409). A key that is SET but malformed is treated
 * as missing — loud in the message, never a crash at boot.
 *
 * Every failure message is fixed and payload-free: no plaintext, ciphertext or key material ever lands in
 * an error, a log or a response.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96-bit IV — the GCM-recommended size; a fresh random IV per value. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** The key version stamped on new envelopes. Rotation (a second key entry) is future work, as for SMTP. */
export const ENVELOPE_KEY_VERSION = 1;

/** The at-rest envelope: base64 text columns plus the integer key version. */
export interface SecretEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** No usable key under the configured env var — a precondition, mapped to 409 at the edge. */
export class EnvelopeKeyMissingError extends Error {
  constructor(readonly envVar: string) {
    super(
      `${envVar} is not set or is not a 32-byte key — set one (openssl rand -hex 32) to store this secret.`,
    );
    this.name = 'EnvelopeKeyMissingError';
  }
}

/** The envelope could not be opened: wrong key, unknown key version, or tampered data. */
export class EnvelopeDecryptError extends Error {
  constructor() {
    super(
      'The stored secret could not be decrypted (wrong key or tampered data).',
    );
    this.name = 'EnvelopeDecryptError';
  }
}

/**
 * Decode a key: a 64-char hex string, base64 of exactly 32 bytes, or a raw 32-byte utf8 string (the
 * `resolveSmtpSecretKey` order). Returns null when unset or malformed.
 */
function decodeKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  const asBase64 = Buffer.from(value, 'base64');
  if (asBase64.length === KEY_BYTES) return asBase64;
  const asUtf8 = Buffer.from(value, 'utf8');
  if (asUtf8.length === KEY_BYTES) return asUtf8;
  return null;
}

export class EnvelopeCipher {
  /**
   * @param envVar  the env var that holds this subsystem's key (e.g. `AI_SECRET_KEY`).
   * @param purpose bound as GCM additional authenticated data, so an envelope written for one purpose
   *                cannot be replayed into another column that shares the key.
   * @param env     the environment to read (injectable for tests); read on every call.
   */
  constructor(
    readonly envVar: string,
    private readonly purpose: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Whether a usable key is configured now. */
  isConfigured(): boolean {
    return decodeKey(this.env[this.envVar]) !== null;
  }

  /** Encrypt a secret under a fresh IV. Throws {@link EnvelopeKeyMissingError} without a usable key. */
  encrypt(plaintext: string): SecretEnvelope {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(this.purpose, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: ENVELOPE_KEY_VERSION,
    };
  }

  /**
   * Open an envelope. INTERNAL ONLY — the plaintext never crosses an API boundary. Throws
   * {@link EnvelopeKeyMissingError} without a key and {@link EnvelopeDecryptError} on a wrong key, an
   * unknown version or any tamper (GCM verifies the tag over the ciphertext and the purpose).
   */
  decrypt(envelope: SecretEnvelope): string {
    const key = this.requireKey();
    if (envelope.keyVersion !== ENVELOPE_KEY_VERSION) {
      throw new EnvelopeDecryptError();
    }
    try {
      const authTag = Buffer.from(envelope.authTag, 'base64');
      if (authTag.length !== AUTH_TAG_BYTES) throw new EnvelopeDecryptError();
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(envelope.iv, 'base64'),
        { authTagLength: AUTH_TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(this.purpose, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new EnvelopeDecryptError();
    }
  }

  private requireKey(): Buffer {
    const key = decodeKey(this.env[this.envVar]);
    if (!key) throw new EnvelopeKeyMissingError(this.envVar);
    return key;
  }
}
