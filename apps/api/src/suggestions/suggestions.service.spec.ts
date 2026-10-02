jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { ForbiddenException } from '@nestjs/common';
import { DEFAULT_ROLE_PERMISSIONS, type Permission } from '@lazyit/shared';
import type { Principal } from '../auth/principal';
import type { PermissionResolverService } from '../auth/permission-resolver.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SuggestionsService } from './suggestions.service';

const human = (role: 'ADMIN' | 'MEMBER' | 'VIEWER') =>
  ({ kind: 'human', user: { id: 'u', role } }) as unknown as Principal;

const at = (iso: string) => new Date(iso);

describe('SuggestionsService (ADR-0099 §7)', () => {
  const prisma = {
    supplier: { groupBy: jest.fn() },
    purchaseOrder: { groupBy: jest.fn() },
    purchaseOrderLine: { groupBy: jest.fn() },
    asset: { groupBy: jest.fn() },
    assetModel: { groupBy: jest.fn() },
    application: { groupBy: jest.fn() },
  };
  // The role matrix as seeded; a test may override one role's set.
  let matrix: Record<string, readonly Permission[]>;
  const resolver = {
    resolve: jest.fn((role: string) => Promise.resolve(new Set(matrix[role]))),
  };
  const service = new SuggestionsService(
    prisma as unknown as PrismaService,
    resolver as unknown as PermissionResolverService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    matrix = { ...DEFAULT_ROLE_PERMISSIONS };
  });

  it('merges the readable sources by exact value and ranks by count, then last use, then value', async () => {
    prisma.purchaseOrder.groupBy.mockResolvedValue([
      {
        currency: 'USD',
        _count: { _all: 3 },
        _max: { updatedAt: at('2026-09-01T00:00:00Z') },
      },
      {
        currency: 'ARS',
        _count: { _all: 2 },
        _max: { updatedAt: at('2026-10-01T00:00:00Z') },
      },
    ]);
    prisma.asset.groupBy.mockResolvedValue([
      {
        purchaseCurrency: 'USD',
        _count: { _all: 1 },
        _max: { updatedAt: at('2026-10-02T00:00:00Z') },
      },
      {
        purchaseCurrency: 'u$s',
        _count: { _all: 2 },
        _max: { updatedAt: at('2026-08-01T00:00:00Z') },
      },
      {
        purchaseCurrency: '  ',
        _count: { _all: 9 },
        _max: { updatedAt: at('2026-08-01T00:00:00Z') },
      },
    ]);

    const result = await service.suggest(
      'currency',
      { limit: 10 },
      human('MEMBER'),
    );

    expect(result).toEqual([
      { value: 'USD', count: 4, lastUsedAt: '2026-10-02T00:00:00.000Z' },
      { value: 'ARS', count: 2, lastUsedAt: '2026-10-01T00:00:00.000Z' },
      { value: 'u$s', count: 2, lastUsedAt: '2026-08-01T00:00:00.000Z' },
    ]);
  });

  it('applies q as a case-insensitive contains and honours the limit', async () => {
    prisma.application.groupBy.mockResolvedValue([
      {
        vendor: 'Microsoft',
        _count: { _all: 5 },
        _max: { updatedAt: at('2026-01-01T00:00:00Z') },
      },
      {
        vendor: 'Micro Focus',
        _count: { _all: 1 },
        _max: { updatedAt: at('2026-01-01T00:00:00Z') },
      },
    ]);
    const result = await service.suggest(
      'vendor',
      { q: 'micro', limit: 1 },
      human('VIEWER'),
    );
    expect(prisma.application.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          vendor: { not: null, contains: 'micro', mode: 'insensitive' },
        },
      }),
    );
    expect(result).toEqual([
      { value: 'Microsoft', count: 5, lastUsedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('refuses a field whose every source the caller cannot read (VIEWER on supplier names)', async () => {
    await expect(
      service.suggest('supplierName', { limit: 10 }, human('VIEWER')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.supplier.groupBy).not.toHaveBeenCalled();
  });

  it('reads only the sources the caller may read — a VIEWER gets asset currencies, never purchase ones', async () => {
    prisma.asset.groupBy.mockResolvedValue([
      {
        purchaseCurrency: 'EUR',
        _count: { _all: 1 },
        _max: { updatedAt: at('2026-01-01T00:00:00Z') },
      },
    ]);
    const result = await service.suggest(
      'currency',
      { limit: 10 },
      human('VIEWER'),
    );
    expect(prisma.purchaseOrder.groupBy).not.toHaveBeenCalled();
    expect(result.map((s) => s.value)).toEqual(['EUR']);
  });

  it('never suggests line manufacturer or model text from an archived purchase', async () => {
    prisma.assetModel.groupBy.mockResolvedValue([]);
    prisma.purchaseOrderLine.groupBy.mockResolvedValue([]);

    await service.suggest('manufacturer', { limit: 10 }, human('MEMBER'));
    await service.suggest('lineModel', { limit: 10 }, human('MEMBER'));

    for (const [args] of prisma.purchaseOrderLine.groupBy.mock.calls as [
      { where: Record<string, unknown> },
    ][]) {
      expect(args.where.purchaseOrder).toEqual({ deletedAt: null });
    }
    expect(prisma.purchaseOrderLine.groupBy).toHaveBeenCalledTimes(2);
  });

  it("uses a service account's direct grants, and refuses an anonymous caller", async () => {
    const sa = {
      kind: 'service',
      serviceAccount: { id: 'sa' },
      permissions: new Set<Permission>(['purchaseOrder:read']),
    } as unknown as Principal;
    prisma.supplier.groupBy.mockResolvedValue([]);
    await expect(
      service.suggest('supplierName', { limit: 10 }, sa),
    ).resolves.toEqual([]);
    await expect(
      service.suggest('company', { limit: 10 }, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
