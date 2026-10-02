// The service imports the generated client for `Prisma.join` (the asset lock); stub it so no real client
// loads. The fake delegates below stand in for the database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

import { ConflictException } from '@nestjs/common';
import { ActorService } from '../common/actor.service';
import type { Principal } from '../auth/principal';
import type { PrismaService } from '../prisma/prisma.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';

const PO = 'clpo00000000000000000001';
const MODEL_A = 'clmodelA0000000000000001';
const MODEL_B = 'clmodelB0000000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const human = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;

type Row = Record<string, unknown>;

const modelA = {
  id: MODEL_A,
  name: 'Latitude 5440',
  manufacturer: 'Dell',
  deletedAt: null,
};
const modelB = {
  id: MODEL_B,
  name: 'U2723QE',
  manufacturer: 'Dell',
  deletedAt: null,
};

function asset(id: string, over: Row = {}): Row {
  return {
    id,
    name: `Asset ${id}`,
    modelId: MODEL_A,
    model: modelA,
    purchaseOrderLineId: null,
    purchaseCost: BigInt(150_000),
    purchaseCurrency: 'USD',
    ...over,
  };
}

function setup(assets: Row[]) {
  const lines: Row[] = [];
  const locks: string[] = [];
  const prisma = {
    purchaseOrder: {
      create: jest.fn(({ data }: { data: Row }) =>
        Promise.resolve({ id: PO, ...data }),
      ),
      update: jest.fn(),
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: PO,
          reference: null,
          supplierId: null,
          status: 'ORDERED',
          currency: 'USD',
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          supplier: null,
          lines,
        }),
      ),
    },
    purchaseOrderLine: {
      create: jest.fn(({ data }: { data: Row }) => {
        const line = {
          id: `clline${String(lines.length).padStart(18, '0')}`,
          cancelledQuantity: 0,
          appliedSeats: 0,
          consumableId: null,
          applicationId: null,
          warrantyMonths: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          ...data,
        };
        lines.push(line);
        return Promise.resolve(line);
      }),
    },
    asset: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          assets.filter((a) => where.id.in.includes(a.id as string)),
        ),
      ),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    assetHistory: { create: jest.fn().mockResolvedValue({}) },
    supplier: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
    consumableMovement: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      locks.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  const actor = new ActorService();
  const purchases = new PurchaseOrdersService(
    prisma as unknown as PrismaService,
    actor,
  );
  const service = new PurchaseFromAssetsService(
    prisma as unknown as PrismaService,
    actor,
    new AssetHistoryService(prisma as unknown as PrismaService),
    purchases,
  );
  return { service, prisma, lines, locks };
}

const events = (prisma: ReturnType<typeof setup>['prisma']) =>
  prisma.purchaseOrderEvent.create.mock.calls.map(
    (call: [{ data: Row }]) => call[0].data,
  );

