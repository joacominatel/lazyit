import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * PasswordResetRateLimitGuard — a small in-memory fixed-window per-IP rate limiter for the PUBLIC
 * password-reset endpoints `POST /auth/forgot-password` and `POST /auth/reset-password` (ADR-0086 §F4).
 * The twin of {@link ../local/login-rate-limit.guard LoginRateLimitGuard}: it caps requests per client IP
 * so a single host cannot spray identifiers (forgot) or brute the token space (reset). Over the cap → 429.
 *
 * A 429 here is NOT an enumeration oracle: it is keyed on the CLIENT IP, independent of whether any
 * account exists — every caller from that IP is throttled identically regardless of the identifier/token.
 * The per-account token cap (in PasswordLifecycleService) is the complementary throttle against
 * email-bombing ONE account, and it never changes the uniform forgot response.
 *
 * In-memory + per-instance on purpose (same posture as the login/setup limiters): the target is a
 * single-org, few-replica deploy; a shared Redis store would be over-engineering. The map self-prunes.
 */

/** Max requests allowed per IP within {@link WINDOW_MS}. */
const MAX_ATTEMPTS = 10;
/** Sliding window length. */
const WINDOW_MS = 60 * 1000; // 1 minute

interface Bucket {
  count: number;
  /** Epoch-ms when the current window started; reset once `now - windowStart > WINDOW_MS`. */
  windowStart: number;
}

@Injectable()
export class PasswordResetRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PasswordResetRateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.clientKey(request);
    const now = Date.now();

    this.prune(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= MAX_ATTEMPTS) {
      this.logger.warn(
        `password-reset rate limit exceeded (${bucket.count} attempts) from ${key}`,
      );
      throw new HttpException(
        'Too many attempts. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    return true;
  }

  /**
   * Client key from Express's VERIFIED `req.ip` (SEC-010): behind Caddy it is the real client the proxy
   * reports (a forged X-Forwarded-For is dropped by `trust proxy`); in dev it is the socket address.
   */
  private clientKey(request: Request): string {
    return request.ip || request.socket?.remoteAddress || 'unknown';
  }

  /** Drop windows that have fully elapsed so the map stays bounded. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
