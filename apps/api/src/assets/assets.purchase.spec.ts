// Purchases on the assets side (ADR-0099, #1473): bulk receive against a purchase line, and the inventory
// CSV's purchase columns gated per caller. The DB is a fake; AssetsService is real.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Permission } from '@lazyit/shared';
import { AssetsService } from './assets.service';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import type { PermissionResolverService } from '../auth/permission-resolver.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PO = 'clpo00000000000000000001';
const LINE = 'clline000000000000000001';
const MODEL = 'clmodel00000000000000001';

const member = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;

type Row = Record<string, unknown>;

function setup(held: readonly Permission[] = ['purchaseOrder:write']) {
  let seq = 0;
  const tx = {
    asset: {
      create: jest.fn(({ data }: { data: Row }) =>
        Promise.resolve({
          id: `asset${++seq}`,
          purchaseCost: null,
          salvageValue: null,
          ...data,
        }),
      ),
    },
    assetModel: { findFirst: jest.fn().mockResolvedValue({ specs: null }) },
  };
  const prisma = {
    assetModel: { findFirst: jest.fn().mockResolvedValue({ name: 'E14' }) },
    purchaseOrderLine: {
      findFirst: jest.fn().mockResolvedValue({
        id: LINE,
        purchaseOrderId: PO,
        kind: 'ASSET',
        quantity: 2,
        cancelledQuantity: 0,
      }),
    },
    purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
    asset: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
  };
  const history = { record: jest.fn() };
  const search = { upsert: jest.fn() };
  const tagScheme = { allocateTag: jest.fn().mockResolvedValue(undefined) };
  const permissions = {
    principalHas: jest.fn((_p: unknown, permission: Permission) =>
      Promise.resolve(held.includes(permission)),
    ),
  };
  const service = new AssetsService(
    prisma as never,
    new ActorService(),
    history as never,
    search as never,
    tagScheme as never,
    permissions as unknown as PermissionResolverService,
  );
  return { service, prisma, tx, history, permissions };
}

const base = {
  modelId: MODEL,
  quantity: 2,
  status: 'IN_STORAGE' as const,
  purchaseOrderLineId: LINE,
};

