import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DCR_CLIENT_ID_PREFIX } from './oauth.constants';

/**
 * Credential primitives of the authorization server. Pure and framework-free, modelled on the service
 * account token (ADR-0048, `service-account-token.ts`): 32 bytes of CSPRNG entropy, base64url, and only
 * the SHA-256 hex of the full token is ever persisted. High entropy makes a fast hash correct; a slow KDF
 * would only add latency. Nothing here logs.
 */

const SECRET_BYTES = 32;

/** SHA-256 hex of a presented token or code — the only form that is stored or looked up. */
export function hashOpaqueToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A minted credential: the cleartext to hand out ONCE, and the hash to persist. */
export interface MintedSecret {
  value: string;
  hash: string;
}

/** The exact body of every opaque token {@link mintOpaqueToken} has minted: unpadded base64url of the secret. */
const OPAQUE_TOKEN_BODY = new RegExp(
  `^[A-Za-z0-9_-]{${Math.ceil((SECRET_BYTES * 4) / 3)}}$`,
);

/**
 * Whether `value` has the exact shape of an opaque token minted with `prefix` (the prefix, then the
 * fixed-length base64url body). A cheap pre-filter before any lookup (SEC-083): a value that fails it can
 * never be a stored token.
 */
export function hasOpaqueTokenShape(value: string, prefix: string): boolean {
  return (
    value.startsWith(prefix) &&
    OPAQUE_TOKEN_BODY.test(value.slice(prefix.length))
  );
}

/** Mint an opaque, prefixed token (`lzit_oat_…`, `lzit_ort_…`). */
export function mintOpaqueToken(prefix: string): MintedSecret {
  const value = `${prefix}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return { value, hash: hashOpaqueToken(value) };
}

/** Mint an authorization code (unprefixed; it only ever travels in a redirect and back). */
export function mintAuthorizationCode(): MintedSecret {
  const value = randomBytes(SECRET_BYTES).toString('base64url');
  return { value, hash: hashOpaqueToken(value) };
}

/** A fresh `lzc_…` client id for a dynamically registered client. Not a secret. */
export function mintClientId(): string {
  return `${DCR_CLIENT_ID_PREFIX}${randomBytes(16).toString('base64url')}`;
}

/** Constant-time comparison of two strings; false on any length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the base64url (no padding) of a SHA-256: exactly 43 characters. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Whether a `code_challenge` has the shape of an S256 challenge. */
export function isS256Challenge(challenge: string): boolean {
  return S256_CHALLENGE.test(challenge);
}

/**
 * PKCE S256 verification (RFC 7636 §4.6): `BASE64URL(SHA256(code_verifier)) == code_challenge`, compared
 * in constant time. A missing or malformed verifier never verifies — there is no `plain` fallback and no
 * "challenge without verifier" downgrade.
 */
export function verifyPkceS256(
  verifier: string | undefined,
  challenge: string,
): boolean {
  if (verifier === undefined || !CODE_VERIFIER.test(verifier)) return false;
  if (!isS256Challenge(challenge)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}
