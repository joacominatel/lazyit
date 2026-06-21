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

  // ── Cache + invalidation hook ───────────────────────────────────────────────────────────────────

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

  // ── TTL: entries expire and re-resolve from the DB (ADR-0046 §single-instance assumption) ──────

  describe('TTL-bounded cache (PERMISSION_CACHE_TTL_MS = 60 s)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('a cached entry is served without a DB hit before the TTL expires', async () => {
      findMany.mockResolvedValue(rowsFor('VIEWER'));
      await service.resolve('VIEWER');

      // Advance almost to the TTL boundary — still within TTL.
      jest.advanceTimersByTime(59_999);
      await service.resolve('VIEWER');

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('a cached entry expires after PERMISSION_CACHE_TTL_MS and is re-resolved from the DB', async () => {
      findMany.mockResolvedValue(rowsFor('VIEWER'));
      await service.resolve('VIEWER'); // first resolve → DB hit, cache populated

      // Advance past the 60 s TTL.
      jest.advanceTimersByTime(60_001);

      // Second resolve after expiry → must re-hit the DB.
      await service.resolve('VIEWER');

      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('TTL expiry re-resolves an updated matrix (self-heal without explicit invalidate)', async () => {
      // First matrix: VIEWER has asset:read only.
      findMany.mockResolvedValue([{ permission: 'asset:read' }]);
      const first = await service.resolve('VIEWER');
      expect(first.has('asset:read')).toBe(true);
      expect(first.has('consumable:read')).toBe(false);

      // Admin edits the matrix on ANOTHER node — this node never receives an invalidate().
      // After TTL the stale entry is dropped and the new matrix is picked up.
      findMany.mockResolvedValue([
        { permission: 'asset:read' },
        { permission: 'consumable:read' },
      ]);
      jest.advanceTimersByTime(60_001);

      const second = await service.resolve('VIEWER');
      expect(second.has('asset:read')).toBe(true);
      expect(second.has('consumable:read')).toBe(true);
      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('ADMIN is never cached and is unaffected by the TTL (always returns full catalog)', async () => {
      const set1 = await service.resolve('ADMIN');
      jest.advanceTimersByTime(120_000); // 2× TTL
      const set2 = await service.resolve('ADMIN');

      expect(set1.size).toBe(PERMISSIONS.length);
      expect(set2.size).toBe(PERMISSIONS.length);
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
