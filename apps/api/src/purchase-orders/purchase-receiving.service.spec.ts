// The services import the generated client for `Prisma.join` / `Prisma.sql` (raw SQL); stub it so no real
// client loads. The fake delegates below stand in for the database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    empty: { strings: [''], values: [] },
  },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ActorService } from '../common/actor.service';
import { ConsumablesService } from '../consumables/consumables.service';
import type { Principal } from '../auth/principal';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  PurchaseReceivingService,
  STOCK_RECEIPT_REASON,
} from './purchase-receiving.service';

const PO = 'clpo00000000000000000001';
const OTHER_PO = 'clpo00000000000000000002';
const LINE = 'clline000000000000000001';
const OTHER_LINE = 'clline000000000000000002';
const MODEL = 'clmodel00000000000000001';
const OLD_MODEL = 'clmodel00000000000000002';
const LOCATION = 'clloc0000000000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const A1 = 'classet00000000000000001';
const A2 = 'classet00000000000000002';
const A3 = 'classet00000000000000003';
const A4 = 'classet00000000000000004';
const CONSUMABLE = 'clconsumable000000000001';

const member = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;

type Row = Record<string, unknown>;

function purchaseRow(over: Row = {}): Row {
  return {
    id: PO,
    reference: 'OC-4512',
    supplierId: null,
    status: 'ORDERED',
    currency: 'ARS',
    orderDate: new Date('2026-03-03T00:00:00Z'),
    expectedDate: null,
    deliveryLocationId: LOCATION,
    company: 'Acme S.A.',
    invoiceNumbers: 'A-0003-12345',
    invoiceDate: new Date('2026-03-10T00:00:00Z'),
    notes: null,
    createdAt: new Date('2026-03-03T00:00:00Z'),
    updatedAt: new Date('2026-03-03T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

function lineRow(over: Row = {}): Row {
  return {
    id: LINE,
    purchaseOrderId: PO,
    position: 0,
    kind: 'ASSET',
    description: 'Lenovo ThinkPad E14 Gen 5',
    manufacturerText: null,
    modelText: null,
    assetModelId: MODEL,
    quantity: 4,
    unitPrice: BigInt(141250000),
    cancelledQuantity: 0,
    warrantyMonths: 36,
    createdAt: new Date('2026-03-03T00:00:00Z'),
    updatedAt: new Date('2026-03-03T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

/** An asset row as the link select reads it. */
function assetRow(id: string, over: Row = {}): Row {
  return {
    id,
    name: `Laptop ${id.slice(-1)}`,
    assetTag: `LZ-${id.slice(-1)}`,
    purchaseOrderLineId: null,
    purchaseDate: null,
    purchaseCost: null,
    purchaseCurrency: null,
    warrantyEnd: null,
    company: null,
    modelId: MODEL,
    purchaseOrderLine: null,
    ...over,
  };
}

/**
 * A fake database with a DISTINCT transaction client: reads are shared, but every write a transaction makes
 * goes through `tx`'s own mocks, so a test can tell "inside the transaction" from "outside".
 */
function makeDb() {
  const reads = {
    purchaseOrder: { findFirst: jest.fn() },
    purchaseOrderLine: {
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findMany: jest.fn(),
    },
    asset: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    location: { findFirst: jest.fn() },
    attachment: { findMany: jest.fn().mockResolvedValue([]) },
    consumable: { findFirst: jest.fn() },
    consumableMovement: {
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { quantity: null } }),
    },
  };
  const tx = {
    ...reads,
    asset: {
      ...reads.asset,
      update: jest.fn(({ where, data }: { where: { id: string }; data: Row }) =>
        Promise.resolve({
          id: where.id,
          purchaseCost: null,
          salvageValue: null,
          modelId: MODEL,
          ...data,
        }),
      ),
    },
    purchaseOrderEvent: { create: jest.fn().mockResolvedValue({}) },
    assetHistory: { create: jest.fn().mockResolvedValue({}) },
    consumable: {
      ...reads.consumable,
      update: jest.fn().mockResolvedValue({}),
    },
    consumableMovement: {
      ...reads.consumableMovement,
      create: jest.fn(({ data }: { data: Row }) =>
        Promise.resolve({ id: 77, createdAt: new Date(), ...data }),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    ...reads,
    asset: { ...reads.asset, update: jest.fn() },
    purchaseOrderEvent: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
  };
  // Defaults: a live purchase and line, the line read back after writes.
  reads.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());
  reads.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
  reads.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(lineRow());
  return { prisma, tx, reads };
}

function setup() {
  const db = makeDb();
  const actor = new ActorService();
  const purchases = new PurchaseOrdersService(db.prisma as never, actor);
  // The real history writer contract: it writes through the client it is handed.
  const history = {
    record: jest.fn(
      (client: { assetHistory: { create: jest.Mock } }, event: Row) =>
        client.assetHistory.create({ data: event }) as Promise<unknown>,
    ),
  };
  const assets = { receiveBatch: jest.fn() };
  // The REAL consumables service over the same fake database: a stock receipt goes through its movement path.
  const consumables = new ConsumablesService(
    db.prisma as never,
    actor,
    { emit: jest.fn() } as never,
    history as never,
    { resolve: jest.fn() } as never,
  );
  const service = new PurchaseReceivingService(
    db.prisma as never,
    actor,
    history as never,
    assets as never,
    purchases,
    consumables,
  );
  return { ...db, service, history, assets, consumables };
}

/** The `data` of every row written through a mock, in order. */
const written = (mock: jest.Mock): Row[] =>
  (mock.mock.calls as [{ data: Row }][]).map(([args]) => args.data);

describe('link preview — current vs purchase value per field (ux-proposal §3.e)', () => {
  it('offers the mapped values and diffs each asset: fill, replace, same, unavailable', async () => {
    const { service, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1), // everything empty → fills
      assetRow(A2, {
        purchaseCost: BigInt(115000),
        purchaseCurrency: 'USD',
        purchaseDate: new Date('2026-03-10T00:00:00Z'),
        company: 'Acme S.A.',
        modelId: OLD_MODEL,
        purchaseOrderLineId: OTHER_LINE,
        purchaseOrderLine: { purchaseOrderId: OTHER_PO },
      }),
    ]);
    reads.asset.count.mockResolvedValue(3);

    const preview = await service.linkPreview(PO, LINE, [A1, A2, A3]);

    expect(preview.values).toEqual({
      purchaseDate: '2026-03-10T00:00:00.000Z',
      purchaseDateSource: 'INVOICE',
      purchaseCost: { amount: 141250000, currency: 'ARS' },
      warrantyEnd: '2029-03-10T00:00:00.000Z',
      company: 'Acme S.A.',
      modelId: MODEL,
    });
    const [first, second] = preview.assets;
    expect(first.linkState).toBe('NONE');
    expect(first.fields.purchaseCost).toEqual({
      current: { amount: null, currency: null },
      purchase: { amount: 141250000, currency: 'ARS' },
      action: 'FILL',
    });
    expect(first.fields.modelId.action).toBe('SAME');
    expect(second).toMatchObject({
      linkState: 'OTHER_LINE',
      linkedLineId: OTHER_LINE,
      linkedPurchaseOrderId: OTHER_PO,
    });
    expect(second.fields.purchaseCost.action).toBe('REPLACE');
    expect(second.fields.purchaseDate.action).toBe('SAME');
    expect(second.fields.company.action).toBe('SAME');
    expect(second.fields.modelId).toEqual({
      current: OLD_MODEL,
      purchase: MODEL,
      action: 'REPLACE',
    });
    expect(preview.missing).toEqual([A3]);
    // 3 received + 2 to link = 5 of 4 → over-received, flagged, not refused.
    expect(preview.receivedAfter).toBe(5);
    expect(preview.overReceivedAfter).toBe(true);
  });

  it('a line without a price offers no cost: the field reads UNAVAILABLE', async () => {
    const { service, reads } = setup();
    reads.purchaseOrderLine.findFirst.mockResolvedValue(
      lineRow({ unitPrice: null }),
    );
    reads.asset.findMany.mockResolvedValue([assetRow(A1)]);
    const preview = await service.linkPreview(PO, LINE, [A1]);
    expect(preview.values.purchaseCost).toBeNull();
    expect(preview.assets[0].fields.purchaseCost.action).toBe('UNAVAILABLE');
  });

  it('400 on an OTHER line', async () => {
    const { service, reads } = setup();
    reads.purchaseOrderLine.findFirst.mockResolvedValue(
      lineRow({ kind: 'OTHER' }),
    );
    await expect(service.linkPreview(PO, LINE, [A1])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('link assets', () => {
  it('partial success: archived/missing, already on this line and linked elsewhere fail; the rest link', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1),
      assetRow(A2, { purchaseOrderLineId: LINE }),
      assetRow(A3, {
        purchaseOrderLineId: OTHER_LINE,
        purchaseOrderLine: { purchaseOrderId: OTHER_PO },
      }),
      // A4 is not returned: archived (the live filter) or missing.
    ]);

    const result = await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A1, A2, A3, A4] },
      member,
    );

    expect(result.linked.map((a) => a.id)).toEqual([A1]);
    expect(result.failed).toEqual([
      expect.objectContaining({ assetId: A2, reason: 'ALREADY_LINKED' }),
      expect.objectContaining({ assetId: A3, reason: 'LINKED_ELSEWHERE' }),
      expect.objectContaining({ assetId: A4, reason: 'NOT_FOUND' }),
    ]);
    // The live read excludes archived assets.
    expect(reads.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [A1, A2, A3, A4] }, deletedAt: null },
      }),
    );
    // The purchase (KEY SHARE), then the asset rows, are locked first.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.asset.update).toHaveBeenCalledTimes(1);
  });

  it('apply-values: only the listed fields are written, only where they fill or replace', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1, {
        purchaseCost: BigInt(115000),
        purchaseCurrency: 'USD',
        company: 'Old Co',
      }),
    ]);

    await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A1], apply: ['purchaseCost', 'warrantyEnd'] },
      member,
    );

    // Cost replaced WITH its currency; warranty filled; company / date / model untouched though they differ.
    expect(written(tx.asset.update)[0]).toEqual({
      purchaseCost: BigInt(141250000),
      purchaseCurrency: 'ARS',
      warrantyEnd: '2029-03-10T00:00:00.000Z',
      purchaseOrderLineId: LINE,
    });
  });

  it('no apply list: the link alone, nothing copied', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([assetRow(A1)]);
    await service.linkAssets(PO, LINE, { assetIds: [A1] }, member);
    expect(written(tx.asset.update)[0]).toEqual({ purchaseOrderLineId: LINE });
  });

  it('applyByAsset overrides the batch list per asset; a SAME field is not written', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1),
      assetRow(A2, { company: 'Acme S.A.' }),
    ]);
    await service.linkAssets(
      PO,
      LINE,
      {
        assetIds: [A1, A2],
        apply: ['company'],
        applyByAsset: { [A2]: ['company', 'purchaseDate'] },
      },
      member,
    );
    const [first, second] = written(tx.asset.update);
    expect(first).toEqual({ company: 'Acme S.A.', purchaseOrderLineId: LINE });
    expect(second).toEqual({
      purchaseDate: '2026-03-10T00:00:00.000Z',
      purchaseOrderLineId: LINE,
    });
  });

  it('history and purchase events are written through the SAME transaction client', async () => {
    const { service, tx, prisma, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1, { modelId: OLD_MODEL }),
    ]);

    const result = await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A1], apply: ['modelId'] },
      member,
    );

    expect(written(tx.assetHistory.create)).toEqual([
      expect.objectContaining({
        assetId: A1,
        eventType: 'PURCHASE_LINKED',
        payload: {
          purchaseOrderId: PO,
          purchaseOrderLineId: LINE,
          applied: ['modelId'],
        },
      }),
      expect.objectContaining({
        assetId: A1,
        eventType: 'MODEL_CHANGED',
        payload: { from: OLD_MODEL, to: MODEL },
      }),
    ]);
    expect(written(tx.purchaseOrderEvent.create)).toEqual([
      expect.objectContaining({
        purchaseOrderId: PO,
        eventType: 'ASSET_LINKED',
        performedById: USER_ID,
        payload: {
          lineId: LINE,
          assetIds: [A1],
          applied: { [A1]: ['modelId'] },
          moved: [],
          overReceived: false,
        },
      }),
    ]);
    // Nothing escaped the transaction.
    expect(prisma.purchaseOrderEvent.create).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(result.overReceived).toBe(false);
  });

  it('locks the purchase (KEY SHARE) before the line check and any asset write, then the assets in id order', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([assetRow(A1)]);

    await service.linkAssets(PO, LINE, { assetIds: [A1] }, member);

    const [purchaseLock, assetLock] = tx.$queryRaw.mock.calls as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    expect(purchaseLock[0].join('?')).toContain(
      'FROM "purchase_orders" WHERE "id" = ? FOR KEY SHARE',
    );
    expect(purchaseLock[1]).toBe(PO);
    expect(assetLock[0].join('?')).toContain('ORDER BY "id" FOR UPDATE');
    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(
      reads.purchaseOrder.findFirst.mock.invocationCallOrder[0],
    );
    expect(lockOrder).toBeLessThan(tx.asset.update.mock.invocationCallOrder[0]);
  });

  it('move: true re-links an asset from another line and logs it on both purchases', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A3, {
        purchaseOrderLineId: OTHER_LINE,
        purchaseOrderLine: { purchaseOrderId: OTHER_PO },
      }),
    ]);

    const result = await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A3], move: true },
      member,
    );

    expect(result.linked).toHaveLength(1);
    const events = written(tx.purchaseOrderEvent.create);
    expect(events).toEqual([
      expect.objectContaining({
        purchaseOrderId: OTHER_PO,
        eventType: 'ASSET_UNLINKED',
        payload: {
          lineId: OTHER_LINE,
          assetIds: [A3],
          movedToPurchaseOrderId: PO,
          movedToLineId: LINE,
        },
      }),
      expect.objectContaining({
        purchaseOrderId: PO,
        eventType: 'ASSET_LINKED',
      }),
    ]);
    expect(written(tx.assetHistory.create)[0]).toMatchObject({
      eventType: 'PURCHASE_LINKED',
      payload: {
        fromPurchaseOrderId: OTHER_PO,
        fromPurchaseOrderLineId: OTHER_LINE,
      },
    });
  });

  it('over-receipt is allowed and flagged', async () => {
    const { service, reads, tx } = setup();
    reads.asset.findMany.mockResolvedValue([assetRow(A1)]);
    reads.asset.count.mockResolvedValue(5); // quantity 4
    const result = await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A1] },
      member,
    );
    expect(result.linked).toHaveLength(1);
    expect(result.overReceived).toBe(true);
    expect(written(tx.purchaseOrderEvent.create)[0]).toMatchObject({
      payload: { overReceived: true },
    });
  });

  it('refuses an OTHER line (400) and an archived purchase (404) before touching any asset', async () => {
    const other = setup();
    other.reads.purchaseOrderLine.findFirst.mockResolvedValue(
      lineRow({ kind: 'OTHER' }),
    );
    await expect(
      other.service.linkAssets(PO, LINE, { assetIds: [A1] }, member),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(other.tx.asset.update).not.toHaveBeenCalled();

    const archived = setup();
    archived.reads.purchaseOrder.findFirst.mockResolvedValue(null);
    await expect(
      archived.service.linkAssets(PO, LINE, { assetIds: [A1] }, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(archived.tx.asset.update).not.toHaveBeenCalled();
  });

  it('nothing linked: no purchase event', async () => {
    const { service, reads, tx } = setup();
    reads.asset.findMany.mockResolvedValue([]);
    const result = await service.linkAssets(
      PO,
      LINE,
      { assetIds: [A1] },
      member,
    );
    expect(result.linked).toEqual([]);
    expect(tx.purchaseOrderEvent.create).not.toHaveBeenCalled();
  });
});

describe('unlink assets', () => {
  it('unlinks only assets on this line, never clears their values, and logs both sides in one transaction', async () => {
    const { service, tx, reads } = setup();
    reads.asset.findMany.mockResolvedValue([
      assetRow(A1, {
        purchaseOrderLineId: LINE,
        purchaseCost: BigInt(141250000),
      }),
      assetRow(A2, { purchaseOrderLineId: OTHER_LINE }),
    ]);

    const result = await service.unlinkAssets(PO, LINE, [A1, A2, A3], member);

    expect(result.unlinked.map((a) => a.id)).toEqual([A1]);
    expect(result.failed).toEqual([
      expect.objectContaining({ assetId: A2, reason: 'NOT_LINKED' }),
      expect.objectContaining({ assetId: A3, reason: 'NOT_FOUND' }),
    ]);
    expect(written(tx.asset.update)).toEqual([{ purchaseOrderLineId: null }]);
    expect(written(tx.assetHistory.create)).toEqual([
      expect.objectContaining({
        assetId: A1,
        eventType: 'PURCHASE_UNLINKED',
        payload: { purchaseOrderId: PO, purchaseOrderLineId: LINE },
      }),
    ]);
    expect(written(tx.purchaseOrderEvent.create)).toEqual([
      expect.objectContaining({
        eventType: 'ASSET_UNLINKED',
        payload: { lineId: LINE, assetIds: [A1] },
      }),
    ]);
  });
});

describe('receive from a line', () => {
  const ok = { created: [], failed: [], overReceived: false };

  it('prefills from the purchase and receives the pending units against the line', async () => {
    const { service, assets, reads } = setup();
    assets.receiveBatch.mockResolvedValue(ok);
    reads.asset.count.mockResolvedValue(1); // 3 of 4 pending
    reads.location.findFirst.mockResolvedValue({ id: LOCATION });

    await service.receiveFromLine(PO, LINE, {}, member);

    expect(assets.receiveBatch).toHaveBeenCalledWith(
      {
        modelId: MODEL,
        quantity: 3,
        status: 'IN_STORAGE',
        purchaseOrderLineId: LINE,
        locationId: LOCATION,
        company: 'Acme S.A.',
        purchaseDate: '2026-03-10T00:00:00.000Z', // the invoice date
        warrantyEnd: '2029-03-10T00:00:00.000Z', // + 36 months
        purchaseCost: 141250000,
        purchaseCurrency: 'ARS',
      },
      member,
    );
  });

  it('the quantity follows the serials; overrides win; null leaves a prefill empty', async () => {
    const { service, assets, reads } = setup();
    assets.receiveBatch.mockResolvedValue(ok);
    reads.location.findFirst.mockResolvedValue({ id: LOCATION });

    await service.receiveFromLine(
      PO,
      LINE,
      {
        serials: ['SN-1', 'SN-2'],
        modelId: OLD_MODEL,
        status: 'OPERATIONAL',
        locationId: null,
        purchaseCost: null,
        purchaseDate: '2026-04-01T00:00:00.000Z',
        notes: 'Gen 6 delivered, same price',
      },
      member,
    );

    const [body] = assets.receiveBatch.mock.calls[0] as [Row];
    expect(body).toEqual({
      modelId: OLD_MODEL,
      quantity: 2,
      status: 'OPERATIONAL',
      purchaseOrderLineId: LINE,
      company: 'Acme S.A.',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      // Warranty follows the overridden purchase date.
      warrantyEnd: '2029-04-01T00:00:00.000Z',
      notes: 'Gen 6 delivered, same price',
      serials: ['SN-1', 'SN-2'],
    });
  });

  it('without an invoice date the purchase date is today, never the order date; an archived delivery location is skipped', async () => {
    const { service, assets, reads } = setup();
    assets.receiveBatch.mockResolvedValue(ok);
    reads.purchaseOrder.findFirst.mockResolvedValue(
      purchaseRow({ invoiceDate: null }),
    );
    reads.location.findFirst.mockResolvedValue(null);

    await service.receiveFromLine(PO, LINE, { quantity: 1 }, member);

    const [body] = assets.receiveBatch.mock.calls[0] as [Row];
    expect(body.purchaseDate).toBe(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    expect(body).not.toHaveProperty('locationId');
  });

  it('a line without a model is a 400 with the fix in the message — unless the body names one', async () => {
    const { service, assets, reads } = setup();
    reads.purchaseOrderLine.findFirst.mockResolvedValue(
      lineRow({ assetModelId: null }),
    );
    await expect(service.receiveFromLine(PO, LINE, {}, member)).rejects.toThrow(
      /no asset model.*assetModelId.*modelId/,
    );
    expect(assets.receiveBatch).not.toHaveBeenCalled();

    assets.receiveBatch.mockResolvedValue(ok);
    await service.receiveFromLine(PO, LINE, { modelId: MODEL }, member);
    expect(assets.receiveBatch).toHaveBeenCalledTimes(1);
  });

  it('nothing pending and no quantity is a 400; an explicit quantity over-receives and is flagged', async () => {
    const { service, assets, reads } = setup();
    reads.asset.count.mockResolvedValue(4);
    await expect(service.receiveFromLine(PO, LINE, {}, member)).rejects.toThrow(
      /Nothing is pending/,
    );

    assets.receiveBatch.mockResolvedValue({ ...ok, overReceived: true });
    const result = await service.receiveFromLine(
      PO,
      LINE,
      { quantity: 1 },
      member,
    );
    expect(result.overReceived).toBe(true);
    expect(result.line).toMatchObject({ id: LINE });
  });

  it('refuses an archived purchase (404) and an OTHER line (400)', async () => {
    const archived = setup();
    archived.reads.purchaseOrder.findFirst.mockResolvedValue(null);
    await expect(
      archived.service.receiveFromLine(PO, LINE, {}, member),
    ).rejects.toBeInstanceOf(NotFoundException);

    const other = setup();
    other.reads.purchaseOrderLine.findFirst.mockResolvedValue(
      lineRow({ kind: 'OTHER' }),
    );
    await expect(
      other.service.receiveFromLine(PO, LINE, {}, member),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(other.assets.receiveBatch).not.toHaveBeenCalled();
  });
});

describe('pending units', () => {
  it('pages lines with pending > 0 on ordered, live purchases, oldest first, with the purchase header', async () => {
    const { service, prisma, reads } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: OTHER_LINE }, { id: LINE }])
      .mockResolvedValueOnce([{ total: 2 }]);
    reads.purchaseOrderLine.findMany.mockResolvedValue([
      {
        ...lineRow(),
        purchaseOrder: { id: PO, reference: 'OC-4512', supplier: null },
      },
      {
        ...lineRow({ id: OTHER_LINE, quantity: 2 }),
        purchaseOrder: { id: OTHER_PO, reference: null, supplier: null },
      },
    ]);
    reads.asset.groupBy.mockResolvedValue([
      { purchaseOrderLineId: LINE, _count: { _all: 3 } },
    ]);

    const page = await service.findPendingLines(
      { supplierId: 'clsupplier00000000000001' },
      { limit: 50, offset: 0, deleted: 'active' } as never,
    );

    // The SQL order is kept (the findMany order is not trusted).
    expect(page.items.map((item) => item.id)).toEqual([OTHER_LINE, LINE]);
    expect(page.items[1]).toMatchObject({
      receivedQuantity: 3,
      pendingQuantity: 1,
      receiptState: 'PARTIAL',
      unitPrice: 141250000,
      purchaseOrder: { id: PO, reference: 'OC-4512' },
    });
    expect(page.total).toBe(2);
    // The raw SQL, flattened (strings and nested fragments) — the filters that define "pending".
    const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0]).replace(
      /\\"/g,
      '"',
    );
    expect(sql).toContain(`NOT IN ('DRAFT', 'CANCELLED')`);
    expect(sql).toContain('l."quantity" - l."cancelledQuantity" - (');
    expect(sql).toContain('a."deletedAt" IS NULL');
    expect(sql).toContain('po."deletedAt" IS NULL');
    expect(sql).toContain('po."supplierId" = ');
    expect(sql).toContain('clsupplier00000000000001');
  });
});

