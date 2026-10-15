import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { FixedWindowRateLimiter } from '../../oauth/oauth-rate-limit';

/**
 * LoginRateLimitGuard — a small in-memory fixed-window per-IP rate limiter for `POST /auth/login`
 * (ADR-0086 §3, brute-force decision E). The twin of {@link SetupRateLimitGuard}: this caps attempts per
 * client IP so a single host cannot spray guesses across MANY accounts, while the per-ACCOUNT exponential
 * backoff (in LoginService) slows guessing against ONE account. Over the cap → 429 Too Many Requests.
 *
 * A 429 here is NOT an enumeration oracle: it is keyed on the CLIENT IP, independent of whether any
 * account exists — every caller from that IP is throttled identically regardless of the identifier.
 *
 * In-memory + per-instance on purpose (same posture as SetupRateLimitGuard): the target is a single-org,
 * few-replica deploy; a shared Redis store would be over-engineering (no `@nestjs/throttler` dep to pull
 * in). PER-REPLICA CAVEAT: behind N replicas the effective cap is N×{@link MAX_ATTEMPTS}/window — accepted
 * for the target, and the per-account backoff + argon2 cost are the primary defenses. The map self-prunes.
 */

/** Max login attempts allowed per IP within {@link WINDOW_MS}. */
const MAX_ATTEMPTS = 10;
/** Sliding window length. */
const WINDOW_MS = 60 * 1000; // 1 minute

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(LoginRateLimitGuard.name);
  private readonly limiter = new FixedWindowRateLimiter(
    MAX_ATTEMPTS,
    WINDOW_MS,
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.clientKey(request);
    if (!this.limiter.hit(key)) {
      this.logger.warn(`login rate limit exceeded from ${key}`);
      throw new HttpException(
        'Too many login attempts. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  /**
   * Resolve a client key from Express's VERIFIED `req.ip` (SEC-010): behind Caddy it is the real client
   * the proxy reports (a forged X-Forwarded-For from the public client is dropped by `trust proxy`); in
   * dev with no proxy it is the socket address. Keying on the raw X-Forwarded-For would let a caller
   * rotate buckets per request with a fake hop, defeating the cap.
   */
  private clientKey(request: Request): string {
    return request.ip || request.socket?.remoteAddress || 'unknown';
  }
}
