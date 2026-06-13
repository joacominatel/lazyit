import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { HumanOnlyGuard } from './human-only.guard';
import type { Principal } from '../auth/principal';

/** Build a minimal ExecutionContext whose request carries the given principal. */
function ctx(principal: Principal | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

describe('HumanOnlyGuard (SA-not-a-subject at the HTTP edge)', () => {
  const guard = new HumanOnlyGuard();

  it('rejects a service principal (403) regardless of its grants', () => {
    const sa: Principal = {
      kind: 'service',
      serviceAccount: { id: 'sa1' } as never,
      permissions: new Set(['secret:read', 'secret:manage']),
    };
    expect(() => guard.canActivate(ctx(sa))).toThrow(ForbiddenException);
  });

  it('lets a human principal through', () => {
    const human: Principal = {
      kind: 'human',
      user: { id: 'u1', role: 'ADMIN' } as never,
    };
    expect(guard.canActivate(ctx(human))).toBe(true);
  });

  it('lets the anonymous shim through (no principal) — the global RolesGuard still gates by permission', () => {
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });
});