describe('bulk receive against a purchase line (#1473)', () => {
  it('links every unit to the line on create — one transaction per unit, tag counter untouched', async () => {
    const { service, prisma, tx } = setup();
    const result = await service.receiveBatch(
      {
        ...base,
        serials: ['SN-1', 'SN-2'],
        purchaseCost: 141250000,
        purchaseCurrency: 'ARS',
        warrantyEnd: '2029-03-10T00:00:00.000Z',
      },
      member,
    );
    expect(result.created).toHaveLength(2);
    // ADR-0063: never one transaction around the batch — each unit commits on its own.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const data = tx.asset.create.mock.calls.map(([args]) => args.data);
    expect(data[0]).toMatchObject({
      purchaseOrderLineId: LINE,
      serial: 'SN-1',
      purchaseCost: BigInt(141250000),
      purchaseCurrency: 'ARS',
      warrantyEnd: '2029-03-10T00:00:00.000Z',
    });
    expect(data[1]).toMatchObject({
      purchaseOrderLineId: LINE,
      serial: 'SN-2',
    });
  });

  it("records the line on each unit's CREATED event and ONE UNITS_RECEIVED on the purchase", async () => {
    const { service, prisma, history } = setup();
    await service.receiveBatch(base, member);
    expect(history.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'CREATED',
        payload: {
          source: 'purchase',
          purchaseOrderId: PO,
          purchaseOrderLineId: LINE,
        },
      }),
    );
    expect(prisma.purchaseOrderEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.purchaseOrderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseOrderId: PO,
        eventType: 'UNITS_RECEIVED',
        performedById: USER_ID,
        payload: {
          lineId: LINE,
          quantity: 2,
          assetIds: ['asset1', 'asset2'],
          failed: 0,
          overReceived: false,
        },
      }) as object,
    });
  });

  it('allows over-receipt and flags it (derived from the live count after the loop)', async () => {
    const { service, prisma } = setup();
    // quantity 2, three live units now
    prisma.asset.groupBy.mockResolvedValue([
      { purchaseOrderLineId: LINE, _count: { _all: 3 } },
    ]);
    const result = await service.receiveBatch(base, member);
    expect(result.created).toHaveLength(2);
    expect(result.overReceived).toBe(true);
    expect(prisma.asset.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseOrderLineId: { in: [LINE] }, deletedAt: null },
      }),
    );
  });

  it('403 without purchaseOrder:write, before any write', async () => {
    const { service, prisma } = setup([]);
    await expect(service.receiveBatch(base, member)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400 for a missing or archived line, and for an OTHER line', async () => {
    const missing = setup();
    missing.prisma.purchaseOrderLine.findFirst.mockResolvedValue(null);
    await expect(
      missing.service.receiveBatch(base, member),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(missing.prisma.purchaseOrderLine.findFirst).toHaveBeenCalledWith({
      where: { id: LINE, deletedAt: null, purchaseOrder: { deletedAt: null } },
    });

    const other = setup();
    other.prisma.purchaseOrderLine.findFirst.mockResolvedValue({
      id: LINE,
      purchaseOrderId: PO,
      kind: 'OTHER',
      quantity: 1,
      cancelledQuantity: 0,
    });
    await expect(other.service.receiveBatch(base, member)).rejects.toThrow(
      'Only ASSET lines take assets',
    );
    expect(other.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a receive without a line is unchanged: no permission check, no purchase event, no overReceived', async () => {
    const { service, prisma, permissions, tx } = setup([]);
    const result = await service.receiveBatch(
      { modelId: MODEL, quantity: 2, status: 'IN_STORAGE' },
      member,
    );
    expect(result).not.toHaveProperty('overReceived');
    expect(permissions.principalHas).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();
    expect(tx.asset.create.mock.calls[0][0].data).not.toHaveProperty(
      'purchaseOrderLineId',
    );
  });
});

describe('inventory CSV purchase columns (ADR-0099 §8, #1473)', () => {
  const linkedRow = {
    id: 'a1',
    name: 'Laptop',
    serial: null,
    assetTag: 'LZ-1',
    status: 'IN_STORAGE',
    notes: null,
    company: null,
    purchaseDate: null,
    warrantyEnd: null,
    modelId: null,
    locationId: null,
    createdAt: new Date('2026-10-02T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    model: null,
    location: null,
    assignments: [],
    purchaseCost: BigInt(150050),
    purchaseCurrency: 'USD',
    purchaseOrderLine: {
      purchaseOrder: {
        reference: 'OC-4512',
        invoiceNumbers: 'A-1',
        supplier: { name: 'Compumundo' },
      },
    },
  };

  let lastFindMany: jest.Mock;
  const selectOf = (findMany: jest.Mock) =>
    (findMany.mock.calls[0] as [{ select: Row }])[0].select;

  async function exportCsv(held: readonly Permission[]) {
    const { service, prisma } = setup(held);
    lastFindMany = prisma.asset.findMany;
    prisma.asset.findMany
      .mockResolvedValueOnce([linkedRow])
      .mockResolvedValueOnce([]);
    let out = '';
    for await (const chunk of service.streamInventoryCsvRows(
      {},
      'active',
      member,
    )) {
      out += chunk;
    }
    return out.split('\n');
  }

  it('without purchaseOrder:read: cost and currency only — no supplier, reference or invoice', async () => {
    const [, header, row] = await exportCsv(['asset:read']);
    // The linked purchase is not even read.
    expect(selectOf(lastFindMany)).not.toHaveProperty('purchaseOrderLine');
    expect(header.endsWith(',purchaseCost,purchaseCurrency')).toBe(true);
    expect(header).not.toContain('supplier');
    expect(row.endsWith(',1500.50,USD')).toBe(true);
    expect(row).not.toContain('Compumundo');
    expect(row).not.toContain('OC-4512');
  });

  it('with purchaseOrder:read: the provenance columns are appended', async () => {
    const [, header, row] = await exportCsv([
      'asset:read',
      'purchaseOrder:read',
    ]);
    expect(selectOf(lastFindMany)).toHaveProperty('purchaseOrderLine');
    expect(header.endsWith(',supplier,purchaseReference,invoiceNumbers')).toBe(
      true,
    );
    expect(row.endsWith(',1500.50,USD,Compumundo,OC-4512,A-1')).toBe(true);
  });
});

describe('list filters by purchase (#1476)', () => {
  const page = { limit: 50, offset: 0, deleted: 'active' } as const;

  function listSetup(held: readonly Permission[]) {
    const ctx = setup(held);
    const prisma = ctx.prisma as unknown as {
      asset: { findMany: jest.Mock; count: jest.Mock };
      $transaction: jest.Mock;
    };
    prisma.asset.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg as unknown[])
        : (arg as (c: unknown) => unknown)(ctx.tx),
    );
    const where = () =>
      (prisma.asset.findMany.mock.calls[0] as [{ where: Row }])[0].where;
    return { ...ctx, where };
  }

  it('the assets of one line, of one purchase, and linked or not — AND-combined', async () => {
    const { service, where } = listSetup(['purchaseOrder:read']);
    const purchase = await service.authorizePurchaseFilters(
      { purchaseOrderLineId: LINE, purchaseOrderId: PO, purchaseLinked: true },
      member,
    );
    await service.findPage({ purchase }, page);
    expect(where()).toMatchObject({
      AND: [
        { purchaseOrderLineId: LINE },
        { purchaseOrderLine: { purchaseOrderId: PO } },
        { purchaseOrderLineId: { not: null } },
      ],
    });
  });

  it('purchaseLinked=false: the assets linked to no purchase', async () => {
    const { service, where } = listSetup(['purchaseOrder:read']);
    const purchase = await service.authorizePurchaseFilters(
      { purchaseLinked: false },
      member,
    );
    await service.findPage({ purchase }, page);
    expect(where()).toMatchObject({ AND: [{ purchaseOrderLineId: null }] });
  });

  it('a list without them adds no purchase clause', async () => {
    const { service, where } = listSetup([]);
    await service.findPage({ status: 'IN_STORAGE' }, page);
    expect(where()).not.toHaveProperty('AND');
  });

  it('authorizing the purchase filters needs purchaseOrder:read (D-A): 403 without it, or without a principal', async () => {
    const denied = listSetup(['asset:read']);
    await expect(
      denied.service.authorizePurchaseFilters({ purchaseOrderId: PO }, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      denied.service.authorizePurchaseFilters({ purchaseOrderId: PO }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('defense in depth: purchase filters that were not authorized are refused by the list AND the export, before any query', async () => {
    const { service, prisma } = listSetup(['purchaseOrder:read']);
    const forged = { purchaseOrderId: PO };
    await expect(
      service.findPage({ purchase: forged }, page),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const stream = service.streamInventoryCsvRows(
      { purchase: forged },
      'active',
      member,
    );
    // The provenance stamp and header come first; the query (and the refusal) with the first batch.
    await expect(
      (async () => {
        for await (const chunk of stream) void chunk;
      })(),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
});
