import { createHash, randomBytes } from 'node:crypto';

/**
 * Local-mode password-reset token primitives (ADR-0086 §F4 / SECURITY GAP #7). Pure, framework-agnostic
 * functions — the SAME hash-at-rest mold as the service-account token (ADR-0080): the RAW token is a
 * high-entropy CSPRNG value emailed to the user; the server stores only its SHA-256 and looks a
 * presented token up BY that hash. A fast hash (SHA-256) is correct here for the SAME reason as the SA
 * token — the secret is high-entropy (256 bits), so argon2 would only add latency for no security gain.
 * NO token material is ever logged (these functions never log).
 *
 * Why no `timingSafeEqual` compare (unlike the SA token): the SA path parses an ID out of the token and
 * fetches ONE row, then compares the secret in constant time. A reset token carries no id — it is looked
 * up directly by its (unique-indexed) hash, so there is no per-candidate secret comparison to leak. An
 * unknown token is a point-read miss, identical in shape to a known-but-expired/used token's rejection
 * (the service returns the SAME generic error for all three), so there is no oracle to protect with a
 * constant-time compare here.
 */

/** Bytes of CSPRNG entropy in the raw token. 32 bytes = 256 bits — far beyond brute-force reach. */
const TOKEN_BYTES = 32;

/** A freshly minted reset token: the raw value to email ONCE, plus the hash to persist. */
export interface MintedResetToken {
  /** The raw base64url token placed in the emailed link. Returned once; never stored in cleartext. */
  raw: string;
  /** SHA-256(raw) as lowercase hex — the only token material persisted (the `tokenHash` column). */
  tokenHash: string;
}

/** SHA-256 of the raw token, hex-encoded. The stored `tokenHash` and the reset lookup key. */
export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Mint a reset token: 32 bytes of CSPRNG entropy, base64url-encoded (URL-safe for the emailed link),
 * plus its SHA-256 to store. Uses `node:crypto` (never `Math.random`).
 */
export function mintResetToken(): MintedResetToken {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return { raw, tokenHash: hashResetToken(raw) };
}
