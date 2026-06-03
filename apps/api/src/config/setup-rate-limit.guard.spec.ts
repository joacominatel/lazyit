import { HttpException, type ExecutionContext } from '@nestjs/common';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

/**
 * Build an ExecutionContext whose HTTP request reports the given verified `req.ip` and an optional
 * raw X-Forwarded-For header. Mirrors Express: `req.ip` is what the app's `trust proxy` setting has
 * already resolved (the guard keys on it, NOT on the raw header — SEC-010).
 */
function contextFor(ip: string, xff?: string): ExecutionContext {
  const request = {
    ip,
    headers: (xff !== undefined
      ? { 'x-forwarded-for': xff }
      : {}) as Record<string, string | string[] | undefined>,
    socket: { remoteAddress: ip },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SetupRateLimitGuard', () => {
  let guard: SetupRateLimitGuard;

  beforeEach(() => {
    guard = new SetupRateLimitGuard();
  });

  it('allows the first attempts up to the cap, then 429s', () => {
    const ctx = contextFor('10.0.0.1');
    // 5 allowed within the window.
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    // The 6th trips the limit.
    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
  });

  it('tracks limits per client IP independently', () => {
    const a = contextFor('10.0.0.1');
    const b = contextFor('10.0.0.2');
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(a)).toBe(true);
    }
    // A different IP still gets its own fresh window.
    expect(guard.canActivate(b)).toBe(true);
  });

  it('keys on the verified req.ip, not the socket header', () => {
    // req.ip is what Express resolved per `trust proxy`; the guard trusts it directly.
    const ctx = contextFor('203.0.113.5');
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  it('a forged X-Forwarded-For does NOT rotate the bucket — same req.ip is still capped (SEC-010)', () => {
    // The attacker sends a DIFFERENT spoofed leftmost XFF on every request, but `req.ip` (the value
    // Express verified via `trust proxy`) is the same real client each time. The guard keys on
    // `req.ip`, so the spoofed header is ignored and the 5/min cap still bites on the 6th attempt.
    // Before SEC-010 the guard keyed on the leftmost XFF token, so each forged hop minted a fresh
    // bucket and the cap was never reached — this test would fail (every call returns true).
    const realIp = '198.51.100.9';
    for (let i = 0; i < 5; i++) {
      const ctx = contextFor(realIp, `1.1.1.${i}, ${realIp}`);
      expect(guard.canActivate(ctx)).toBe(true);
    }
    // 6th request, yet another forged leftmost hop — same verified client → still 429.
    const blocked = contextFor(realIp, `9.9.9.9, ${realIp}`);
    let thrown: unknown;
    try {
      guard.canActivate(blocked);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
  });
});
