import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  hash as argon2Hash,
  hashSync as argon2HashSync,
  verify as argon2Verify,
  type Options,
} from '@node-rs/argon2';
import {
  ARGON2ID_PARAMS,
  PASSWORD_MAX_LENGTH,
  SESSION_TOKEN_ALG,
  SESSION_TOKEN_TTL_SECONDS,
} from '@lazyit/shared';

// argon2id = 2 in @node-rs/argon2's `Algorithm` const enum. The numeric literal avoids importing an
// ambient const enum as a VALUE (forbidden under `isolatedModules`); typed off Options so it stays sound.
const ARGON2ID: NonNullable<Options['algorithm']> = 2;

/** The `@node-rs/argon2` options for a fresh hash, mapping the shared OWASP-floor params onto argon2id. */
const HASH_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: ARGON2ID_PARAMS.memoryCost,
  timeCost: ARGON2ID_PARAMS.timeCost,
  parallelism: ARGON2ID_PARAMS.parallelism,
};

/** The minimum User shape needed to mint a session — id + the revocation epoch. Nothing else. */
export interface SessionSubject {
  id: string;
  sessionEpoch: number;
}

/** The verified claims carried by a local session token. NOTHING authorization-bearing (no role). */
export interface SessionClaims {
  /** The User.id the token was minted for. */
  sub: string;
  /** The `sessionEpoch` snapshot at mint time — compared to the live row's epoch to detect revocation. */
  epoch: number;
}

/** The outcome of {@link LocalCredentialService.verify}. */
export interface VerifyResult {
  /** Whether the password matched the stored hash. FALSE on a null/empty/malformed stored hash. */
  valid: boolean;
  /**
   * Whether the stored hash's encoded cost params are BELOW the current target (or not argon2id), so the
   * caller should transparently re-hash on this successful login. Always false when `valid` is false.
   */
  needsRehash: boolean;
}

/**
 * LocalCredentialService — the credential + session primitives for AUTH_MODE=local (ADR-0086 §3/§4).
 * Security-critical trust boundary; models the discipline of the Service-Account token path
 * (constant-time, fail-closed, alg-pinned) but with a SLOW KDF (argon2id) because a human password is
 * low-entropy (the SA path uses fast SHA-256 by design — high-entropy secret).
 *
 * Split from the login flow (LoginService) and the guard on purpose: this class NEVER reads the DB and
 * NEVER touches Secret-Manager vault key material (INV-10, §7) — it only hashes/verifies passwords and
 * signs/verifies the first-party session JWT. `LocalIdentityProvider` stays a pure no-op; local
 * credentials live here, not in the IdP mirroring seam.
 */
@Injectable()
export class LocalCredentialService {
  /**
   * A precomputed argon2id hash of a random throwaway value, lazily computed once and reused. Verifying a
   * presented password against THIS (same cost params) when there is no real stored hash keeps login
   * timing uniform between "user/hash exists" and "does not" — closing the enumeration/timing oracle
   * (the INV-SA-1 discipline). Lazy (not module-scope) so merely importing this class costs no argon2 run.
   */
  private dummyHash: string | null = null;

  private getDummyHash(): string {
    if (this.dummyHash === null) {
      this.dummyHash = argon2HashSync(
        randomBytes(32).toString('hex'),
        HASH_OPTIONS,
      );
    }
    return this.dummyHash;
  }

  /**
   * Hash a plaintext password with argon2id (PHC-encoded, per-hash random salt, OWASP-floor params).
   * Caps length before argon2 (anti-DoS). Used by set-password / rehash-on-login (F1b) and provisioning
   * (F1c). NEVER logs the password.
   */
  async hash(password: string): Promise<string> {
    if (password.length > PASSWORD_MAX_LENGTH) {
      throw new Error(
        `password exceeds the maximum length of ${PASSWORD_MAX_LENGTH} characters`,
      );
    }
    return argon2Hash(password, HASH_OPTIONS);
  }

  /**
   * Verify a password against a stored hash. CONSTANT-TIME and FAIL-CLOSED:
   *  - A null/empty stored hash NEVER authenticates (returns invalid) — but still runs an argon2 verify
   *    against the dummy hash first, so its timing matches a real verify (no "unknown user is faster"
   *    oracle). This is why the login flow passes `user?.passwordHash ?? null` here for BOTH the
   *    unknown-user and the null-passwordHash cases.
   *  - An oversized password is rejected before argon2 (anti-DoS), returning invalid.
   *  - A malformed stored hash makes argon2 throw → caught → invalid (never throws an auth decision).
   *
   * On a valid match, `needsRehash` reflects whether the stored hash is below the current target params.
   */
  async verify(
    storedHash: string | null | undefined,
    password: string,
  ): Promise<VerifyResult> {
    // Anti-DoS: an oversized password never reaches the memory-hard KDF.
    if (password.length > PASSWORD_MAX_LENGTH) {
      return { valid: false, needsRehash: false };
    }
    const hasHash = typeof storedHash === 'string' && storedHash.length > 0;
    const target = hasHash ? storedHash : this.getDummyHash();

    let matched = false;
    try {
      matched = await argon2Verify(target, password);
    } catch {
      matched = false;
    }

    // FAIL CLOSED: a null/empty stored hash never authenticates, regardless of the dummy verify result
    // (which is designed never to match a real password anyway). The dummy verify above ran ONLY to keep
    // timing uniform.
    if (!hasHash) {
      return { valid: false, needsRehash: false };
    }
    return {
      valid: matched,
      needsRehash: matched && this.needsRehash(storedHash),
    };
  }

