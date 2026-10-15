import { HttpException, type ExecutionContext } from '@nestjs/common';
import { FixedWindowRateLimiter } from '../../oauth/oauth-rate-limit';
import { SetupRateLimitGuard } from '../../config/setup-rate-limit.guard';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { PasswordResetRateLimitGuard } from './password-reset-rate-limit.guard';

function contextFor(ip: string): ExecutionContext {
  const request = { ip, headers: {}, socket: { remoteAddress: ip } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : undefined;
  }
  return undefined;
}

describe.each([
  ['LoginRateLimitGuard', () => new LoginRateLimitGuard(), 10],
  ['PasswordResetRateLimitGuard', () => new PasswordResetRateLimitGuard(), 10],
  ['SetupRateLimitGuard', () => new SetupRateLimitGuard(), 5],
])('%s', (_name, build, max) => {
  afterEach(() => jest.restoreAllMocks());

  it('allows the cap per client IP, then 429s, and reopens when the window elapses', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const guard = build();
    const ctx = contextFor('10.0.0.1');
    for (let i = 0; i < max; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    expect(statusOf(() => guard.canActivate(ctx))).toBe(429);
    // Another client keeps its own window.
    expect(guard.canActivate(contextFor('10.0.0.2'))).toBe(true);

    now.mockReturnValue(1_000_000 + 60_001);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('counts through the shared constant-work limiter, not a per-guard map scan', () => {
    const hit = jest.spyOn(FixedWindowRateLimiter.prototype, 'hit');
    const guard = build();
    guard.canActivate(contextFor('203.0.113.5'));
    expect(hit).toHaveBeenCalledWith('203.0.113.5');
  });
});
