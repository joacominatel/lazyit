import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SMTP_SECRET_KEY_ENV } from './email.constants';

/**
 * SMTP password crypto (issue #615, ADR-0079). AES-256-GCM encrypt-at-rest for the SERVER-MANAGED SMTP
 * password — a machine credential the server MUST read to authenticate against the relay (the explicit
 * inverse of the zero-knowledge Secret Manager, INV-10). Mirrors the proven `WorkflowSecret`
 * `secret.service.ts` crypto (same envelope shape) but is a STANDALONE `node:crypto` helper under its
 * OWN key axis `SMTP_SECRET_KEY` — "one key per subsystem" (ADR-0054/0079).
 *
 * Why node:crypto and NOT `@lazyit/shared/crypto` (which produces the byte-identical envelope): that
 * subpath pulls in ESM `@noble/*`, and apps/api's CommonJS Jest must never load it (the crypto barrel
 * says so — apps/api is a ciphertext custodian). `secret.service.ts` uses node:crypto for exactly this
 * reason; we follow that precedent.
 *
 * Key posture (differs from WorkflowSecret's fail-loud-at-boot): SMTP is OPTIONAL, so the key is
 * resolved LAZILY and only when a password is actually written. If unset at write time, {@link
 * encryptSmtpPassword} throws {@link SmtpSecretKeyMissingError} — a clean, non-secret error the
 * controller maps to a 409; the app still boots fine without the key.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96-bit IV — the GCM-recommended size; a fresh random IV per value. */
const IV_BYTES = 12;
/** The key version stamped on new envelopes. Bump + add a key entry to rotate (future — v1 = single key). */
export const SMTP_KEY_VERSION = 1;

/** The AES-256-GCM at-rest envelope (all base64 text except the integer keyVersion). */
export interface SmtpSecretEnvelope {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Thrown when a password write is attempted but `SMTP_SECRET_KEY` is unset/invalid (→ 409 at the edge). */
export class SmtpSecretKeyMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpSecretKeyMissingError';
  }
}

/**
 * Resolve + validate the 32-byte master key from `SMTP_SECRET_KEY`. Accepts (in order): a 64-char hex
 * string, a base64 string, or a raw utf8 string — each must decode to EXACTLY 32 bytes. Returns null when
 * the var is UNSET (so callers can decide: unset is fine until a password is written). Throws on a SET
 * but wrong-length value (a misconfiguration should be loud). Mirrors `resolveWorkflowSecretKey`.
 */
export function resolveSmtpSecretKey(): Buffer | null {
  const raw = process.env[SMTP_SECRET_KEY_ENV]?.trim();
  if (!raw) {
    return null;
  }
  // 1) Hex (64 chars → 32 bytes).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  // 2) base64 decoding to exactly 32 bytes.
  const asBase64 = Buffer.from(raw, 'base64');
  if (asBase64.length === KEY_BYTES) {
    return asBase64;
  }
  // 3) Raw utf8 of exactly 32 bytes.
  const asUtf8 = Buffer.from(raw, 'utf8');
  if (asUtf8.length === KEY_BYTES) {
    return asUtf8;
  }
  throw new SmtpSecretKeyMissingError(
    `${SMTP_SECRET_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes ` +
      `(64 hex chars, base64 of 32 bytes, or a 32-char raw string). ` +
      `Generate one with: openssl rand -hex 32.`,
  );
}

/** True when a usable 32-byte SMTP master key is configured (drives a clean "can I store a password?" check). */
export function isSmtpSecretKeyConfigured(): boolean {
  try {
    return resolveSmtpSecretKey() !== null;
  } catch {
    // A SET-but-invalid key: not usable → treat as not configured for the boolean probe.
    return false;
  }
}

/** Require the key or throw the mapped-to-409 error (used at password-write time). */
function requireKey(): Buffer {
  const key = resolveSmtpSecretKey();
  if (!key) {
    throw new SmtpSecretKeyMissingError(
      `${SMTP_SECRET_KEY_ENV} is not set — set a 32-byte key (openssl rand -hex 32) to store an SMTP ` +
        `password. The rest of the SMTP config can be saved without it.`,
    );
  }
  return key;
}

/**
 * Encrypt a cleartext SMTP password into an at-rest envelope (fresh random IV per value). The cleartext
 * is consumed in memory only — never persisted or returned. Throws {@link SmtpSecretKeyMissingError} if
 * the master key is unset.
 */
export function encryptSmtpPassword(plaintext: string): SmtpSecretEnvelope {
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
    keyVersion: SMTP_KEY_VERSION,
  };
}

/**
 * Decrypt an envelope back to the cleartext password — INTERNAL ONLY (for the mailer to authenticate to
 * the relay at send time). GCM verifies the auth tag; any tamper/wrong key throws a generic, payload-free
 * error. NEVER expose this across an API boundary.
 */
export function decryptSmtpPassword(envelope: SmtpSecretEnvelope): string {
  const key = requireKey();
  if (envelope.keyVersion !== SMTP_KEY_VERSION) {
    throw new Error(
      `Cannot decrypt SMTP password: unknown key version ${envelope.keyVersion} ` +
        `(current is ${SMTP_KEY_VERSION}).`,
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
      'Failed to decrypt SMTP password (authentication failed or wrong key).',
    );
  }
}
