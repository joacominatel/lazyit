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
 * SetupRateLimitGuard — a small in-memory fixed-window rate limiter for `POST /config/setup`
 * (ADR-0043 §6 #3 / Fork #7: the public setup surface must be rate-limited).
 *
 * The setup endpoint is a privileged PUBLIC pre-login surface, so it must not be brute-forceable
 * (e.g. someone racing to create the first ADMIN, or hammering CSRF/validation). We cap attempts per
 * client IP in a sliding fixed window; over the cap → 429 Too Many Requests. The window resets so a
 * legitimate operator who mistyped is not locked out for long.
 *
 * In-memory + per-instance on purpose: first-run is a single-instance, single-org event (a fresh
 * deploy has no replicas serving the wizard yet), so a shared store (Redis) would be over-engineering
 * here — there is no `@nestjs/throttler` dependency to pull in. The map is tiny and self-pruning.
 *
 * Scoped to the setup route only (registered on that controller method), never global.
 */

/** Max attempts allowed per IP within {@link WINDOW_MS}. */
const MAX_ATTEMPTS = 5;
/** Sliding window length. */
const WINDOW_MS = 60 * 1000; // 1 minute

interface Bucket {
  count: number;
  /** Epoch-ms when the current window started; reset once `now - windowStart > WINDOW_MS`. */
  windowStart: number;
}

@Injectable()
export class SetupRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(SetupRateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = this.clientKey(request);
    const now = Date.now();

    // Opportunistic prune so the map cannot grow unbounded under many distinct IPs.
    this.prune(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= MAX_ATTEMPTS) {
      this.logger.warn(
        `setup rate limit exceeded (${bucket.count} attempts) from ${key}`,
      );
      throw new HttpException(
        'Too many setup attempts. Please wait a minute and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    return true;
  }

  /** Resolve a client key from the request: the first X-Forwarded-For hop, else the socket IP. */
  private clientKey(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const xff = first?.split(',')[0]?.trim();
    return xff || request.ip || request.socket?.remoteAddress || 'unknown';
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