  /**
   * Whether a PHC-encoded stored hash should be upgraded: not argon2id, or its encoded `m`/`t`/`p` are
   * below the current {@link ARGON2ID_PARAMS} target. A hash we cannot parse is treated as needing a
   * rehash (fail towards stronger).
   */
  private needsRehash(phc: string): boolean {
    if (!phc.startsWith('$argon2id$')) {
      return true;
    }
    const params = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
    if (!params) {
      return true;
    }
    const mem = Number(params[1]);
    const time = Number(params[2]);
    const par = Number(params[3]);
    return (
      mem < ARGON2ID_PARAMS.memoryCost ||
      time < ARGON2ID_PARAMS.timeCost ||
      par < ARGON2ID_PARAMS.parallelism
    );
  }

  /**
   * Mint a first-party session token: a compact JWS (JWT) signed HMAC-SHA256 (HS256) with
   * SESSION_SIGNING_SECRET. Payload is `{ sub, epoch }` + standard `iat`/`exp` — NOTHING
   * authorization-bearing (role is always resolved DB-first every request, INV-1). Short TTL; the epoch
   * is the real revocation lever.
   *
   * Hand-rolled on `node:crypto` (createHmac) rather than a JWT library — this mirrors the Service-Account
   * token precedent (ADR-0048: node:crypto HMAC + timingSafeEqual, no external crypto framework) and keeps
   * the alg-pin fully unit-testable. The format is a standard `base64url(header).base64url(payload).sig`.
   */
  // async by CONTRACT (uniform with hash/verify, awaited by callers, throws surface as rejections); the
  // HMAC itself is synchronous, hence no `await`.
  // eslint-disable-next-line @typescript-eslint/require-await
  async mintSession(subject: SessionSubject): Promise<string> {
    const secret = this.signingSecret();
    const now = Math.floor(Date.now() / 1000);
    const header = encodeSegment({ alg: SESSION_TOKEN_ALG, typ: 'JWT' });
    const payload = encodeSegment({
      sub: subject.id,
      epoch: subject.sessionEpoch,
      iat: now,
      exp: now + SESSION_TOKEN_TTL_SECONDS,
    });
    const signingInput = `${header}.${payload}`;
    const signature = createHmac('sha256', secret)
      .update(signingInput)
      .digest('base64url');
    return `${signingInput}.${signature}`;
  }

  /**
   * Verify a presented session token and return its `{ sub, epoch }` claims, or THROW (the guard catches →
   * generic 401). Security invariants, in order:
   *   1. ALG-PIN: decode the header and REJECT anything whose `alg` is not exactly `HS256` — closes the
   *      `alg:none` downgrade and RS256/alg-confusion forgery (mirrors the OIDC path's RS256 pin).
   *   2. CONSTANT-TIME signature check: recompute the HMAC over `header.payload` and `timingSafeEqual` it
   *      against the presented signature (no early-exit byte-compare leak — the SA-token discipline).
   *   3. Enforce `exp` (expiry) and require a valid string `sub` + integer `epoch`.
   * NEVER trusts a role/permission from the token (there is none in it).
   */
  // async by CONTRACT (see mintSession); HMAC verification is synchronous, so no `await`.
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifySession(token: string): Promise<SessionClaims> {
    const secret = this.signingSecret();
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('malformed session token');
    }
    const [headerSeg, payloadSeg, signatureSeg] = parts;

    // (1) ALG-PIN — reject any alg but HS256 BEFORE spending an HMAC. This is what defeats `alg:none`
    // (an unsigned token) and an RS256-forged token: neither carries `alg:"HS256"`, so both are refused.
    const header = decodeSegment(headerSeg);
    if (
      !header ||
      typeof header !== 'object' ||
      (header as { alg?: unknown }).alg !== SESSION_TOKEN_ALG
    ) {
      throw new Error('session token uses an unexpected or missing algorithm');
    }

    // (2) CONSTANT-TIME signature verification.
    const expected = createHmac('sha256', secret)
      .update(`${headerSeg}.${payloadSeg}`)
      .digest('base64url');
    const presentedBuf = Buffer.from(signatureSeg);
    const expectedBuf = Buffer.from(expected);
    if (
      presentedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(presentedBuf, expectedBuf)
    ) {
      throw new Error('session token signature is invalid');
    }

    // (3) Claim checks.
    const payload = decodeSegment(payloadSeg);
    if (!payload || typeof payload !== 'object') {
      throw new Error('session token has a malformed payload');
    }
    const { sub, epoch, exp } = payload as {
      sub?: unknown;
      epoch?: unknown;
      exp?: unknown;
    };
    if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) {
      throw new Error('session token is expired');
    }
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new Error('session token is missing a valid sub claim');
    }
    if (typeof epoch !== 'number' || !Number.isInteger(epoch)) {
      throw new Error('session token is missing a valid epoch claim');
    }
    return { sub, epoch };
  }

  /**
   * The HMAC signing key. Reads SESSION_SIGNING_SECRET at call time (env is stable; lets tests set it).
   * boot-config already asserts it is present + ≥32 chars in local mode; this is a defensive fail-loud for
   * any misconfiguration that slipped past boot (mint/verify then throws rather than signing with a weak key).
   */
  private signingSecret(): string {
    const secret = process.env.SESSION_SIGNING_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        'SESSION_SIGNING_SECRET is not configured (AUTH_MODE=local requires a secret of at least 32 characters)',
      );
    }
    return secret;
  }
}

/** base64url-encode a JSON object as a JWT segment. */
function encodeSegment(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Decode a base64url JWT segment back to an object, or null if it is not valid JSON. */
function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
