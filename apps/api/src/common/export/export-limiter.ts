import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { FixedWindowRateLimiter } from '../../oauth/oauth-rate-limit';
import type { Principal } from '../../auth/principal';

/** Exports a principal may start per window, on top of one running at a time. */
export const EXPORT_RATE_LIMIT = { max: 5, windowMs: 60_000 } as const;

// Backstop only: a lease is released when its stream closes, this frees one whose close never came.
export const EXPORT_LEASE_MS = 10 * 60_000;

export function exportLimiterKey(principal: Principal): string {
  return principal.kind === 'service'
    ? `sa:${principal.serviceAccount.id}`
    : `user:${principal.user.id}`;
}

/** In memory and per replica, like every other limiter here (ADR-0074 §8). */
@Injectable()
export class ExportLimiter {
  private readonly rate = new FixedWindowRateLimiter(
    EXPORT_RATE_LIMIT.max,
    EXPORT_RATE_LIMIT.windowMs,
  );
  private readonly running = new Map<string, { since: number }>();

  /** Take the principal's single export slot; the returned release is idempotent. */
  acquire(key: string, now: number = Date.now()): () => void {
    const held = this.running.get(key);
    if (held && now - held.since < EXPORT_LEASE_MS) {
      throw new HttpException(
        'An export is already running for you. Wait for it to finish and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!this.rate.hit(key, now)) {
      throw new HttpException(
        'Too many exports. Wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const lease = { since: now };
    this.running.set(key, lease);
    return () => {
      if (this.running.get(key) === lease) this.running.delete(key);
    };
  }
}
