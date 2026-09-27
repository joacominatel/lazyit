import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../generated/prisma/client';
import {
  CONSENT_DECISION_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  REVOKE_RATE_LIMIT,
  TOKEN_RATE_LIMIT,
} from './oauth.constants';

/**
 * A fixed-window counter per key — the `LoginRateLimitGuard` / `SetupRateLimitGuard` posture: in-memory,
 * per replica (behind N replicas the effective cap is N× the limit, accepted for a 5–20 person instance),
 * self-pruning so the map stays bounded.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Count one hit for `key`; false when the key is over its limit for the current window. */
  hit(key: string, now: number = Date.now()): boolean {
    for (const [bucketKey, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(bucketKey);
      }
    }
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }
}

/** The verified client IP (`trust proxy` resolves it — SEC-010), never a raw X-Forwarded-For. */
function clientIp(request: Request): string {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

function tooMany(): HttpException {
  return new HttpException(
    {
      error: 'rate_limited',
      error_description: 'Too many requests. Wait a moment and try again.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

abstract class IpRateLimitGuard implements CanActivate {
  protected abstract readonly limiter: FixedWindowRateLimiter;

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.limiter.hit(clientIp(request))) throw tooMany();
    return true;
  }
}

/** `POST /oauth/register`: 10 registrations per IP per hour (unauthenticated endpoint, DCR abuse). */
@Injectable()
export class RegisterRateLimitGuard extends IpRateLimitGuard {
  protected readonly limiter = new FixedWindowRateLimiter(
    REGISTER_RATE_LIMIT.max,
    REGISTER_RATE_LIMIT.windowMs,
  );
}

/** `POST /oauth/token`: per IP. */
@Injectable()
export class TokenRateLimitGuard extends IpRateLimitGuard {
  protected readonly limiter = new FixedWindowRateLimiter(
    TOKEN_RATE_LIMIT.max,
    TOKEN_RATE_LIMIT.windowMs,
  );
}

/** `POST /oauth/revoke`: per IP. */
@Injectable()
export class RevokeRateLimitGuard extends IpRateLimitGuard {
  protected readonly limiter = new FixedWindowRateLimiter(
    REVOKE_RATE_LIMIT.max,
    REVOKE_RATE_LIMIT.windowMs,
  );
}

/**
 * `POST /oauth/authorize/decision`: per authenticated user — the endpoint verifies the password for the
 * `lazyit.admin` step-up, so guessing is bounded per account, not only per IP.
 */
@Injectable()
export class ConsentDecisionRateLimitGuard implements CanActivate {
  private readonly limiter = new FixedWindowRateLimiter(
    CONSENT_DECISION_RATE_LIMIT.max,
    CONSENT_DECISION_RATE_LIMIT.windowMs,
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: User }>();
    const key = request.user?.id ?? `ip:${clientIp(request)}`;
    if (!this.limiter.hit(key)) throw tooMany();
    return true;
  }
}
