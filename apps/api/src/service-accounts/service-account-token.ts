import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SERVICE_ACCOUNT_TOKEN_PREFIX } from '@lazyit/shared';

/**
 * Lazyit-native service-account token primitives (ADR-0048). Pure, framework-agnostic functions: mint
 * a token, hash a secret, parse a presented token, and compare hashes in constant time. NO secret is
 * ever logged here (these functions never log at all).
 *
 * Token format: `lzit_sa_<serviceAccountId>_<secret>`
 *   - `lzit_sa_` — the stable, greppable marker the JwtAuthGuard matches on BEFORE the OIDC branch.
 *   - `<serviceAccountId>` — the cuid of the ServiceAccount row, so the server can look it up directly
 *     (no table scan) and then verify the secret against THAT row's stored hash.
 *   - `<secret>` — 32 bytes of CSPRNG entropy, base64url-encoded. High-entropy by construction, so a
 *     FAST hash (SHA-256) + constant-time compare is sufficient and correct — bcrypt/argon2 (designed
 *     to slow down low-entropy password guessing) would only add latency to every API call for no
 *     security gain (ADR-0048).
 *
 * The server stores ONLY `tokenHash` (SHA-256 of the secret, hex) + a short non-secret `tokenPrefix`
 * for display. The cleartext token is shown exactly once on create/rotate and is never recoverable.
 */

/** Bytes of CSPRNG entropy in the secret. 32 bytes = 256 bits — far beyond brute-force reach. */
const SECRET_BYTES = 32;

/** Characters of the full token kept as the non-secret display prefix (e.g. `lzit_sa_ckg9z1a2b…`). */
const DISPLAY_PREFIX_LENGTH = 16;

/** A freshly minted token: the cleartext to show ONCE, plus what to persist. */
export interface MintedToken {
  /** The full cleartext token `lzit_sa_<id>_<secret>`. Returned once; never stored in cleartext. */
  token: string;
  /** SHA-256 of the secret (hex). The only token material persisted. */
  tokenHash: string;
  /** A short, non-secret leading fragment of the token, for UI recognition. */
  tokenPrefix: string;
}

/** The two parts extracted from a presented token, or null if it is not a well-formed SA token. */
export interface ParsedToken {
  /** The ServiceAccount id embedded in the token. */
  serviceAccountId: string;
  /** The opaque secret to hash + compare against the row's stored `tokenHash`. */
  secret: string;
}

/**
 * Whether a raw Authorization bearer value looks like a lazyit-native service-account token. Lets the
 * guard route to the SA branch (before OIDC) on a cheap string check. Does NOT validate the secret.
 */
export function isServiceAccountToken(token: string): boolean {
  return token.startsWith(SERVICE_ACCOUNT_TOKEN_PREFIX);
}

/** SHA-256 of the secret, hex-encoded. The stored `tokenHash`. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Mint a token for a service account id. Generates a fresh 32-byte base64url secret, assembles the
 * `lzit_sa_<id>_<secret>` token, and returns the cleartext alongside what to persist (`tokenHash` +
 * `tokenPrefix`). Used by both create and rotate — rotate simply replaces the stored hash/prefix.
 */
export function mintToken(serviceAccountId: string): MintedToken {
  // base64url so the secret is URL-safe and has no characters that could be confused with the `_`
  // separators in the token format (base64url uses `-` and `_`, but the secret is the LAST segment so
  // the parser splits on the FIRST two underscores only — see parseToken).
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${SERVICE_ACCOUNT_TOKEN_PREFIX}${serviceAccountId}_${secret}`;
  return {
    token,
    tokenHash: hashSecret(secret),
    tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * Parse a presented token into its `serviceAccountId` + `secret`, or null if it is not a well-formed
 * SA token. The format is `lzit_sa_<id>_<secret>`: after stripping the `lzit_sa_` prefix, the id is
 * everything up to the FIRST remaining underscore and the secret is the rest. Splitting on the first
 * underscore (not all of them) is correct because the base64url secret may itself contain `_`, while
 * the cuid id never does. Returns null on a missing prefix, a missing separator, or an empty id/secret
 * — the guard treats null as an invalid token (401).
 */
export function parseToken(token: string): ParsedToken | null {
  if (!isServiceAccountToken(token)) {
    return null;
  }
  const rest = token.slice(SERVICE_ACCOUNT_TOKEN_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) {
    // No separator, or an empty id (`lzit_sa__secret`).
    return null;
  }
  const serviceAccountId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (secret.length === 0) {
    return null;
  }
  return { serviceAccountId, secret };
}

/**
 * Constant-time comparison of a presented secret's hash against the stored `tokenHash`. Hashes the
 * presented secret with SHA-256, then compares with `timingSafeEqual` so verification time does not
 * leak how many leading bytes matched (no early-exit timing side channel). Returns false (never throws)
 * on any length/encoding mismatch — a stored hash of a different length can never equal a fresh one.
 */
export function verifySecret(secret: string, storedTokenHash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedTokenHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch; guard it (the SHA-256 hex is always 32 bytes, but a
  // corrupt stored value could differ — fail closed without leaking via the throw).
  if (presented.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(presented, stored);
}
