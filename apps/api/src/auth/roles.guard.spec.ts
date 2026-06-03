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

// Build a fake ExecutionContext: a request object plus stable handler/class stubs the Reflector reads
// metadata off. `meta` seeds the metadata the (real) Reflector resolves for the two metadata keys.
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

/**
 * RolesGuard (ADR-0040 → ADR-0046 P4). The legacy `@Roles` decorator + its dual-mode branch have been
 * RETIRED — the guard is now the SINGLE `@RequirePermission` primitive: @Public → @RequirePermission →
 * open-by-default. These tests pin that branching (and the DB-first INV-1/INV-8 contract).
 */
describe('RolesGuard (ADR-0046 P4 — single @RequirePermission primitive)', () => {
  let guard: RolesGuard;
  // A spy resolver: the guard must consult THIS (the DB-backed service), never a token claim.
  const hasAll = jest.fn();
  const resolver = { hasAll } as unknown as PermissionResolverService;

  beforeEach(() => {
    hasAll.mockReset();
    guard = new RolesGuard(new Reflector(), resolver);
  });

  // ── (1) @Public ──────────────────────────────────────────────────────────────────────────────

  it('lets a @Public() route through without authz (no user needed)', async () => {
    const ctx = makeCtx({}, { isPublic: true, permissions: ['user:manage'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasAll).not.toHaveBeenCalled();
  });

  // ── (3) no metadata → open-by-default (INV-8) ──────────────────────────────────────────────────

  it('allows any authenticated user when no gate metadata is present', async () => {
    const ctx = makeCtx({ user: { role: 'VIEWER' } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows an anonymous request when no gate metadata is present (auth-only behaviour)', async () => {
    const ctx = makeCtx({ user: undefined });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('treats an empty @RequirePermission() set as no gate (any authenticated user passes)', async () => {
    const ctx = makeCtx({ user: { role: 'VIEWER' } }, { permissions: [] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasAll).not.toHaveBeenCalled();
  });

  // ── (2) @RequirePermission — the single fine-grained path (DB-first) ───────────────────────────

  it('allows when the resolver says the role holds every required permission', async () => {
    hasAll.mockResolvedValue(true);
    const ctx = makeCtx(
      { user: { role: 'MEMBER' } },
      { permissions: ['asset:read'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(hasAll).toHaveBeenCalledWith('MEMBER', ['asset:read']);
  });

  it('denies (403) when the resolver says the role lacks a required permission', async () => {
    hasAll.mockResolvedValue(false);
    const ctx = makeCtx(
      { user: { role: 'VIEWER' } },
      { permissions: ['accessGrant:read'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(hasAll).toHaveBeenCalledWith('VIEWER', ['accessGrant:read']);
  });

  it('denies (403) a MEMBER on an ADMIN-only write permission (e.g. accessGrant:grant)', async () => {
    hasAll.mockResolvedValue(false);
    const ctx = makeCtx(
      { user: { role: 'MEMBER' } },
      { permissions: ['accessGrant:grant'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(hasAll).toHaveBeenCalledWith('MEMBER', ['accessGrant:grant']);
  });

  it('denies (403) an anonymous request on a @RequirePermission-gated route (never resolves)', async () => {
    const ctx = makeCtx({ user: undefined }, { permissions: ['user:read'] });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(hasAll).not.toHaveBeenCalled();
  });

  // ── SENTINEL: DB-first, never a token claim (INV-1 / INV-8) ────────────────────────────────────

  it('SENTINEL: resolves the permission set from request.user.role (the DB row), NEVER a token claim', async () => {
    hasAll.mockResolvedValue(true);
    // The request carries a FORGED token claiming ADMIN with everything, but the DB-resolved user is a
    // VIEWER. The guard must pass the DB role (VIEWER) to the resolver — and ignore the token entirely.
    const ctx = makeCtx(
      {
        user: { role: 'VIEWER' },
        // Decoys the guard must NOT read:
        token: {
          role: 'ADMIN',
          permissions: ['user:read', 'accessGrant:read'],
        },
        headers: { 'x-role': 'ADMIN' },
        permissions: ['accessGrant:read'],
      },
      { permissions: ['accessGrant:read'] },
    );
    await guard.canActivate(ctx);
    // The role argument is the DB role, not anything from the token / headers / request body.
    expect(hasAll).toHaveBeenCalledTimes(1);
    expect(hasAll).toHaveBeenCalledWith('VIEWER', ['accessGrant:read']);
    const [roleArg] = hasAll.mock.calls[0] as [string, Permission[]];
    expect(roleArg).toBe('VIEWER');
    expect(roleArg).not.toBe('ADMIN');
  });
});
