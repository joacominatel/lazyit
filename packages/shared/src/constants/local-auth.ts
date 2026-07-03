/**
 * Local (first-party) authentication constants — ADR-0086, AUTH_MODE=local. Shared so `api` (the
 * LocalCredentialService that hashes/verifies) and `web` (F2 forms/limits) agree on ONE definition.
 *
 * PURE constants only: this file imports nothing and is framework/runtime-agnostic (no `@node-rs/argon2`,
 * no `jose`) so it stays leaf-safe and browser-loadable. The API maps {@link ARGON2ID_PARAMS} onto the
 * `@node-rs/argon2` Options + `Algorithm.Argon2id`; the params never leave here.
 */

/**
 * argon2id cost parameters, pinned to the OWASP "second-choice" floor (m=19 MiB, t=2, p=1). These are
 * embedded PHC-encoded in every hash, so a stored hash is self-describing; the LocalCredentialService
 * compares a stored hash's encoded params against THESE at login and transparently re-hashes when a
 * stored hash is below target (rehash-on-login). `memoryCost` is in KiB (19456 KiB = 19 MiB).
 */
export const ARGON2ID_PARAMS = {
  /** Memory cost in KiB. 19456 KiB = 19 MiB (OWASP floor). */
  memoryCost: 19456,
  /** Time cost = number of iterations. */
  timeCost: 2,
  /** Parallelism (lanes). Kept at 1 — single-threaded is fine for the target request volume. */
  parallelism: 1,
} as const;

/**
 * Hard cap on a submitted password's length, enforced BEFORE argon2 runs (anti-DoS: a multi-megabyte
 * password would otherwise pin a CPU core for the full memory-hard cost on every login attempt). Also
 * the `.max()` on the login request schema so an oversized body is rejected with a 400 pre-hash.
 */
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * Local session token (first-party JWT) lifetime, in seconds. Short by design (12h): the guard's
 * `sessionEpoch` check is the real revocation mechanism, and a short TTL is belt-and-suspenders on top.
 */
export const SESSION_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/**
 * The ONLY signature algorithm the local session token is signed and verified with. Pinned on BOTH
 * sign and verify (anti alg-confusion / `alg:none` downgrade), mirroring the OIDC path's RS256 pin.
 */
export const SESSION_TOKEN_ALG = 'HS256' as const;
