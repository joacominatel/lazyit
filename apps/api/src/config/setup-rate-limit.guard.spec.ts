import { HttpException, type ExecutionContext } from '@nestjs/common';
import { SetupRateLimitGuard } from './setup-rate-limit.guard';

/** Build an ExecutionContext whose HTTP request reports the given client IP. */
function contextFor(ip: string): ExecutionContext {
  const request = {
    ip,
    headers: {} as Record<string, string | string[] | undefined>,
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

  it('prefers the first X-Forwarded-For hop as the client key', () => {
    const request = {
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    // 5 from the same forwarded client, then 429 — proving the XFF hop, not the proxy socket IP,
    // is the rate-limit key.
    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });
});
