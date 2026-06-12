import { ForbiddenException } from '@nestjs/common';

// The guard does not import PrismaService or the generated client, but it does import from
// principal.ts which is pure TS. No mocks required for the guard itself.

import { ServicePrincipalForbiddenGuard } from './service-principal-forbidden.guard';
import type { Principal } from './principal';

function makeCtx(principal?: Principal) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ principal }),
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as never;
}

/** A service principal holding the given permissions. */
function servicePrincipal(...perms: string[]): Principal {
  return {
    kind: 'service',
    serviceAccount: { id: 'sa_test_001' } as never,
    permissions: new Set(perms as never),
  };
}

/** A human principal. */
function humanPrincipal(): Principal {
  return {
    kind: 'human',
    user: { id: 'u_human_001', role: 'ADMIN' } as never,
  };
}

/**
 * ServicePrincipalForbiddenGuard — INV-SA-3 Layer-2 backstop (SEC-011).
 *
 * A service principal MUST be unconditionally refused on any route carrying this guard, regardless of
 * its grants. A human principal MUST pass through. This guard is the runtime backstop that closes the
 * class even for pre-existing SA rows that hold a meta verb (Layer 1 only stops NEW grants; Layer 2
 * stops USE).
 */
describe('ServicePrincipalForbiddenGuard (INV-SA-3 Layer 2, SEC-011)', () => {
  let guard: ServicePrincipalForbiddenGuard;

  beforeEach(() => {
    guard = new ServicePrincipalForbiddenGuard();
  });

  it('403s a service principal — unconditionally, regardless of grants', () => {
    const ctx = makeCtx(servicePrincipal('asset:read', 'asset:write'));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('403s a service principal that holds settings:manage (the self-escalation verb)', () => {
    // This is the exact pre-existing-grant scenario Layer 2 must close.
    const ctx = makeCtx(servicePrincipal('settings:manage'));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('403s a service principal that holds user:manage (the mint-human-ADMIN verb)', () => {
    const ctx = makeCtx(servicePrincipal('user:manage'));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('403s a service principal with no grants at all', () => {
    const ctx = makeCtx(servicePrincipal());
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('passes a human ADMIN principal — a human must never be blocked by this guard', () => {
    const ctx = makeCtx(humanPrincipal());
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when principal is undefined (unauthenticated shim — auth guard handles rejection)', () => {
    // The auth guard (JwtAuthGuard) is the authentication layer; this guard is authorization-only.
    // An undefined principal means authentication has not run (e.g. a test context without auth).
    // We pass through and let the auth guard + RolesGuard enforce the missing-principal case.
    const ctx = makeCtx(undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('the ForbiddenException message names the blocked operation for operator clarity', () => {
    const ctx = makeCtx(servicePrincipal('settings:manage'));
    let thrown: unknown;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toContain(
      'Service accounts cannot manage service accounts',
    );
  });
});
