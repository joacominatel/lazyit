import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  type Permission,
} from '@lazyit/shared';

// The resolver imports PrismaService, which loads the generated Prisma client (ESM `.js` re-exports
// jest can't resolve). The DB is mocked here, so stub the client/adapter to keep them from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import { PermissionResolverService } from './permission-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for the DB-first permission resolver (ADR-0046 P2 / INV-1 / INV-8). The Prisma client is
 * mocked: `rolePermission.findMany` returns the seeded rows for a role from the shared single source of
 * truth, so the resolver is exercised against the EXACT matrix the seed writes — without a database.
 */
describe('PermissionResolverService (ADR-0046 P2)', () => {
  const findMany = jest.fn();
  const prisma = {
    rolePermission: { findMany },
  } as unknown as PrismaService;

  let service: PermissionResolverService;

  // The seeded rows for a role, in the `{ permission }[]` shape Prisma returns.
  const rowsFor = (role: 'MEMBER' | 'VIEWER') =>
    DEFAULT_ROLE_PERMISSIONS[role].map((permission) => ({ permission }));

  beforeEach(() => {
    findMany.mockReset();
    service = new PermissionResolverService(prisma);
  });

  // ── ADMIN is immutable/full (INV-8): never a DB read, always the complete catalog ───────────────

  it('resolves ADMIN to the COMPLETE catalog without touching the DB', async () => {
    const set = await service.resolve('ADMIN');
    expect(set.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(set.has(p)).toBe(true);
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it('ADMIN holds every permission via hasAll, even an empty/missing seed', async () => {
    findMany.mockResolvedValue([]); // a hypothetical bad seed with no ADMIN rows
    await expect(
      service.hasAll('ADMIN', [
        'user:read',
        'accessGrant:read',
        'asset:delete',
      ]),
    ).resolves.toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });

  // ── DB-first resolution for the non-ADMIN roles ────────────────────────────────────────────────

  it('resolves MEMBER from the RolePermission rows (reads + writes, no delete / coarse verb)', async () => {
    findMany.mockResolvedValue(rowsFor('MEMBER'));
    const set = await service.resolve('MEMBER');
    expect(findMany).toHaveBeenCalledWith({
      where: { role: 'MEMBER' },
      select: { permission: true },
    });
    expect(set.has('asset:read')).toBe(true);
    expect(set.has('asset:write')).toBe(true);
    expect(set.has('asset:delete')).toBe(false);
    expect(set.has('accessGrant:grant')).toBe(false);
    // MEMBER keeps the two pre-tightened reads (only VIEWER loses them).
    expect(set.has('user:read')).toBe(true);
    expect(set.has('accessGrant:read')).toBe(true);
  });

  it('resolves VIEWER without the two pre-tightened reads (the only behavior delta)', async () => {
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    const set = await service.resolve('VIEWER');
    expect(set.has('asset:read')).toBe(true);
    expect(set.has('application:read')).toBe(true);
    expect(set.has('user:read')).toBe(false);
    expect(set.has('accessGrant:read')).toBe(false);
  });

  it('VIEWER hasAll is true for a granted read, false for a pre-tightened one', async () => {
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    await expect(service.hasAll('VIEWER', ['asset:read'])).resolves.toBe(true);
    await expect(service.hasAll('VIEWER', ['user:read'])).resolves.toBe(false);
    await expect(service.hasAll('VIEWER', ['accessGrant:read'])).resolves.toBe(
      false,
    );
  });

  it('hasAll requires EVERY permission (AND semantics)', async () => {
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    // asset:read granted, user:read denied → the AND is false.
    await expect(
      service.hasAll('VIEWER', ['asset:read', 'user:read']),
    ).resolves.toBe(false);
  });

  it('an empty required set is vacuously allowed (no DB read)', async () => {
    await expect(service.hasAll('VIEWER', [])).resolves.toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });

  // ── Catalog-foreign rows are ignored; fail-closed on an empty seed ──────────────────────────────

  it('ignores a DB row whose permission is not in the frozen catalog', async () => {
    findMany.mockResolvedValue([
      { permission: 'asset:read' },
      { permission: 'totally:bogus' as Permission },
    ]);
    const set = await service.resolve('VIEWER');
    expect(set.has('asset:read')).toBe(true);
    expect(set.has('totally:bogus' as Permission)).toBe(false);
    expect(set.size).toBe(1);
  });

  it('fails CLOSED: an empty seed for a non-ADMIN role denies every permission', async () => {
    findMany.mockResolvedValue([]);
    const set = await service.resolve('VIEWER');
    expect(set.size).toBe(0);
    await expect(service.hasAll('VIEWER', ['asset:read'])).resolves.toBe(false);
  });

  // ── Cache + invalidation hook (the seam P5 will use) ───────────────────────────────────────────

  it('caches a resolved role — the second resolve does not re-hit the DB', async () => {
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    await service.resolve('VIEWER');
    await service.resolve('VIEWER');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('invalidate(role) drops only that role; the next resolve re-reads it', async () => {
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    await service.resolve('VIEWER');
    service.invalidate('VIEWER');
    await service.resolve('VIEWER');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidate() with no argument clears the whole cache', async () => {
    findMany.mockResolvedValue(rowsFor('MEMBER'));
    await service.resolve('MEMBER');
    findMany.mockResolvedValue(rowsFor('VIEWER'));
    await service.resolve('VIEWER');
    service.invalidate();
    await service.resolve('MEMBER');
    await service.resolve('VIEWER');
    // 2 initial + 2 after the full clear.
    expect(findMany).toHaveBeenCalledTimes(4);
  });
});
