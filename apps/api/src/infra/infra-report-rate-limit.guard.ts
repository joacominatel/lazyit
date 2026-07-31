import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { type Principal, isServicePrincipal } from '../auth/principal';
import { parseEnvInt } from '../common/parse-env-int';

/**
 * InfraReportRateLimitGuard — an in-memory fixed-window rate limiter for `POST /infra/report`
 * (#1134, the availability half of ADR-0074 §8). The fourth sibling of {@link SetupRateLimitGuard} /
 * {@link LoginRateLimitGuard} / {@link PasswordResetRateLimitGuard}, with ONE deliberate difference:
 * it keys on the SERVICE ACCOUNT, not the client IP.
 *
 * WHY NOT THE IP. ADR-0074 §8 reasons about a leaked agent token in AUTHORIZATION terms ("PENDING
 * spam a human discards") and is right about that — but the endpoint is also a WRITE amplifier: each
 * report carries a `specs` jsonb blob, and a misconfigured timer (`OnUnitActiveSec=1s`) or a leaked
 * token turns that into unbounded jsonb churn on a self-hosted box. Throttling is therefore about
 * availability. Keying it on the IP would be actively wrong for this route: reporting agents sit
 * BEHIND A SHARED EGRESS NAT (that is the normal topology for a server estate), so an IP bucket
 * would let one noisy agent starve every other host at the same site. The service-account id is the
 * only key that isolates the actual abuser — and, unlike `reportingSource` (a client-chosen string
 * an attacker can rotate per request), it is SERVER-resolved by {@link JwtAuthGuard} from the token.
 *
 * NON-SERVICE CALLERS fall back to the verified `req.ip` (SEC-010) rather than going unthrottled —
 * `infra:report` is grantable to a human role, and an unkeyed caller must never be the way around
 * the cap. The two key spaces are namespaced so they cannot collide.
 *
 * In-memory + per-instance on purpose (the same posture as the three sibling limiters): a single-org,
 * few-replica deploy, no `@nestjs/throttler` dependency to pull in. PER-REPLICA CAVEAT: behind N
 * replicas the effective cap is N×{@link INFRA_REPORT_MAX_PER_WINDOW_DEFAULT}/window — accepted,
 * because the hard PENDING cap in `InfraService.ingestReport` (the row-count ceiling this pairs with)
 * is DB-truth and therefore replica-proof. The map self-prunes.
 */

/**
 * Max reports per service account per window. The default is sized off the REAL fleet shape, not a
 * gut feeling: `install.sh` writes the SAME operator token on every host, so one service account
 * fronts the whole estate, and a mass rollout (or a site-wide reboot re-arming every `Persistent=true`
 * timer at once) bursts one report per host into a single minute. 120/min absorbs a 100-host estate
 * with headroom while still capping a runaway agent at ~2 writes/second. Raise
 * `INFRA_REPORT_MAX_PER_WINDOW` on a larger estate.
 */
export const INFRA_REPORT_MAX_PER_WINDOW_DEFAULT = 120;
/** Fixed window length — one minute, matching the sibling limiters. */
export const INFRA_REPORT_WINDOW_MS_DEFAULT = 60 * 1000;

interface Bucket {
  count: number;
  /** Epoch-ms when the current window started; reset once `now - windowStart > windowMs`. */
  windowStart: number;
}

@Injectable()
export class InfraReportRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(InfraReportRateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();

  // Read once at construction (the guard is a singleton provider): unlike the PENDING cap, changing a
  // rate limit mid-flight would silently reinterpret buckets already in the map, so this one is pinned
  // for the process lifetime.
  private readonly maxPerWindow = parseEnvInt(
    'INFRA_REPORT_MAX_PER_WINDOW',
    INFRA_REPORT_MAX_PER_WINDOW_DEFAULT,
  );
  private readonly windowMs = parseEnvInt(
    'INFRA_REPORT_WINDOW_MS',
    INFRA_REPORT_WINDOW_MS_DEFAULT,
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal }>();
    const key = this.callerKey(request);
    const now = Date.now();

    // Opportunistic prune so the map cannot grow unbounded across many callers.
    this.prune(now);

    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= this.maxPerWindow) {
      this.logger.warn(
        `infra report rate limit exceeded (${bucket.count} reports) from ${key}`,
      );
      throw new HttpException(
        'Too many inventory reports. Slow the agent report interval, or raise INFRA_REPORT_MAX_PER_WINDOW.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
    return true;
  }

  /**
   * The throttle key: the authenticated SERVICE ACCOUNT id when there is one (`sa:<id>`), else the
   * verified `req.ip` (`ip:<addr>`). `request.principal` is populated by the global `JwtAuthGuard`,
   * which runs BEFORE a method-level `@UseGuards` — the same ordering {@link HumanOnlyGuard} relies on.
   * The prefixes keep the two key spaces disjoint, so an id that happens to look like an address can
   * never share (or exhaust) another caller's bucket.
   */
  private callerKey(request: Request & { principal?: Principal }): string {
    if (isServicePrincipal(request.principal)) {
      return `sa:${request.principal.serviceAccount.id}`;
    }
    return `ip:${request.ip || request.socket?.remoteAddress || 'unknown'}`;
  }

  /** Drop windows that have fully elapsed so the map stays bounded. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