describe("an asset's provenance", () => {
  it('404 when the asset is missing, and when it is not linked', async () => {
    const { service, reads } = setup();
    reads.asset.findFirst.mockResolvedValue(null);
    await expect(service.findAssetProvenance(A1)).rejects.toThrow('not found');
    reads.asset.findFirst.mockResolvedValue({ purchaseOrderLineId: null });
    await expect(service.findAssetProvenance(A1)).rejects.toThrow(
      'not linked to a purchase',
    );
  });

  it('returns the line, the header with the supplier support contact, and the documents', async () => {
    const { service, reads } = setup();
    reads.asset.findFirst.mockResolvedValue({ purchaseOrderLineId: LINE });
    const supplier = {
      id: 'clsupplier00000000000001',
      name: 'Compumundo',
      website: null,
      supportContactName: 'RMA',
      supportContactEmail: 'rma@example.com',
      supportContactPhone: null,
      deletedAt: null,
    };
    reads.purchaseOrderLine.findFirst.mockResolvedValue({
      ...lineRow(),
      purchaseOrder: { ...purchaseRow(), supplier },
    });
    reads.asset.count.mockResolvedValue(2);
    reads.attachment.findMany.mockResolvedValue([{ id: 'clatt1' }]);

    const result = await service.findAssetProvenance(A1);

    expect(result.line).toMatchObject({ id: LINE, receivedQuantity: 2 });
    expect(result.purchaseOrder).toMatchObject({
      id: PO,
      reference: 'OC-4512',
      invoiceNumbers: 'A-0003-12345',
      supplier,
    });
    expect(result.documents).toEqual([{ id: 'clatt1' }]);
    expect(reads.attachment.findMany).toHaveBeenCalledWith({
      where: { entityType: 'PURCHASE_ORDER', entityId: PO },
      orderBy: { createdAt: 'desc' },
    });
    // The link outlives an archived line or purchase: the escape hatch is used.
    expect(reads.purchaseOrderLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ includeSoftDeleted: true }),
    );
  });

  it('an archived purchase is still the provenance, but its documents are not listed', async () => {
    const { service, reads } = setup();
    reads.asset.findFirst.mockResolvedValue({ purchaseOrderLineId: LINE });
    reads.purchaseOrderLine.findFirst.mockResolvedValue({
      ...lineRow(),
      purchaseOrder: {
        ...purchaseRow({ deletedAt: new Date('2026-09-01T00:00:00Z') }),
        supplier: null,
      },
    });
    const result = await service.findAssetProvenance(A1);
    expect(result.purchaseOrder.deletedAt).toEqual(
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(result.documents).toEqual([]);
    expect(reads.attachment.findMany).not.toHaveBeenCalled();
  });
});

