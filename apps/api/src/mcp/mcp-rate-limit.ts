import { Injectable } from '@nestjs/common';
import {
  MCP_AUTH_FAILURE_RATE_LIMIT,
  MCP_CALL_RATE_LIMIT,
  MCP_REQUEST_RATE_LIMIT,
  MCP_WRITE_RATE_LIMIT,
} from './mcp.constants';

/**
 * A fixed-window counter per key (the `FixedWindowRateLimiter` of the OAuth endpoints, plus a read-only
 * `exhausted` check), self-pruning so the map stays bounded.
 */
export class WindowCounter {
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
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }

  /** Whether `key` has used up its current window, without counting a hit. */
  exhausted(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) return false;
    return bucket.count >= this.max;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.buckets.delete(key);
    }
  }
}

/**
 * Rate limits of the MCP resource server (the MCP spec: servers MUST rate-limit tool invocations;
 * mcp-and-oauth.md §5.3). In memory, per replica, fixed one-minute windows — the `LoginRateLimitGuard` /
 * OAuth posture: behind N replicas the effective cap is N× the limit, accepted for a 5–20 person
 * instance. Keys are the caller's grant (or Service Account), never a token.
 *
 *   - `request`     every authenticated `/mcp` HTTP request → HTTP 429 (a coarse backstop);
 *   - `call`        every `tools/call` → `isError` `RATE_LIMITED` (the model can wait and retry);
 *   - `write`       every mutating `tools/call` on top of `call` → `isError` `RATE_LIMITED`;
 *   - `authFailure` refused authentications per client IP → HTTP 429 (each one costs a DB lookup).
 */
@Injectable()
export class McpRateLimiter {
  private readonly requests = new WindowCounter(
    MCP_REQUEST_RATE_LIMIT.max,
    MCP_REQUEST_RATE_LIMIT.windowMs,
  );
  private readonly calls = new WindowCounter(
    MCP_CALL_RATE_LIMIT.max,
    MCP_CALL_RATE_LIMIT.windowMs,
  );
  private readonly writes = new WindowCounter(
    MCP_WRITE_RATE_LIMIT.max,
    MCP_WRITE_RATE_LIMIT.windowMs,
  );
  private readonly authFailures = new WindowCounter(
    MCP_AUTH_FAILURE_RATE_LIMIT.max,
    MCP_AUTH_FAILURE_RATE_LIMIT.windowMs,
  );

  /** Count one authenticated HTTP request; false when over the limit. */
  request(key: string, now?: number): boolean {
    return this.requests.hit(key, now);
  }

  /**
   * Count one tool call (and, for a mutation, one write); false when either limit is exceeded. A write
   * refused by the write limit still counted as a call — both are attempts.
   */
  call(key: string, mutation: boolean, now?: number): boolean {
    if (!this.calls.hit(key, now)) return false;
    return mutation ? this.writes.hit(key, now) : true;
  }

  /** Count one refused authentication from an address; false once the address is over the limit. */
  authFailure(ip: string, now?: number): boolean {
    return this.authFailures.hit(ip, now);
  }

  /** Whether an address is already over its refused-authentication limit (checked before verifying). */
  authBlocked(ip: string, now: number = Date.now()): boolean {
    return this.authFailures.exhausted(ip, now);
  }
}
