import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DIRECTORY_SECRET_KEY_ENV } from './directory.constants';

/**
 * Directory bind-password crypto (issue #839, ADR-0091). AES-256-GCM encrypt-at-rest for the SERVER-MANAGED
 * read-only LDAP BIND password — a machine credential the server MUST decrypt to authenticate the bind
 * against AD (the explicit inverse of the zero-knowledge Secret Manager, INV-10). A STANDALONE `node:crypto`
 * helper cloned from {@link file://../smtp/smtp.crypto.ts} under its OWN key axis `DIRECTORY_SECRET_KEY`
 * — "one key per subsystem" (ADR-0054/0079).
 *
 * NOT the WorkflowSecret-bound SecretService: that class persists to a `WorkflowSecret` row (requires an
 * applicationId a directory bind lacks) and fails LOUD at boot for its key. Directory sync is OPTIONAL, so
 * the key is resolved LAZILY and only when a password is actually written. If unset at write time,
 * {@link encryptBindPassword} throws {@link DirectorySecretKeyMissingError} — a clean, non-secret error the
 * controller maps to a 409; the app still boots fine without the key.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96-bit IV — the GCM-recommended size; a fresh random IV per value. */
const IV_BYTES = 12;
/** The key version stamped on new envelopes. Bump + add a key entry to rotate (future — v1 = single key). */
export const DIRECTORY_KEY_VERSION = 1;

/** The AES-256-GCM at-rest envelope (all base64 text except the integer keyVersion). */
export interface DirectorySecretEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Thrown when a bind-password write is attempted but `DIRECTORY_SECRET_KEY` is unset/invalid (→ 409). */
export class DirectorySecretKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectorySecretKeyMissingError';
  }
}

/**
 * Resolve + validate the 32-byte master key from `DIRECTORY_SECRET_KEY`. Accepts (in order): a 64-char hex
 * string, a base64 string, or a raw utf8 string — each must decode to EXACTLY 32 bytes. Returns null when
 * the var is UNSET (so callers can decide: unset is fine until a password is written). Throws on a SET but
 * wrong-length value (a misconfiguration should be loud). Mirrors `resolveSmtpSecretKey`.
 */
export function resolveDirectorySecretKey(): Buffer | null {
  const raw = process.env[DIRECTORY_SECRET_KEY_ENV]?.trim();
  if (!raw) {
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === KEY_BYTES) {
    return asBase64;
  }
  const asUtf8 = Buffer.from(raw, 'utf8');
  if (asUtf8.length === KEY_BYTES) {
    return asUtf8;
  }
  throw new DirectorySecretKeyMissingError(
    `${DIRECTORY_SECRET_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes ` +
      `(64 hex chars, base64 of 32 bytes, or a 32-char raw string). ` +
      `Generate one with: openssl rand -hex 32.`,
  );
}

/** True when a usable 32-byte directory master key is configured (drives "can I store a bind password?"). */
export function isDirectorySecretKeyConfigured(): boolean {
  try {
    return resolveDirectorySecretKey() !== null;
  } catch {
    return false;
  }
}

/** Require the key or throw the mapped-to-409 error (used at bind-password-write time). */
function requireKey(): Buffer {
  const key = resolveDirectorySecretKey();
  if (!key) {
    throw new DirectorySecretKeyMissingError(
      `${DIRECTORY_SECRET_KEY_ENV} is not set — set a 32-byte key (openssl rand -hex 32) to store an LDAP ` +
        `bind password. The rest of the directory config can be saved without it.`,
    );
  }
  return key;
}

/**
 * Encrypt a cleartext bind password into an at-rest envelope (fresh random IV per value). The cleartext is
 * consumed in memory only — never persisted or returned. Throws {@link DirectorySecretKeyMissingError} if
 * the master key is unset.
 */
export function encryptBindPassword(
  plaintext: string,
): DirectorySecretEnvelope {
  const key = requireKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion: DIRECTORY_KEY_VERSION,
  };
}

/**
 * Decrypt an envelope back to the cleartext bind password — INTERNAL ONLY (for the reconcile to bind to AD
 * at sync time). GCM verifies the auth tag; any tamper/wrong key throws a generic, payload-free error.
 * NEVER expose this across an API boundary; the cleartext leaves this process only as an LDAP bind credential.
 */
export function decryptBindPassword(envelope: DirectorySecretEnvelope): string {
  const key = requireKey();
  if (envelope.keyVersion !== DIRECTORY_KEY_VERSION) {
    throw new Error(
      `Cannot decrypt bind password: unknown key version ${envelope.keyVersion} ` +
        `(current is ${DIRECTORY_KEY_VERSION}).`,
    );
  }
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error(
      'Failed to decrypt bind password (authentication failed or wrong key).',
    );
  }
}
