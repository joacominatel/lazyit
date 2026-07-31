import { HttpException, type ExecutionContext } from '@nestjs/common';
import {
  InfraReportRateLimitGuard,
  INFRA_REPORT_MAX_PER_WINDOW_DEFAULT,
} from './infra-report-rate-limit.guard';

/**
 * Build an ExecutionContext whose HTTP request carries the given SERVICE principal (the agent's SA)
 * and client IP. `serviceAccountId: null` models a non-service caller (a human, or the anonymous
 * shim) — the guard then falls back to the IP so the route is never left unthrottled.
 */
function contextFor(
  serviceAccountId: string | null,
  ip = '10.0.0.1',
): ExecutionContext {
  const request = {
    ip,
    socket: { remoteAddress: ip },
    principal:
      serviceAccountId === null
        ? undefined
        : {
            kind: 'service',
            serviceAccount: { id: serviceAccountId },
            permissions: new Set(['infra:report']),
          },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Run `canActivate` and return the thrown value (or undefined when it passed). */
function attempt(
  guard: InfraReportRateLimitGuard,
  ctx: ExecutionContext,
): unknown {
  try {
    guard.canActivate(ctx);
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('InfraReportRateLimitGuard', () => {
  const ENV_KEYS = [
    'INFRA_REPORT_MAX_PER_WINDOW',
    'INFRA_REPORT_WINDOW_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.useRealTimers();
  });

  it('allows reports up to the cap for one service account, then 429s', () => {
    const guard = new InfraReportRateLimitGuard();
    const ctx = contextFor('sa-1');
    for (let i = 0; i < INFRA_REPORT_MAX_PER_WINDOW_DEFAULT; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    const thrown = attempt(guard, ctx);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
  });

  it('keys on the SERVICE ACCOUNT, not the IP: two agents behind ONE egress NAT never share a bucket', () => {
    // The whole point of #1134: agents at a site share a public IP. An IP-keyed limiter would punish
    // every host at that site for one noisy agent. Exhaust sa-noisy from the shared IP…
    process.env.INFRA_REPORT_MAX_PER_WINDOW = '3';
    const guard = new InfraReportRateLimitGuard();
    const nat = '203.0.113.7';
    const noisy = contextFor('sa-noisy', nat);
    for (let i = 0; i < 3; i++) expect(guard.canActivate(noisy)).toBe(true);
    expect(attempt(guard, noisy)).toBeInstanceOf(HttpException);

    // …the well-behaved SA on the SAME IP is untouched.
    const quiet = contextFor('sa-quiet', nat);
    expect(guard.canActivate(quiet)).toBe(true);
  });

  it('one service account roaming across IPs still shares ONE bucket (an IP rotation cannot reset it)', () => {
    process.env.INFRA_REPORT_MAX_PER_WINDOW = '2';
    const guard = new InfraReportRateLimitGuard();
    expect(guard.canActivate(contextFor('sa-1', '10.0.0.1'))).toBe(true);
    expect(guard.canActivate(contextFor('sa-1', '10.0.0.2'))).toBe(true);
    // Third request, third source IP — the SA key is what counts, so it is still capped.
    expect(attempt(guard, contextFor('sa-1', '10.0.0.3'))).toBeInstanceOf(
      HttpException,
    );
  });

  it('THE HAPPY PATH: one agent on the 15-minute cadence never comes near the limit', () => {
    // The legitimate case this must never break (ADR-0074 §4 cadence): a single host checking in
    // every 15 minutes for a full day. 96 reports, zero rejections.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const guard = new InfraReportRateLimitGuard();
    const ctx = contextFor('sa-agent');
    for (let tick = 0; tick < 96; tick++) {
      expect(guard.canActivate(ctx)).toBe(true);
      jest.advanceTimersByTime(15 * 60 * 1000);
    }
  });

  it('a whole 100-host fleet sharing ONE agent token still fits the default burst', () => {
    // The install script writes the SAME operator token on every host, so a mass rollout (or a
    // site-wide reboot re-arming every timer at once) bursts N reports against ONE service account.
    // The default window must absorb a realistic self-hosted estate without a single 429.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    const guard = new InfraReportRateLimitGuard();
    const ctx = contextFor('sa-fleet');
    for (let host = 0; host < 100; host++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('the window resets: a throttled account recovers on the next window', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
    process.env.INFRA_REPORT_MAX_PER_WINDOW = '1';
    process.env.INFRA_REPORT_WINDOW_MS = '60000';
    const guard = new InfraReportRateLimitGuard();
    const ctx = contextFor('sa-1');
    expect(guard.canActivate(ctx)).toBe(true);
    expect(attempt(guard, ctx)).toBeInstanceOf(HttpException);
    jest.advanceTimersByTime(60_001);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('falls back to the client IP when the caller is not a service account (never unthrottled)', () => {
    process.env.INFRA_REPORT_MAX_PER_WINDOW = '2';
    const guard = new InfraReportRateLimitGuard();
    const anon = contextFor(null, '198.51.100.4');
    expect(guard.canActivate(anon)).toBe(true);
    expect(guard.canActivate(anon)).toBe(true);
    expect(attempt(guard, anon)).toBeInstanceOf(HttpException);
    // A different IP in the same fallback bucket space is independent.
    expect(guard.canActivate(contextFor(null, '198.51.100.5'))).toBe(true);
  });

  it('an IP-keyed fallback bucket can never collide with a service-account bucket', () => {
    // Defensive: the two key spaces are namespaced, so a (hypothetical) SA whose id equals an IP
    // string cannot borrow or exhaust the anonymous bucket.
    process.env.INFRA_REPORT_MAX_PER_WINDOW = '1';
    const guard = new InfraReportRateLimitGuard();
    expect(guard.canActivate(contextFor(null, '10.0.0.9'))).toBe(true);
    expect(guard.canActivate(contextFor('10.0.0.9', '10.0.0.9'))).toBe(true);
  });

  it('ignores a non-numeric / non-positive env override and keeps the default', () => {
    process.env.INFRA_REPORT_MAX_PER_WINDOW = 'nonsense';
    const guard = new InfraReportRateLimitGuard();
    const ctx = contextFor('sa-1');
    for (let i = 0; i < INFRA_REPORT_MAX_PER_WINDOW_DEFAULT; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(attempt(guard, ctx)).toBeInstanceOf(HttpException);
  });
});
