// The service imports the generated client for types and `Prisma.join` (the receipt-filter SQL); stub it so
// no real client loads. The fake delegates below stand in for the database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { join: (values: unknown[]) => values },
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ActorService } from '../common/actor.service';
import { runInAiInvocation } from '../ai/core/invocation-context';
import type { Principal } from '../auth/principal';
import type { PrismaService } from '../prisma/prisma.service';
import { PurchaseOrdersService } from './purchase-orders.service';

const PO = 'clpo00000000000000000001';
const LINE = 'clline000000000000000001';
const SUPPLIER = 'clsupplier00000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SA_ID = 'clsa0000000000000000001';
const ABOVE_INT4 = 3_000_000_000;

const human = {
  kind: 'human',
  user: { id: USER_ID, role: 'MEMBER' },
} as unknown as Principal;
const serviceAccount = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(['purchaseOrder:write']),
} as unknown as Principal;

type Row = Record<string, unknown>;

/** A stored purchase row as Prisma returns it (Dates, bigint prices). */
function purchaseRow(over: Row = {}): Row {
  return {
    id: PO,
    reference: null,
    supplierId: null,
    status: 'ORDERED',
    currency: null,
    orderDate: null,
    expectedDate: null,
    deliveryLocationId: null,
    company: null,
    invoiceNumbers: null,
    invoiceDate: null,
    notes: null,
    createdAt: new Date('2026-10-02T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    supplier: null,
    lines: [],
    ...over,
  };
}

function lineRow(over: Row = {}): Row {
  return {
    id: LINE,
    purchaseOrderId: PO,
    position: 0,
    kind: 'ASSET',
    description: 'Laptop',
    manufacturerText: null,
    modelText: null,
    assetModelId: null,
    quantity: 1,
    unitPrice: null,
    cancelledQuantity: 0,
    warrantyMonths: null,
    createdAt: new Date('2026-10-02T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

function makePrisma() {
  const prisma = {
    purchaseOrder: {
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    purchaseOrderLine: {
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    purchaseOrderEvent: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    asset: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    supplier: { findFirst: jest.fn() },
    location: { findFirst: jest.fn() },
    assetModel: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  // An interactive transaction runs on the same fake; an array transaction resolves each query.
  prisma.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(prisma),
  );
  return prisma;
}

type FakePrisma = ReturnType<typeof makePrisma>;

/** The `data` of every activity-log row written, in order. */
function events(prisma: FakePrisma): Row[] {
  return (prisma.purchaseOrderEvent.create.mock.calls as [{ data: Row }][]).map(
    ([args]) => args.data,
  );
}

/** The SQL of the n-th raw query, and its bound values (a tagged template call). */
function rawQuery(
  prisma: FakePrisma,
  n: number,
): { sql: string; values: unknown[] } {
  const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  return { sql: strings.join('?'), values };
}

/** True when the purchase row was locked before the given write ran. */
function lockedBefore(prisma: FakePrisma, write: jest.Mock): boolean {
  const lock = rawQuery(prisma, 0);
  return (
    lock.sql.includes('FOR UPDATE') &&
    lock.values[0] === PO &&
    prisma.$queryRaw.mock.invocationCallOrder[0] <
      (write.mock.invocationCallOrder[0] ?? Infinity)
  );
}

describe('PurchaseOrdersService', () => {
  let prisma: FakePrisma;
  let service: PurchaseOrdersService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new PurchaseOrdersService(
      prisma as unknown as PrismaService,
      new ActorService(),
    );
  });

  describe('create — light entry (ADR-0099, CEO decision D-D)', () => {
    it('creates a purchase from a single description-only line, ORDERED by default, with its CREATED event', async () => {
      prisma.purchaseOrder.create.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ lines: [lineRow()] }),
      );

      const detail = await service.create(
        { lines: [{ description: 'Laptop' }] },
        human,
      );

      const data = (
        prisma.purchaseOrder.create.mock.calls[0] as [{ data: Row }]
      )[0].data;
      expect(data.status).toBe('ORDERED');
      expect(data.lines).toEqual({
        create: [{ description: 'Laptop', kind: 'ASSET', position: 0 }],
      });
      expect(events(prisma)).toEqual([
        {
          purchaseOrderId: PO,
          eventType: 'CREATED',
          payload: { lineCount: 1 },
          performedById: USER_ID,
        },
      ]);
      expect(detail.lines[0]).toMatchObject({
        description: 'Laptop',
        quantity: 1,
        receiptState: 'NONE',
        pendingQuantity: 1,
      });
    });

    it('accepts the same reference twice — nothing is unique, so no lookup and no refusal', async () => {
      prisma.purchaseOrder.create.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ reference: 'OC-100' }),
      );

      await service.create({ reference: 'OC-100' }, human);
      await service.create({ reference: 'OC-100' }, human);

      expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(2);
      // The only purchase reads are the post-create detail reads, by id — never by reference.
      for (const [args] of prisma.purchaseOrder.findFirst.mock.calls as [
        { where: Row },
      ][]) {
        expect(args.where).toEqual({ id: PO, deletedAt: null });
      }
    });

    it('writes a unit price above int4 as bigint and reads it back as the exact number', async () => {
      prisma.purchaseOrder.create.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({
          currency: 'ARS',
          lines: [lineRow({ quantity: 2, unitPrice: BigInt(ABOVE_INT4) })],
        }),
      );

      const detail = await service.create(
        {
          currency: 'ARS',
          lines: [
            { description: 'Server', quantity: 2, unitPrice: ABOVE_INT4 },
          ],
        },
        human,
      );

      const data = (
        prisma.purchaseOrder.create.mock.calls[0] as [{ data: Row }]
      )[0].data as { lines: { create: Row[] } };
      expect(data.lines.create[0].unitPrice).toBe(BigInt(ABOVE_INT4));
      expect(detail.lines[0].unitPrice).toBe(ABOVE_INT4);
      expect(detail.lines[0].lineTotal).toBe(2 * ABOVE_INT4);
      expect(detail.totals).toEqual([
        { currency: 'ARS', amount: 2 * ABOVE_INT4, unpricedLines: 0 },
      ]);
      // The serialized detail never carries a bigint (JSON.stringify would throw).
      expect(() => JSON.stringify(detail)).not.toThrow();
    });

    it('attributes the event to a service account, never a fake human (INV-SA-4)', async () => {
      prisma.purchaseOrder.create.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());

      await service.create({ reference: 'OC-SA' }, serviceAccount);

      expect(events(prisma)[0]).toEqual({
        purchaseOrderId: PO,
        eventType: 'CREATED',
        payload: { lineCount: 0 },
        serviceAccountId: SA_ID,
      });
    });

    it('stamps the AI invocation on the event when an AI tool made the call', async () => {
      prisma.purchaseOrder.create.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());

      await runInAiInvocation(
        { invocationId: 'inv-1', channel: 'chat' } as never,
        () => service.create({ reference: 'OC-AI' }, human),
      );

      expect(events(prisma)[0]).toMatchObject({
        performedById: USER_ID,
        aiInvocationId: 'inv-1',
      });
    });

    it('refuses an archived supplier (400) — a soft-deleted row still passes the FK', async () => {
      prisma.supplier.findFirst.mockResolvedValue(null);
      await expect(
        service.create({ supplierId: SUPPLIER }, human),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.purchaseOrder.create).not.toHaveBeenCalled();
    });

    it('refuses a line whose quantity × price would exceed MONEY_MAX', async () => {
      await expect(
        service.create(
          {
            lines: [
              {
                description: 'x',
                quantity: 2,
                unitPrice: Number.MAX_SAFE_INTEGER,
              },
            ],
          },
          human,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('findOne — derived values', () => {
    it('derives OVER when more live assets point at a line than its quantity', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({
          currency: 'USD',
          lines: [
            lineRow({ quantity: 4, unitPrice: BigInt(100_000) }),
            lineRow({
              id: 'clline000000000000000002',
              kind: 'OTHER',
              description: 'Shipping',
              unitPrice: BigInt(5_000),
            }),
          ],
        }),
      );
      // Five assets linked to a line of four (the fixture linking will produce in #1473).
      prisma.asset.groupBy.mockResolvedValue([
        { purchaseOrderLineId: LINE, _count: { _all: 5 } },
      ]);

      const detail = await service.findOne(PO);

      expect(prisma.asset.groupBy).toHaveBeenCalledWith({
        by: ['purchaseOrderLineId'],
        where: {
          purchaseOrderLineId: { in: [LINE, 'clline000000000000000002'] },
          deletedAt: null,
        },
        _count: { _all: true },
      });
      expect(detail.lines[0]).toMatchObject({
        receivedQuantity: 5,
        pendingQuantity: 0,
        receiptState: 'OVER',
      });
      expect(detail.lines[1]).toMatchObject({
        receiptState: null,
        pendingQuantity: 0,
      });
      expect(detail.receipt).toEqual({
        state: 'OVER',
        ordered: 4,
        received: 5,
        cancelled: 0,
        pending: 0,
      });
      expect(detail.totals).toEqual([
        { currency: 'USD', amount: 405_000, unpricedLines: 0 },
      ]);
    });

    it('404 for a missing or soft-deleted purchase', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      await expect(service.findOne(PO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('findPage — receipt filter', () => {
    it('PENDING resolves to purchases with units still pending and excludes CANCELLED ones', async () => {
      prisma.$queryRaw.mockResolvedValue([
        // pending: 1 of 2 received
        {
          purchaseOrderId: 'clpoPending000000000001',
          kind: 'ASSET',
          quantity: 2,
          cancelledQuantity: 0,
          received: 1,
        },
        // fully received
        {
          purchaseOrderId: 'clpoDone0000000000000001',
          kind: 'ASSET',
          quantity: 1,
          cancelledQuantity: 0,
          received: 1,
        },
      ]);
      prisma.purchaseOrder.findMany.mockResolvedValue([]);
      prisma.purchaseOrder.count.mockResolvedValue(0);

      await service.findPage(
        { receipt: 'PENDING' },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const where = (
        prisma.purchaseOrder.findMany.mock.calls[0] as [{ where: Row }]
      )[0].where;
      expect(where).toEqual({
        AND: [
          {
            AND: [
              { id: { in: ['clpoPending000000000001'] } },
              { status: { not: 'CANCELLED' } },
            ],
          },
          { deletedAt: null },
        ],
      });
    });

    it('q searches reference, invoice numbers, supplier name and live line descriptions', async () => {
      prisma.purchaseOrder.findMany.mockResolvedValue([]);
      prisma.purchaseOrder.count.mockResolvedValue(0);

      await service.findPage(
        { q: 'dell', status: ['ORDERED'] },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const where = (
        prisma.purchaseOrder.findMany.mock.calls[0] as [{ where: Row }]
      )[0].where;
      const contains = { contains: 'dell', mode: 'insensitive' };
      expect(where).toEqual({
        AND: [
          {
            AND: [
              {
                OR: [
                  { reference: contains },
                  { invoiceNumbers: contains },
                  { supplier: { name: contains } },
                  {
                    lines: { some: { deletedAt: null, description: contains } },
                  },
                ],
              },
              { status: { in: ['ORDERED'] } },
            ],
          },
          { deletedAt: null },
        ],
      });
    });
  });

  describe('update', () => {
    it('writes STATUS_CHANGED with from/to and UPDATED with the changed header fields', async () => {
      prisma.purchaseOrder.findFirst
        .mockResolvedValueOnce(purchaseRow({ reference: 'OC-1' }))
        .mockResolvedValueOnce(purchaseRow({ reference: 'OC-1' }));

      await service.update(
        PO,
        { status: 'CANCELLED', currency: 'USD', notes: 'long text' },
        human,
      );

      expect(events(prisma)).toEqual([
        expect.objectContaining({
          eventType: 'STATUS_CHANGED',
          payload: { from: 'ORDERED', to: 'CANCELLED' },
        }),
        expect.objectContaining({
          eventType: 'UPDATED',
          payload: {
            fields: ['currency', 'notes'],
            changes: {
              currency: { from: null, to: 'USD' },
              notes: { changed: true },
            },
          },
        }),
      ]);
    });

    it('refuses to leave a purchase with no supplier, no reference and no line', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ reference: 'OC-1' }),
      );
      prisma.purchaseOrderLine.count.mockResolvedValue(0);

      await expect(
        service.update(PO, { reference: null }, human),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
    });

    it('locks the purchase row before checking and writing (race-safe identifiability)', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ reference: 'OC-1' }),
      );
      prisma.purchaseOrderLine.count.mockResolvedValue(1);

      await service.update(PO, { reference: null }, human);

      expect(lockedBefore(prisma, prisma.purchaseOrderLine.count)).toBe(true);
      expect(lockedBefore(prisma, prisma.purchaseOrder.update)).toBe(true);
    });
  });

  describe('soft delete and restore', () => {
    it('soft-deletes (never a hard delete), keeps asset links, and logs DELETED', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());
      prisma.purchaseOrder.findFirstOrThrow.mockResolvedValue(
        purchaseRow({ deletedAt: new Date() }),
      );

      await service.remove(PO, human);

      const update = (
        prisma.purchaseOrder.update.mock.calls[0] as [{ data: Row }]
      )[0];
      expect(Object.keys(update.data)).toEqual(['deletedAt']);
      expect(update.data.deletedAt).toBeInstanceOf(Date);
      expect(events(prisma)[0]).toMatchObject({ eventType: 'DELETED' });
    });

    it('restore finds the archived row through the escape hatch, clears deletedAt and logs RESTORED', async () => {
      prisma.purchaseOrder.findFirst
        .mockResolvedValueOnce(purchaseRow({ deletedAt: new Date() }))
        .mockResolvedValueOnce(purchaseRow());

      await service.restore(PO, human);

      expect(prisma.purchaseOrder.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: PO },
        includeSoftDeleted: true,
      });
      expect(prisma.purchaseOrder.update).toHaveBeenCalledWith({
        where: { id: PO },
        data: { deletedAt: null },
      });
      expect(events(prisma)[0]).toMatchObject({ eventType: 'RESTORED' });
    });

    it('restore of a live purchase is idempotent: no write, no event', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());
      await service.restore(PO, human);
      expect(prisma.purchaseOrder.update).not.toHaveBeenCalled();
      expect(events(prisma)).toEqual([]);
    });
  });

  describe('lines', () => {
    beforeEach(() => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());
    });

    it('adds a description-only line after the last one and logs LINE_ADDED', async () => {
      prisma.purchaseOrderLine.aggregate.mockResolvedValue({
        _max: { position: 2 },
      });
      prisma.purchaseOrderLine.create.mockResolvedValue(
        lineRow({ position: 3 }),
      );
      prisma.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(
        lineRow({ position: 3 }),
      );

      const line = await service.addLine(PO, { description: 'Mouse' }, human);

      expect(prisma.purchaseOrderLine.create).toHaveBeenCalledWith({
        data: {
          purchaseOrderId: PO,
          description: 'Mouse',
          kind: 'ASSET',
          position: 3,
        },
      });
      expect(line).toMatchObject({ position: 3, receiptState: 'NONE' });
      expect(events(prisma)[0]).toMatchObject({
        eventType: 'LINE_ADDED',
        payload: expect.objectContaining({ lineId: LINE }) as unknown,
      });
    });

    it('records a price change before and after in LINE_UPDATED', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(
        lineRow({ unitPrice: BigInt(100_000) }),
      );
      prisma.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(
        lineRow({ unitPrice: BigInt(ABOVE_INT4) }),
      );

      const line = await service.updateLine(
        PO,
        LINE,
        { unitPrice: ABOVE_INT4 },
        human,
      );

      expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
        where: { id: LINE },
        data: { unitPrice: BigInt(ABOVE_INT4) },
      });
      expect(events(prisma)[0]).toMatchObject({
        eventType: 'LINE_UPDATED',
        payload: {
          lineId: LINE,
          changes: { unitPrice: { from: 100_000, to: ABOVE_INT4 } },
        },
      });
      expect(line.unitPrice).toBe(ABOVE_INT4);
    });

    it('refuses more cancelled units than the quantity, against the stored line', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(
        lineRow({ quantity: 2 }),
      );
      await expect(
        service.updateLine(PO, LINE, { cancelledQuantity: 3 }, human),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    });

    it('refuses to remove a line with linked assets (409)', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.asset.count.mockResolvedValue(2);
      await expect(service.removeLine(PO, LINE, human)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    });

    it('refuses to remove the last thing that identifies the purchase', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.purchaseOrderLine.count.mockResolvedValue(0);
      await expect(service.removeLine(PO, LINE, human)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('soft-deletes a removable line and logs LINE_REMOVED', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ reference: 'OC-1' }),
      );
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());

      await service.removeLine(PO, LINE, human);

      const update = (
        prisma.purchaseOrderLine.update.mock.calls[0] as [{ data: Row }]
      )[0];
      expect(update.data.deletedAt).toBeInstanceOf(Date);
      expect(events(prisma)[0]).toMatchObject({
        eventType: 'LINE_REMOVED',
        payload: { lineId: LINE, description: 'Laptop' },
      });
    });

    it('returns the full line shape, stamped with the same deletedAt it wrote', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(
        purchaseRow({ reference: 'OC-1' }),
      );
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(
        lineRow({ quantity: 2, unitPrice: BigInt(ABOVE_INT4) }),
      );

      const removed = await service.removeLine(PO, LINE, human);

      const written = (
        prisma.purchaseOrderLine.update.mock.calls[0] as [{ data: Row }]
      )[0].data.deletedAt;
      expect(removed.deletedAt).toBe(written);
      expect(removed).toMatchObject({
        id: LINE,
        unitPrice: ABOVE_INT4,
        receivedQuantity: 0,
        pendingQuantity: 2,
        receiptState: 'NONE',
        lineTotal: 2 * ABOVE_INT4,
      });
      expect(() => JSON.stringify(removed)).not.toThrow();
    });

    it('locks the purchase row before the last-line check (race-safe identifiability)', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.purchaseOrderLine.count.mockResolvedValue(1);

      await service.removeLine(PO, LINE, human);

      expect(lockedBefore(prisma, prisma.purchaseOrderLine.count)).toBe(true);
      expect(lockedBefore(prisma, prisma.purchaseOrderLine.update)).toBe(true);
    });

    it('refuses to change the kind of a line with linked assets (409)', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.asset.count.mockResolvedValue(3);

      await expect(
        service.updateLine(PO, LINE, { kind: 'OTHER' }, human),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.asset.count).toHaveBeenCalledWith({
        where: { purchaseOrderLineId: LINE, deletedAt: null },
      });
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
    });

    it('a kind change locks the purchase before counting linked assets (a concurrent link waits) — #1473', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(
        lineRow({ kind: 'OTHER' }),
      );
      prisma.$queryRaw.mockResolvedValue([]);
      await service.updateLine(PO, LINE, { kind: 'OTHER' }, human);
      expect(lockedBefore(prisma, prisma.asset.count)).toBe(true);
      expect(lockedBefore(prisma, prisma.purchaseOrderLine.update)).toBe(true);
    });

    it('an update that does not touch the kind takes no lock', async () => {
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(lineRow());
      prisma.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(lineRow());
      await service.updateLine(PO, LINE, { description: 'Laptop 14' }, human);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('a line of another purchase is not found here: 404 on update and removal, scoped by purchaseOrderId', async () => {
      // The line exists, but on another purchase: the purchase-scoped lookup finds nothing.
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(null);

      await expect(
        service.updateLine(PO, LINE, { description: 'x' }, human),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.removeLine(PO, LINE, human)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      for (const [args] of prisma.purchaseOrderLine.findFirst.mock.calls as [
        { where: Row },
      ][]) {
        expect(args.where).toEqual({
          id: LINE,
          purchaseOrderId: PO,
          deletedAt: null,
        });
      }
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
      expect(events(prisma)).toEqual([]);
    });
  });

  describe('cancel remaining units (#1473)', () => {
    beforeEach(() => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(purchaseRow());
      prisma.purchaseOrderLine.findFirst.mockResolvedValue(
        lineRow({ quantity: 4 }),
      );
      prisma.$queryRaw.mockResolvedValue([]);
    });

    function stored(cancelledQuantity: number, received: number) {
      prisma.purchaseOrderLine.findFirstOrThrow.mockResolvedValue(
        lineRow({ quantity: 4, cancelledQuantity }),
      );
      prisma.asset.groupBy.mockResolvedValue(
        received > 0
          ? [{ purchaseOrderLineId: LINE, _count: { _all: received } }]
          : [],
      );
    }

    it('cancels every pending unit by default, under a line lock, and logs UNITS_CANCELLED with the reason', async () => {
      stored(0, 3);
      await service.cancelRemaining(
        PO,
        LINE,
        { reason: '4th never came' },
        human,
      );
      expect(rawQuery(prisma, 0).sql).toContain('FOR UPDATE');
      expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
        where: { id: LINE },
        data: { cancelledQuantity: 1 },
      });
      expect(events(prisma)).toEqual([
        expect.objectContaining({
          eventType: 'UNITS_CANCELLED',
          performedById: USER_ID,
          payload: {
            lineId: LINE,
            quantity: 1,
            cancelledQuantity: { from: 0, to: 1 },
            reason: '4th never came',
          },
        }),
      ]);
    });

    it('cancels a given quantity on top of what was already cancelled; the reason is optional', async () => {
      stored(1, 0); // 3 pending
      await service.cancelRemaining(PO, LINE, { quantity: 2 }, human);
      expect(prisma.purchaseOrderLine.update).toHaveBeenCalledWith({
        where: { id: LINE },
        data: { cancelledQuantity: 3 },
      });
      expect(events(prisma)[0]).toMatchObject({
        payload: { quantity: 2, reason: null },
      });
    });

    it('400 beyond the pending count, 409 with nothing pending — no write either way', async () => {
      stored(0, 3);
      await expect(
        service.cancelRemaining(PO, LINE, { quantity: 2 }, human),
      ).rejects.toBeInstanceOf(BadRequestException);
      stored(0, 4);
      await expect(
        service.cancelRemaining(PO, LINE, {}, human),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.purchaseOrderLine.update).not.toHaveBeenCalled();
      expect(events(prisma)).toEqual([]);
    });

    it('404 on an archived purchase', async () => {
      prisma.purchaseOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.cancelRemaining(PO, LINE, {}, human),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
