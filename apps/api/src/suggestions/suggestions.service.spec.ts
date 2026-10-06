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
    $queryRaw: jest.fn(),
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

  it('suggests purchase references, invoice numbers and line descriptions (#1473), live purchases only', async () => {
    prisma.purchaseOrder.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(
        args.by[0] === 'reference'
          ? [
              {
                reference: 'OC-4512',
                _count: { _all: 2 },
                _max: { updatedAt: at('2026-10-01T00:00:00Z') },
              },
            ]
          : [
              {
                invoiceNumbers: 'A-0003-12345',
                _count: { _all: 1 },
                _max: { updatedAt: at('2026-10-01T00:00:00Z') },
              },
            ],
      ),
    );
    prisma.purchaseOrderLine.groupBy.mockResolvedValue([
      {
        description: 'Lenovo ThinkPad E14 Gen 5',
        _count: { _all: 3 },
        _max: { updatedAt: at('2026-10-02T00:00:00Z') },
      },
    ]);

    await expect(
      service.suggest('reference', { q: 'oc', limit: 10 }, human('MEMBER')),
    ).resolves.toEqual([
      { value: 'OC-4512', count: 2, lastUsedAt: '2026-10-01T00:00:00.000Z' },
    ]);
    expect(prisma.purchaseOrder.groupBy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        by: ['reference'],
        where: {
          reference: { not: null, contains: 'oc', mode: 'insensitive' },
        },
      }),
    );
    await expect(
      service.suggest('invoiceNumbers', { limit: 10 }, human('MEMBER')),
    ).resolves.toEqual([
      {
        value: 'A-0003-12345',
        count: 1,
        lastUsedAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    await expect(
      service.suggest('lineDescription', { limit: 10 }, human('MEMBER')),
    ).resolves.toEqual([
      {
        value: 'Lenovo ThinkPad E14 Gen 5',
        count: 3,
        lastUsedAt: '2026-10-02T00:00:00.000Z',
      },
    ]);
    // A line of an archived purchase is archived with it.
    expect(prisma.purchaseOrderLine.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['description'],
        where: { purchaseOrder: { deletedAt: null } },
      }),
    );
  });

  it.each(['reference', 'invoiceNumbers', 'lineDescription'] as const)(
    'refuses %s to a VIEWER (purchaseOrder:read only) without reading anything',
    async (field) => {
      await expect(
        service.suggest(field, { limit: 10 }, human('VIEWER')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.purchaseOrder.groupBy).not.toHaveBeenCalled();
      expect(prisma.purchaseOrderLine.groupBy).not.toHaveBeenCalled();
    },
  );

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

  describe('documentLabel — asset and purchase document type labels (#1476)', () => {
    /** The SQL and bound values of the n-th raw query. */
    const raw = (n: number) => {
      const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      return { sql: strings.join('?'), values };
    };

    it('merges the labels of asset and purchase documents for a MEMBER (both permissions)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            value: 'Invoice',
            count: 2,
            lastUsedAt: at('2026-09-01T00:00:00Z'),
          },
        ])
        .mockResolvedValueOnce([
          {
            value: 'Invoice',
            count: 3,
            lastUsedAt: at('2026-10-01T00:00:00Z'),
          },
          { value: 'Remito', count: 1, lastUsedAt: at('2026-10-02T00:00:00Z') },
        ]);

      const result = await service.suggest(
        'documentLabel',
        { q: 'i', limit: 10 },
        human('MEMBER'),
      );

      expect(result).toEqual([
        { value: 'Invoice', count: 5, lastUsedAt: '2026-10-01T00:00:00.000Z' },
        { value: 'Remito', count: 1, lastUsedAt: '2026-10-02T00:00:00.000Z' },
      ]);
      const assets = raw(0);
      expect(assets.sql).toContain('JOIN "assets" p');
      expect(assets.sql).toContain(`'ASSET'::"AttachmentEntityType"`);
      const purchases = raw(1);
      expect(purchases.sql).toContain('JOIN "purchase_orders" p');
      expect(purchases.sql).toContain(
        `'PURCHASE_ORDER'::"AttachmentEntityType"`,
      );
      // Live documents of live parents, and the typed text as a bound value — never spliced into the SQL.
      for (const query of [assets, purchases]) {
        expect(query.sql).toContain('a."deletedAt" IS NULL');
        expect(query.sql).toContain('p."deletedAt" IS NULL');
        expect(query.values).toContain('i');
      }
    });

    it('a VIEWER (asset:read, no purchaseOrder:read) gets the asset document labels only', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { value: 'Warranty', count: 1, lastUsedAt: at('2026-09-01T00:00:00Z') },
      ]);
      const result = await service.suggest(
        'documentLabel',
        { limit: 10 },
        human('VIEWER'),
      );
      expect(result.map((r) => r.value)).toEqual(['Warranty']);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(raw(0).sql).toContain('JOIN "assets" p');
    });

    it('a caller with purchaseOrder:read only reads the purchase documents; with neither it is refused', async () => {
      matrix = { ...matrix, VIEWER: ['purchaseOrder:read'] };
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await service.suggest('documentLabel', { limit: 10 }, human('VIEWER'));
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(raw(0).sql).toContain('JOIN "purchase_orders" p');

      matrix = { ...matrix, VIEWER: ['consumable:read'] };
      prisma.$queryRaw.mockClear();
      await expect(
        service.suggest('documentLabel', { limit: 10 }, human('VIEWER')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
