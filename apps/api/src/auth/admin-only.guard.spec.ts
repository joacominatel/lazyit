import { ForbiddenException } from '@nestjs/common';
import { AdminOnlyGuard } from './admin-only.guard';
import type { Principal } from './principal';

function ctx(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function human(role: 'ADMIN' | 'MEMBER' | 'VIEWER'): Principal {
  return { kind: 'human', user: { id: `u-${role}`, role } as never };
}

function refusal(request: Record<string, unknown>): unknown {
  try {
    new AdminOnlyGuard().canActivate(ctx(request));
  } catch (err) {
    return err;
  }
  throw new Error('expected the guard to refuse');
}

describe('AdminOnlyGuard (SEC-088)', () => {
  it('lets a human ADMIN through', () => {
    expect(
      new AdminOnlyGuard().canActivate(ctx({ principal: human('ADMIN') })),
    ).toBe(true);
  });

  it('lets an ADMIN through when only request.user is set', () => {
    expect(
      new AdminOnlyGuard().canActivate(
        ctx({ user: { id: 'u-admin', role: 'ADMIN' } }),
      ),
    ).toBe(true);
  });

  it.each(['MEMBER', 'VIEWER'] as const)(
    'refuses a %s with 403 ADMIN_REQUIRED, whatever its role was delegated',
    (role) => {
      const err = refusal({ principal: human(role) });
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'ADMIN_REQUIRED',
      });
    },
  );

  it('refuses a service account, even one holding settings:manage', () => {
    const err = refusal({
      principal: {
        kind: 'service',
        serviceAccount: { id: 'sa-1' },
        permissions: new Set(['settings:manage']),
      },
    });
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('refuses an anonymous caller', () => {
    expect(refusal({})).toBeInstanceOf(ForbiddenException);
  });
});