describe('receive into stock — a CONSUMABLE line (#1476)', () => {
  const consumableLine = (over: Row = {}) =>
    lineRow({
      kind: 'CONSUMABLE',
      description: 'Toner HP 58A',
      assetModelId: null,
      consumableId: CONSUMABLE,
      quantity: 10,
      unitPrice: BigInt(4500000),
      warrantyMonths: null,
      ...over,
    });

  function stockSetup(over: Row = {}) {
    const ctx = setup();
    ctx.reads.purchaseOrderLine.findFirst.mockResolvedValue(
      consumableLine(over),
    );
    ctx.reads.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(
      consumableLine(over),
    );
    ctx.reads.consumable.findFirst.mockResolvedValue({
      id: CONSUMABLE,
      currentStock: 2,
      minStock: null,
      name: 'Toner HP 58A',
    });
    return ctx;
  }

  it('posts exactly ONE IN movement through the consumables path, linked to the line, in one transaction with STOCK_RECEIVED', async () => {
    const { service, tx, prisma } = stockSetup();

    const result = await service.receiveStock(
      PO,
      LINE,
      { quantity: 4, note: 'box 1 of 3' },
      member,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(written(tx.consumableMovement.create)).toEqual([
      {
        consumableId: CONSUMABLE,
        type: 'IN',
        quantity: 4,
        reason: STOCK_RECEIPT_REASON,
        notes: 'box 1 of 3',
        performedById: USER_ID,
        purchaseOrderLineId: LINE,
      },
    ]);
    // The cache moves through the movement path's atomic increment — never a direct write of a value.
    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: CONSUMABLE },
      data: { currentStock: { increment: 4 } },
    });
    expect(written(tx.purchaseOrderEvent.create)).toEqual([
      expect.objectContaining({
        purchaseOrderId: PO,
        eventType: 'STOCK_RECEIVED',
        performedById: USER_ID,
        payload: {
          lineId: LINE,
          consumableId: CONSUMABLE,
          movementId: 77,
          quantity: 4,
          overReceived: false,
        },
      }),
    ]);
    expect(result.movement).toMatchObject({
      id: 77,
      purchaseOrderLineId: LINE,
    });
    expect(result.overReceived).toBe(false);
  });

  it('the reason names no supplier or reference (D-A: the ledger is read without purchaseOrder:read)', () => {
    expect(STOCK_RECEIPT_REASON).not.toMatch(/OC-4512|Acme/);
    expect(STOCK_RECEIPT_REASON).toBe('Received from a purchase');
  });

  it('locks the purchase (KEY SHARE) inside the movement transaction, before the stock moves', async () => {
    const { service, tx } = stockSetup();
    await service.receiveStock(PO, LINE, { quantity: 1 }, member);
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('FOR KEY SHARE');
    expect(values).toEqual([PO]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.consumable.update.mock.invocationCallOrder[0],
    );
  });

  it('over-receipt is allowed and flagged: 8 already in + 4 on a line of 10', async () => {
    const { service, tx, reads } = stockSetup();
    tx.consumableMovement.aggregate.mockResolvedValue({
      _sum: { quantity: 12 },
    });
    reads.consumableMovement.groupBy.mockResolvedValue([
      { purchaseOrderLineId: LINE, _sum: { quantity: 12 } },
    ]);
    const result = await service.receiveStock(
      PO,
      LINE,
      { quantity: 4 },
      member,
    );
    expect(result.overReceived).toBe(true);
    expect(result.line).toMatchObject({
      receivedQuantity: 12,
      pendingQuantity: 0,
      receiptState: 'OVER',
    });
    expect(written(tx.purchaseOrderEvent.create)[0]).toMatchObject({
      payload: { overReceived: true },
    });
  });

  it('400 for an ASSET or OTHER line, a line with no consumable, and an archived consumable — nothing moves', async () => {
    for (const over of [
      { kind: 'ASSET', consumableId: null },
      { kind: 'OTHER', consumableId: null },
      { consumableId: null },
    ]) {
      const { service, tx } = stockSetup(over);
      await expect(
        service.receiveStock(PO, LINE, { quantity: 1 }, member),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.consumableMovement.create).not.toHaveBeenCalled();
    }
    const { service, tx, reads } = stockSetup();
    reads.consumable.findFirst.mockResolvedValue(null);
    await expect(
      service.receiveStock(PO, LINE, { quantity: 1 }, member),
    ).rejects.toThrow(/archived/);
    expect(reads.consumable.findFirst).toHaveBeenCalledWith({
      where: { id: CONSUMABLE, deletedAt: null },
      select: { id: true },
    });
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('404 on an archived purchase', async () => {
    const { service, reads, tx } = stockSetup();
    reads.purchaseOrder.findFirst.mockResolvedValue(null);
    await expect(
      service.receiveStock(PO, LINE, { quantity: 1 }, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('409 when the line changed under the lock (its consumable or kind) — the movement rolls back unwritten', async () => {
    const { service, tx, reads } = stockSetup();
    reads.purchaseOrderLine.findFirst
      .mockResolvedValueOnce(consumableLine())
      .mockResolvedValueOnce(
        consumableLine({ consumableId: 'clconsumable000000000002' }),
      );
    await expect(
      service.receiveStock(PO, LINE, { quantity: 1 }, member),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('the pending-units list includes CONSUMABLE lines, counted from their IN movements', async () => {
    const { service, prisma, reads } = stockSetup();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: LINE }])
      .mockResolvedValueOnce([{ total: 1 }]);
    reads.purchaseOrderLine.findMany.mockResolvedValue([
      {
        ...consumableLine(),
        purchaseOrder: { id: PO, reference: 'OC-4512', supplier: null },
      },
    ]);
    reads.consumableMovement.groupBy.mockResolvedValue([
      { purchaseOrderLineId: LINE, _sum: { quantity: 4 } },
    ]);
    const page = await service.findPendingLines({}, {
      limit: 50,
      offset: 0,
      deleted: 'active',
    } as never);
    expect(page.items[0]).toMatchObject({
      kind: 'CONSUMABLE',
      consumableId: CONSUMABLE,
      receivedQuantity: 4,
      pendingQuantity: 6,
      receiptState: 'PARTIAL',
    });
    const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0]).replace(
      /\\"/g,
      '"',
    );
    expect(sql).toContain('consumable_movements');
    expect(sql).toContain('CONSUMABLE');
  });
});
