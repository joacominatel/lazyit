import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * SetupCsrfService — stateless CSRF tokens for the first-run setup endpoint (ADR-0043 §6 #3 / Fork #7).
 *
 * The setup endpoint is a PUBLIC pre-login surface (no session exists before the first ADMIN), so the
 * usual session-bound CSRF cookie is unavailable. We instead issue a self-verifying HMAC token: the
 * wizard fetches one via `GET /config/status` (or `GET /config/csrf`) and echoes it on the
 * `POST /config/setup` request (header `X-CSRF-Token`). The server re-derives the HMAC and accepts the
 * token only if the signature matches and it has not expired. This stops a blind cross-site POST: an
 * attacker's page cannot read the token (it is delivered in a JSON body, not a readable cookie, and
 * the CORS policy already restricts the browser origin), so it cannot forge a valid `X-CSRF-Token`.
 *
 * STATELESS by design — no DB, no server-side token store, no migration. The signing secret is derived
 * once at process start (a random per-boot key unless `SETUP_CSRF_SECRET` is set), so tokens are valid
 * only within a single server lifetime + their short TTL, which is plenty for a one-time wizard flow.
 *
 * Tokens are NOT secrets in the confidentiality sense — they are anti-CSRF nonces. The signing key is
 * never logged or returned.
 */

/** Token lifetime: long enough to fill in the wizard, short enough to bound replay. */
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Random nonce length (bytes) embedded in each token so two tokens are never identical. */
const NONCE_BYTES = 16;

@Injectable()
export class SetupCsrfService {
  /**
   * The HMAC signing key. Prefer an operator-provided `SETUP_CSRF_SECRET` (stable across restarts in a
   * multi-replica deploy); otherwise a random per-boot key — fine for the single-instance first-run.
   * Resolved once at construction so a request never reads env on the hot path.
   */
  private readonly signingKey: Buffer = (() => {
    const fromEnv = process.env.SETUP_CSRF_SECRET?.trim();
    return fromEnv && fromEnv.length > 0
      ? Buffer.from(fromEnv, 'utf8')
      : randomBytes(32);
  })();

  /**
   * Issue a fresh token: `<expiresAtMs>.<nonce>.<hmac>`. The HMAC binds the expiry + nonce so neither
   * can be tampered with. base64url keeps it header-safe.
   */
  issue(now: number = Date.now()): string {
    const expiresAt = now + TOKEN_TTL_MS;
    const nonce = randomBytes(NONCE_BYTES).toString('base64url');
    const payload = `${expiresAt}.${nonce}`;
    const signature = this.sign(payload);
    return `${payload}.${signature}`;
  }

  /**
   * Verify a token: correct shape, untampered signature (constant-time compare) and not expired.
   * Returns `true` only when all hold. Never throws — the caller maps `false` to a 403.
   */
  verify(token: string | undefined, now: number = Date.now()): boolean {
    if (!token) {
      return false;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }
    const [expiresAtRaw, nonce, signature] = parts;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt < now) {
      return false;
    }
    const expected = this.sign(`${expiresAtRaw}.${nonce}`);
    return this.constantTimeEquals(signature, expected);
  }

  /** HMAC-SHA256 of `payload` under the signing key, base64url-encoded. */
  private sign(payload: string): string {
    return createHmac('sha256', this.signingKey)
      .update(payload)
      .digest('base64url');
  }

  /** Constant-time string comparison (length-safe) to avoid leaking the signature via timing. */
  private constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
