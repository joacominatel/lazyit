import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import type { Role } from '@lazyit/shared';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

// Build a fake ExecutionContext: a request object plus stable handler/class stubs the Reflector reads
// metadata off. `meta` seeds the metadata the (real) Reflector resolves for IS_PUBLIC_KEY / ROLES_KEY.
function makeCtx(
  req: Record<string, unknown>,
  meta: { isPublic?: boolean; roles?: Role[] } = {},
) {
  function handler() {}
  class Controller {}
  if (meta.isPublic !== undefined) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, meta.isPublic, handler);
  }
  if (meta.roles !== undefined) {
    Reflect.defineMetadata(ROLES_KEY, meta.roles, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as never;
}

describe('RolesGuard (ADR-0040)', () => {
  let guard: RolesGuard;

  beforeEach(() => {
    guard = new RolesGuard(new Reflector());
  });

  it('lets a @Public() route through without authz (no user needed)', () => {
    const ctx = makeCtx({}, { isPublic: true, roles: ['ADMIN'] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows any authenticated user when no @Roles() metadata is present', () => {
    const ctx = makeCtx({ user: { role: 'VIEWER' } });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows an anonymous request when no @Roles() metadata is present (auth-only behaviour)', () => {
    const ctx = makeCtx({ user: undefined });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a user whose role is in the required set', () => {
    const ctx = makeCtx({ user: { role: 'ADMIN' } }, { roles: ['ADMIN'] });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a MEMBER on an ADMIN-or-MEMBER route', () => {
    const ctx = makeCtx(
      { user: { role: 'MEMBER' } },
      { roles: ['ADMIN', 'MEMBER'] },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies (403) a MEMBER on an ADMIN-only route', () => {
    const ctx = makeCtx({ user: { role: 'MEMBER' } }, { roles: ['ADMIN'] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies (403) a VIEWER on any role-gated (mutating) route', () => {
    const ctx = makeCtx(
      { user: { role: 'VIEWER' } },
      { roles: ['ADMIN', 'MEMBER'] },
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies (403) an anonymous request on a role-gated route', () => {
    const ctx = makeCtx({ user: undefined }, { roles: ['ADMIN'] });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('treats an empty @Roles() set as no gate (any authenticated user passes)', () => {
    const ctx = makeCtx({ user: { role: 'VIEWER' } }, { roles: [] });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
