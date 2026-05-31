import { Test } from '@nestjs/testing';
import { DashboardSummarySchema } from '@lazyit/shared';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// the client only for types (erased at runtime); PrismaService is injected as a plain mock below.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * Unit spec for the read-only dashboard aggregation. PrismaService is fully mocked: each model's
 * count/groupBy/findMany returns a canned value, and we assert (a) the composed shape validates
 * against the shared DashboardSummarySchema and (b) the non-trivial derivations — zero-filled
 * status buckets, distinct assigned-asset count, low-stock post-filter, expiring-soon window,
 * critical-app filter and draft = total - published.
 */

type PrismaMock = {
  asset: { count: jest.Mock; groupBy: jest.Mock };
  assetAssignment: { groupBy: jest.Mock };
  accessGrant: { count: jest.Mock };
  consumable: { count: jest.Mock; findMany: jest.Mock };
  article: { count: jest.Mock };
  assetHistory: { findMany: jest.Mock };
};

function buildPrismaMock(): PrismaMock {
  return {
    asset: { count: jest.fn(), groupBy: jest.fn() },
    assetAssignment: { groupBy: jest.fn() },
    accessGrant: { count: jest.fn() },
    consumable: { count: jest.fn(), findMany: jest.fn() },
    article: { count: jest.fn() },
    assetHistory: { findMany: jest.fn() },
  };
}

async function buildService(prisma: PrismaMock): Promise<DashboardService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      DashboardService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return moduleRef.get(DashboardService);
}

describe('DashboardService', () => {
  let prisma: PrismaMock;
  let service: DashboardService;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    service = await buildService(prisma);

    // --- Inventory ---
    prisma.asset.count.mockResolvedValue(12);
    prisma.asset.groupBy.mockResolvedValue([
      { status: 'OPERATIONAL', _count: { _all: 8 } },
      { status: 'IN_MAINTENANCE', _count: { _all: 3 } },
      { status: 'RETIRED', _count: { _all: 1 } },
    ]);
    // Three rows => three distinct assigned assets (multi-owner collapses to one row each).
    prisma.assetAssignment.groupBy.mockResolvedValue([
      { assetId: 'a1' },
      { assetId: 'a2' },
      { assetId: 'a3' },
    ]);

    // --- Access: accessGrant.count is called 3x in order (active, expiringSoon, critical) ---
    prisma.accessGrant.count
      .mockResolvedValueOnce(20) // activeGrants
      .mockResolvedValueOnce(4) // expiringSoon
      .mockResolvedValueOnce(2); // onCriticalApps

    // --- Consumables ---
    prisma.consumable.count.mockResolvedValue(7);
    prisma.consumable.findMany.mockResolvedValue([
      { currentStock: 0, minStock: 5 }, // low
      { currentStock: 5, minStock: 5 }, // low (at threshold)
      { currentStock: 6, minStock: 5 }, // ok
      { currentStock: 2, minStock: 10 }, // low
    ]);

    // --- Knowledge: article.count called 2x (total, published) ---
    prisma.article.count
      .mockResolvedValueOnce(9) // total
      .mockResolvedValueOnce(6); // published

    // --- Recent activity ---
    prisma.assetHistory.findMany.mockResolvedValue([
      {
        id: 42,
        assetId: 'casset0000000000000000001',
        eventType: 'STATUS_CHANGED',
        payload: { from: 'OPERATIONAL', to: 'IN_MAINTENANCE' },
        performedById: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      },
      {
        id: 41,
        assetId: 'casset0000000000000000002',
        eventType: 'CREATED',
        payload: null,
        performedById: null,
        createdAt: new Date('2026-05-29T09:00:00.000Z'),
      },
    ]);
  });

  it('returns a payload that satisfies DashboardSummarySchema', async () => {
    const summary = await service.getSummary();
    expect(() => DashboardSummarySchema.parse(summary)).not.toThrow();
  });

  it('zero-fills every AssetStatus bucket and reflects the groupBy counts', async () => {
    const { assets } = await service.getSummary();
    expect(assets.total).toBe(12);
    expect(assets.byStatus).toEqual({
      OPERATIONAL: 8,
      IN_MAINTENANCE: 3,
      IN_STORAGE: 0,
      RETIRED: 1,
      LOST: 0,
      UNKNOWN: 0,
    });
    expect(assets.assigned).toBe(3);
  });

  it('counts active assignments as distinct assets via groupBy on assetId', async () => {
    await service.getSummary();
    expect(prisma.assetAssignment.groupBy).toHaveBeenCalledWith({
      by: ['assetId'],
      where: { releasedAt: null },
    });
  });

  it('computes the access slice and echoes the expiry window', async () => {
    const { access } = await service.getSummary(45);
    expect(access).toEqual({
      activeGrants: 20,
      expiringSoon: 4,
      expiringWithinDays: 45,
      onCriticalApps: 2,
    });
  });

  it('queries expiringSoon within a (now, now + N days] window on active grants', async () => {
    const before = Date.now();
    await service.getSummary(10);
    const after = Date.now();

    // 2nd accessGrant.count call is expiringSoon.
    const expiringArgs = prisma.accessGrant.count.mock.calls[1][0];
    expect(expiringArgs.where.revokedAt).toBeNull();
    const { gt, lte } = expiringArgs.where.expiresAt;
    expect((gt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((gt as Date).getTime()).toBeLessThanOrEqual(after);
    const windowMs = (lte as Date).getTime() - (gt as Date).getTime();
    expect(windowMs).toBe(10 * 24 * 60 * 60 * 1000);
  });

  it('filters critical-app grants to active grants on isCritical applications', async () => {
    await service.getSummary();
    // 3rd accessGrant.count call is onCriticalApps.
    expect(prisma.accessGrant.count.mock.calls[2][0]).toEqual({
      where: { revokedAt: null, application: { is: { isCritical: true } } },
    });
  });

  it('post-filters low stock to currentStock <= minStock (and ignores null minStock via the query)', async () => {
    const { consumables } = await service.getSummary();
    expect(consumables.total).toBe(7);
    expect(consumables.lowStock).toBe(3);
    expect(prisma.consumable.findMany).toHaveBeenCalledWith({
      where: { minStock: { not: null } },
      select: { currentStock: true, minStock: true },
    });
  });

  it('derives draft articles as total minus published', async () => {
    const { articles } = await service.getSummary();
    expect(articles).toEqual({ total: 9, published: 6, draft: 3 });
  });

  it('maps recent activity newest-first with ISO timestamps', async () => {
    const { recentActivity } = await service.getSummary();
    expect(prisma.assetHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'desc' }, take: 10 }),
    );
    expect(recentActivity).toHaveLength(2);
    expect(recentActivity[0]).toEqual({
      id: 42,
      assetId: 'casset0000000000000000001',
      eventType: 'STATUS_CHANGED',
      payload: { from: 'OPERATIONAL', to: 'IN_MAINTENANCE' },
      performedById: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-05-30T10:00:00.000Z',
    });
    expect(recentActivity[1].payload).toBeNull();
    expect(recentActivity[1].createdAt).toBe('2026-05-29T09:00:00.000Z');
  });

  it('stamps generatedAt as an ISO-8601 string', async () => {
    const summary = await service.getSummary();
    expect(Number.isNaN(Date.parse(summary.generatedAt))).toBe(false);
  });
});
