import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '@lazyit/shared';

// RolesGuard transitively imports PermissionResolverService → PrismaService → the generated Prisma
// client (ESM `.js` re-exports jest can't resolve). The resolver is mocked here, so stub the
// client/adapter to keep them from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERMISSION_KEY } from './require-permission.decorator';
import type { PermissionResolverService } from './permission-resolver.service';
import type { Principal } from './principal';

function makeCtx(
  req: Record<string, unknown>,
  meta: { isPublic?: boolean; permissions?: Permission[] } = {},
) {
  function handler() {}
  class Controller {}
  if (meta.isPublic !== undefined) {
    Reflect.defineMetadata(IS_PUBLIC_KEY, meta.isPublic, handler);
  }
  if (meta.permissions !== undefined) {
    Reflect.defineMetadata(PERMISSION_KEY, meta.permissions, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Controller,
  } as never;
}

/** A service principal holding exactly the given permissions. */
function servicePrincipal(...perms: Permission[]): Principal {
  return {
    kind: 'service',
    serviceAccount: { id: 'sa_test' } as never,
    permissions: new Set(perms),
  };
}

/**
 * RolesGuard — SERVICE-ACCOUNT authorization (ADR-0048). A service account is authorized SOLELY by its
 * direct grants and is FAIL-CLOSED: it passes only @Public routes and @RequirePermission routes it fully
 * holds. Crucially it does NOT inherit the human open-by-default for unannotated routes (INV-SA-2), and
 * it NEVER consults the role resolver (it has no role — INV-SA-3).
 */
describe('RolesGuard — service-account authZ (ADR-0048)', () => {
  let guard: RolesGuard;
  // The role resolver must NEVER be called for a service account (it has no role).
  const hasAll = jest.fn();
  const resolver = { hasAll } as unknown as PermissionResolverService;

  beforeEach(() => {
    hasAll.mockReset();
    guard = new RolesGuard(new Reflector(), resolver);
  });

  it('passes a @RequirePermission route the SA fully holds (by its direct grants, not a role)', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal('asset:write', 'asset:read') },
      { permissions: ['asset:write'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // The role resolver is never consulted for a service account.
    expect(hasAll).not.toHaveBeenCalled();
  });

  it('403s a @RequirePermission route the SA does NOT hold', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal('asset:read') },
      { permissions: ['asset:write'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(hasAll).not.toHaveBeenCalled();
  });

  it('403s when the SA holds only SOME of several required permissions (AND semantics)', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal('asset:read') },
      { permissions: ['asset:read', 'asset:write'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('FAIL-CLOSED: 403s an UNANNOTATED (non-@Public) route — does NOT inherit human open-by-default', async () => {
    // No permissions metadata at all. A human would pass here (open-by-default); a service account
    // must NOT (INV-SA-2).
    const ctx = makeCtx({ principal: servicePrincipal('asset:read') }, {});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(hasAll).not.toHaveBeenCalled();
  });

  it('passes a @Public() route (both kinds skip authz)', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal() }, // no grants at all
      { isPublic: true, permissions: ['settings:manage'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('a SA with NO grants is fully fail-closed: 403 on any gated route', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal() },
      { permissions: ['asset:read'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a SA can NEVER reach an ADMIN-gated route (settings:manage) it lacks', async () => {
    const ctx = makeCtx(
      { principal: servicePrincipal('asset:read', 'asset:write') },
      { permissions: ['settings:manage'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