describe('PurchaseFromAssetsService (#1477)', () => {
  it('one ASSET line per model, quantity = its assets, the common price in the shared currency', async () => {
    const { service, prisma, lines } = setup([
      asset('a1'),
      asset('a2'),
      asset('a3', {
        modelId: MODEL_B,
        model: modelB,
        purchaseCost: BigInt(40_000),
      }),
    ]);
    const result = await service.create(
      { assetIds: ['a1', 'a2', 'a3'] },
      human,
    );

    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'ASSET',
        description: 'Dell Latitude 5440',
        manufacturerText: 'Dell',
        modelText: 'Latitude 5440',
        assetModelId: MODEL_A,
        quantity: 2,
        unitPrice: BigInt(150_000),
        position: 0,
      }),
      expect.objectContaining({
        assetModelId: MODEL_B,
        quantity: 1,
        unitPrice: BigInt(40_000),
        position: 1,
      }),
    ]);
    // No currency in the request: the one label every priced asset shares.
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: PO },
      data: { currency: 'USD' },
    });
    expect(result.linkedAssetIds).toEqual(['a1', 'a2', 'a3']);
    expect(result.failed).toEqual([]);
  });

  it('links the assets and changes no other asset field', async () => {
    const { service, prisma, lines } = setup([asset('a1'), asset('a2')]);
    await service.create({ assetIds: ['a1', 'a2'] }, human);
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { purchaseOrderLineId: lines[0].id },
    });
    const history = prisma.assetHistory.create.mock.calls.map(
      (call: [{ data: Row }]) => call[0].data,
    );
    expect(history).toEqual([
      expect.objectContaining({
        assetId: 'a1',
        eventType: 'PURCHASE_LINKED',
        payload: {
          purchaseOrderId: PO,
          purchaseOrderLineId: lines[0].id,
          applied: [],
        },
      }),
      expect.objectContaining({ assetId: 'a2', eventType: 'PURCHASE_LINKED' }),
    ]);
  });

  it('a price only when every asset of the group has the same one in the purchase currency', async () => {
    const mixed = setup([
      asset('a1'),
      asset('a2', { purchaseCost: BigInt(160_000) }),
    ]);
    await mixed.service.create({ assetIds: ['a1', 'a2'] }, human);
    expect(mixed.lines[0].unitPrice).toBeNull();

    const unpriced = setup([asset('a1'), asset('a2', { purchaseCost: null })]);
    await unpriced.service.create({ assetIds: ['a1', 'a2'] }, human);
    expect(unpriced.lines[0].unitPrice).toBeNull();

    // The request names another currency: the assets' USD cost is not a price in ARS.
    const other = setup([asset('a1'), asset('a2')]);
    await other.service.create(
      { assetIds: ['a1', 'a2'], currency: 'ARS' },
      human,
    );
    expect(other.lines[0].unitPrice).toBeNull();
    expect(other.prisma.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('assets without a model group by name; an archived model is not mapped', async () => {
    const { service, lines } = setup([
      asset('a1', { modelId: null, model: null, name: 'Generic monitor' }),
      asset('a2', { modelId: null, model: null, name: 'generic monitor ' }),
      asset('a3', { model: { ...modelA, deletedAt: new Date() } }),
    ]);
    await service.create({ assetIds: ['a1', 'a2', 'a3'] }, human);
    expect(lines).toEqual([
      expect.objectContaining({
        description: 'Generic monitor',
        assetModelId: null,
        quantity: 2,
      }),
      expect.objectContaining({
        description: 'Dell Latitude 5440',
        assetModelId: null,
      }),
    ]);
  });

  it('reports the assets left out — archived or already on a purchase — and links the rest', async () => {
    const { service } = setup([
      asset('a1'),
      asset('a2', { purchaseOrderLineId: 'cllineOther0000000000001' }),
    ]);
    const result = await service.create(
      { assetIds: ['a1', 'a2', 'gone'] },
      human,
    );
    expect(result.linkedAssetIds).toEqual(['a1']);
    expect(result.failed).toEqual([
      expect.objectContaining({ assetId: 'a2', reason: 'LINKED_ELSEWHERE' }),
      expect.objectContaining({ assetId: 'gone', reason: 'NOT_FOUND' }),
    ]);
  });

  it('creates nothing when no asset can be linked (409, the transaction rolls back)', async () => {
    const { service, prisma } = setup([
      asset('a1', { purchaseOrderLineId: 'cllineOther0000000000001' }),
    ]);
    await expect(
      service.create({ assetIds: ['a1'], reference: 'OC-9' }, human),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.purchaseOrderLine.create).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it('locks the purchase first (created), then the assets in id order; logs created before the links', async () => {
    const { service, prisma, locks } = setup([asset('a1'), asset('a2')]);
    await service.create({ assetIds: ['a2', 'a1'] }, human);
    const created = prisma.purchaseOrder.create.mock.invocationCallOrder[0];
    const locked = prisma.$queryRaw.mock.invocationCallOrder[0];
    expect(created).toBeLessThan(locked);
    expect(locks[0]).toMatch(/FROM "assets".*ORDER BY "id" FOR UPDATE/s);
    expect(events(prisma).map((e) => e.eventType)).toEqual([
      'CREATED',
      'CREATED_FROM_ASSETS',
      'ASSET_LINKED',
    ]);
    expect(events(prisma)[1]).toMatchObject({
      performedById: USER_ID,
      payload: { lineCount: 1, linkedAssetIds: ['a2', 'a1'], failed: 0 },
    });
  });
});
