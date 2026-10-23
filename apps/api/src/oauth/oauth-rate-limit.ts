import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';
import type { User } from '../../generated/prisma/client';
import {
  CONSENT_DECISION_RATE_LIMIT,
  RATE_LIMIT_MAX_KEYS,
  REGISTER_RATE_LIMIT,
  REVOKE_RATE_LIMIT,
  TOKEN_RATE_LIMIT,
} from './oauth.constants';

/**
 * A fixed-window counter per key — the `LoginRateLimitGuard` / `SetupRateLimitGuard` posture: in-memory,
 * per replica (behind N replicas the effective cap is N× the limit, accepted for a 5–20 person instance).
 * Shared by the OAuth endpoints, the CIMD fetch limit and the MCP resource server.
 *
 * Constant work per hit, whatever the number of keys (AUD-005): a bucket is (re)inserted only when its
 * window opens, so the map's insertion order is window-start order — expired buckets are dropped from the
 * front until the first live one, and past `maxKeys` the oldest window is evicted (it was the next to
 * expire; its key starts a fresh count).
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = RATE_LIMIT_MAX_KEYS,
  ) {}

  /** Count one hit for `key`; false when the key is over its limit for the current window. */
  hit(key: string, now: number = Date.now()): boolean {
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (bucket && now - bucket.windowStart < this.windowMs) {
      if (bucket.count >= this.max) return false;
      bucket.count += 1;
      return true;
    }
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
    this.buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  /** Whether `key` has used up its current window, without counting a hit. */
  exhausted(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) return false;
    return bucket.count >= this.max;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart < this.windowMs) return;
      this.buckets.delete(key);
    }
  }
}

/** The verified client IP (`trust proxy` resolves it — SEC-010), never a raw X-Forwarded-For. */
function clientIp(request: Request): string {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

/**
 * The rate-limit key of an address for `POST /oauth/register` (#1683): an IPv4 address as is, an IPv6
 * address by its /64 prefix. One host on IPv6 normally holds a whole /64 and can pick a fresh address
 * per request from it, so keying on the full address would hand it ~2^64 budgets. An IPv4-mapped IPv6
 * address (`::ffff:192.0.2.1`, what a dual-stack socket reports) is keyed as the IPv4 it carries, and a
 * zone index (`fe80::1%eth0`) is ignored. Anything that is not an IP is returned unchanged.
 */
export function registrationRateKey(ip: string): string {
  const address = ip.split('%')[0];
  const version = isIP(address);
  if (version !== 6) return version === 4 ? address : ip;
  const groups = expandIpv6(address);
  if (!groups) return ip;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, an embedded dotted IPv4 converted). */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map(
    (group) => parseInt(group, 16),
  );
  return groups.every((group) => Number.isInteger(group) && group <= 0xffff)
    ? groups
    : null;
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

  /** The bucket a client address counts against: the address itself unless a guard says otherwise. */
  protected keyOf(ip: string): string {
    return ip;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!this.limiter.hit(this.keyOf(clientIp(request)))) throw tooMany();
    return true;
  }
}

/**
 * `POST /oauth/register`: 10 registrations per hour per IPv4 address or per IPv6 /64 (unauthenticated
 * endpoint, DCR abuse; {@link registrationRateKey}).
 */
@Injectable()
export class RegisterRateLimitGuard extends IpRateLimitGuard {
  protected readonly limiter = new FixedWindowRateLimiter(
    REGISTER_RATE_LIMIT.max,
    REGISTER_RATE_LIMIT.windowMs,
  );

  protected override keyOf(ip: string): string {
    return registrationRateKey(ip);
  }
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
