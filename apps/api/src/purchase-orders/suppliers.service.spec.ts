jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Principal } from '../auth/principal';
import { ActorService } from '../common/actor.service';
import type { PrismaService } from '../prisma/prisma.service';
import { planSupplierMerge, SuppliersService } from './suppliers.service';

const ID = 'clsupplier00000000000001';

describe('SuppliersService (ADR-0099 §2)', () => {
  const supplier = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const prisma = {
    supplier,
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new SuppliersService(
    prisma as unknown as PrismaService,
    new ActorService(),
  );

  beforeEach(() => jest.clearAllMocks());

  it('creates a supplier with only a name', async () => {
    supplier.create.mockResolvedValue({ id: ID, name: 'Compumundo' });
    await service.create({ name: 'Compumundo' });
    expect(supplier.create).toHaveBeenCalledWith({
      data: { name: 'Compumundo' },
    });
  });

  it('accepts the same name twice — no uniqueness check, no lookup (CEO decision D-D)', async () => {
    supplier.create.mockResolvedValue({ id: ID, name: 'Compumundo' });
    await service.create({ name: 'Compumundo' });
    await service.create({ name: 'Compumundo', taxId: '30-1' });
    expect(supplier.create).toHaveBeenCalledTimes(2);
    expect(supplier.findFirst).not.toHaveBeenCalled();
  });

  it('lists live rows by default, name asc, with q over name, tax ID and contacts', async () => {
    supplier.findMany.mockResolvedValue([]);
    supplier.count.mockResolvedValue(0);
    await service.findPage(
      { q: 'compu' },
      { limit: 50, offset: 0, deleted: 'active' },
    );
    const args = (supplier.findMany.mock.calls as unknown[][])[0][0] as {
      where: { OR: unknown[]; deletedAt: null };
      orderBy: unknown;
    };
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.OR).toHaveLength(6);
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('soft-deletes and 404s a missing supplier', async () => {
    supplier.findFirst.mockResolvedValueOnce({ id: ID, deletedAt: null });
    supplier.update.mockResolvedValue({ id: ID });
    await service.remove(ID);
    const data = (
      (supplier.update.mock.calls as unknown[][])[0][0] as {
        data: { deletedAt: Date };
      }
    ).data;
    expect(data.deletedAt).toBeInstanceOf(Date);

    supplier.findFirst.mockResolvedValueOnce(null);
    await expect(service.remove(ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restores through the soft-delete escape hatch, idempotently', async () => {
    supplier.findFirst.mockResolvedValueOnce({ id: ID, deletedAt: new Date() });
    supplier.update.mockResolvedValue({ id: ID, deletedAt: null });
    await service.restore(ID);
    expect(supplier.findFirst).toHaveBeenCalledWith({
      where: { id: ID },
      includeSoftDeleted: true,
    });
    expect(supplier.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { deletedAt: null },
    });

    supplier.update.mockClear();
    supplier.findFirst.mockResolvedValueOnce({ id: ID, deletedAt: null });
    await service.restore(ID);
    expect(supplier.update).not.toHaveBeenCalled();
  });
});

// ── Merge (#1496) ─────────────────────────────────────────────────────────────────────────────────────────

const KEPT = 'clsupplier00000000000001';
const DUP = 'clsupplier00000000000002';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SA_ID = 'clsa0000000000000000001';
const admin = {
  kind: 'human',
  user: { id: USER_ID, role: 'ADMIN' },
} as unknown as Principal;
const serviceAccount = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(['purchaseOrder:delete']),
} as unknown as Principal;

type Row = Record<string, unknown>;

function supplierRow(id: string, over: Row = {}): Row {
  return {
    id,
    name: id === KEPT ? 'Compumundo' : 'COMPUMUNDO SA',
    taxId: null,
    website: null,
    salesContactName: null,
    salesContactEmail: null,
    salesContactPhone: null,
    supportContactName: null,
    supportContactEmail: null,
    supportContactPhone: null,
    notes: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

describe('planSupplierMerge — fill the empty, never overwrite (CEO decision 2026-10-03)', () => {
  it('fills only what the kept supplier lacks, keeps what it has, never touches the name', () => {
    const plan = planSupplierMerge(
      supplierRow(KEPT, { taxId: '30-1', notes: '  ' }) as never,
      supplierRow(DUP, {
        taxId: '30-2',
        salesContactEmail: 'ventas@compumundo.example',
        notes: 'RMA by web form',
      }) as never,
    );
    expect(plan.fill).toEqual([
      { field: 'salesContactEmail', value: 'ventas@compumundo.example' },
      // A blank stored value counts as empty.
      { field: 'notes', value: 'RMA by web form' },
    ]);
    expect(plan.kept).toEqual([
      { field: 'taxId', value: '30-1', sourceValue: '30-2' },
    ]);
  });

  it('an equal value is neither filled nor reported as kept', () => {
    const plan = planSupplierMerge(
      supplierRow(KEPT, { taxId: '30-1' }) as never,
      supplierRow(DUP, { taxId: '30-1' }) as never,
    );
    expect(plan).toEqual({ fill: [], kept: [] });
  });
});

describe('SuppliersService.merge (#1496)', () => {
  function makePrisma() {
    const prisma = {
      supplier: { findFirst: jest.fn(), update: jest.fn() },
      purchaseOrder: { updateMany: jest.fn(), count: jest.fn() },
      purchaseOrderEvent: { createMany: jest.fn() },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    prisma.supplier.update.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Row }) =>
        Promise.resolve(supplierRow(where.id, data)),
    );
    return prisma;
  }
  type FakePrisma = ReturnType<typeof makePrisma>;

  /** The SQL text and bound values of the n-th raw query. */
  function rawQuery(prisma: FakePrisma, n: number) {
    const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    return { sql: strings.join('?'), values };
  }

  /** Lock results: the two supplier rows (in id order), then the duplicate's purchases. */
  function given(
    prisma: FakePrisma,
    suppliers: Row[],
    purchaseIds: string[] = [],
  ) {
    prisma.$queryRaw
      .mockResolvedValueOnce(suppliers)
      .mockResolvedValueOnce(purchaseIds.map((id) => ({ id })));
  }

  const service = (prisma: FakePrisma) =>
    new SuppliersService(
      prisma as unknown as PrismaService,
      new ActorService(),
    );

  it('moves every purchase of the duplicate — archived ones included — to the supplier that stays', async () => {
    const prisma = makePrisma();
    given(
      prisma,
      [supplierRow(KEPT), supplierRow(DUP)],
      ['clpo00000000000000000001', 'clpo00000000000000000002'],
    );
    const result = await service(prisma).merge(KEPT, DUP, admin);

    const purchases = rawQuery(prisma, 1);
    expect(purchases.sql).toContain('FROM "purchase_orders"');
    expect(purchases.sql).toContain('"supplierId" =');
    // No live-only filter: an archived purchase moves with the rest, so the history stays together.
    expect(purchases.sql).not.toContain('deletedAt');
    expect(purchases.values).toEqual([DUP]);
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['clpo00000000000000000001', 'clpo00000000000000000002'] },
      },
      data: { supplierId: KEPT },
    });
    expect(result.movedPurchases).toBe(2);
  });

  it("fills only the kept supplier's empty fields from the duplicate, overwriting nothing", async () => {
    const prisma = makePrisma();
    given(prisma, [
      supplierRow(KEPT, { taxId: '30-1', website: 'compumundo.example' }),
      supplierRow(DUP, {
        taxId: '30-9',
        website: 'other.example',
        supportContactEmail: 'rma@compumundo.example',
        supportContactPhone: '+54 11 5555-0000',
      }),
    ]);
    const result = await service(prisma).merge(KEPT, DUP, admin);

    expect(prisma.supplier.update).toHaveBeenCalledWith({
      where: { id: KEPT },
      data: {
        supportContactEmail: 'rma@compumundo.example',
        supportContactPhone: '+54 11 5555-0000',
      },
    });
    expect(result.filledFields).toEqual([
      'supportContactEmail',
      'supportContactPhone',
    ]);
    expect(result.supplier).toMatchObject({
      id: KEPT,
      supportContactEmail: 'rma@compumundo.example',
    });
  });

  it('writes nothing to the kept supplier when there is nothing to fill', async () => {
    const prisma = makePrisma();
    given(prisma, [supplierRow(KEPT, { taxId: '30-1' }), supplierRow(DUP)]);
    const result = await service(prisma).merge(KEPT, DUP, admin);
    const keptWrites = (
      prisma.supplier.update.mock.calls as [{ where: { id: string } }][]
    ).filter(([args]) => args.where.id === KEPT);
    expect(keptWrites).toHaveLength(0);
    expect(result.filledFields).toEqual([]);
    expect(result.supplier).toMatchObject({ id: KEPT, taxId: '30-1' });
  });

  it('archives the duplicate — a soft delete, never a delete', async () => {
    const prisma = makePrisma();
    given(prisma, [supplierRow(KEPT), supplierRow(DUP)]);
    await service(prisma).merge(KEPT, DUP, admin);
    const archive = (
      prisma.supplier.update.mock.calls as [
        { where: { id: string }; data: { deletedAt?: Date } },
      ][]
    ).find(([args]) => args.where.id === DUP);
    expect(archive?.[0].data.deletedAt).toBeInstanceOf(Date);
    expect(Object.keys(archive?.[0].data ?? {})).toEqual(['deletedAt']);
  });

  it('records SUPPLIER_MERGED on every moved purchase, attributed to the human who merged', async () => {
    const prisma = makePrisma();
    given(
      prisma,
      [supplierRow(KEPT), supplierRow(DUP, { taxId: '30-1' })],
      ['clpo00000000000000000001', 'clpo00000000000000000002'],
    );
    await service(prisma).merge(KEPT, DUP, admin);
    const { data } = (
      prisma.purchaseOrderEvent.createMany.mock.calls as [{ data: Row[] }][]
    )[0][0];
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      purchaseOrderId: 'clpo00000000000000000001',
      eventType: 'SUPPLIER_MERGED',
      payload: {
        from: { id: DUP, name: 'COMPUMUNDO SA' },
        to: { id: KEPT, name: 'Compumundo' },
        filledFields: ['taxId'],
      },
      performedById: USER_ID,
    });
    expect(data[1].purchaseOrderId).toBe('clpo00000000000000000002');
  });

  it('attributes a service-account merge to the service account, never to a human (INV-SA-4)', async () => {
    const prisma = makePrisma();
    given(
      prisma,
      [supplierRow(KEPT), supplierRow(DUP)],
      ['clpo00000000000000000001'],
    );
    await service(prisma).merge(KEPT, DUP, serviceAccount);
    const [row] = (
      prisma.purchaseOrderEvent.createMany.mock.calls as [{ data: Row[] }][]
    )[0][0].data;
    expect(row.serviceAccountId).toBe(SA_ID);
    expect(row).not.toHaveProperty('performedById');
  });

  it('a duplicate with no purchases is still archived, with no event rows to write', async () => {
    const prisma = makePrisma();
    given(prisma, [supplierRow(KEPT), supplierRow(DUP)], []);
    const result = await service(prisma).merge(KEPT, DUP, admin);
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderEvent.createMany).not.toHaveBeenCalled();
    expect(result.movedPurchases).toBe(0);
    expect(prisma.supplier.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DUP } }),
    );
  });

  it('locks both suppliers in id order, then the purchases in id order, before any write', async () => {
    const prisma = makePrisma();
    given(
      prisma,
      [supplierRow(KEPT), supplierRow(DUP)],
      ['clpo00000000000000000001'],
    );
    await service(prisma).merge(KEPT, DUP, admin);

    const suppliers = rawQuery(prisma, 0);
    expect(suppliers.sql).toContain('FROM "suppliers"');
    expect(suppliers.sql).toContain('ORDER BY "id" FOR NO KEY UPDATE');
    expect(suppliers.values).toEqual([KEPT, DUP]);
    const purchases = rawQuery(prisma, 1);
    expect(purchases.sql).toContain('ORDER BY "id" FOR NO KEY UPDATE');

    const [supplierLock, purchaseLock] =
      prisma.$queryRaw.mock.invocationCallOrder;
    expect(supplierLock).toBeLessThan(purchaseLock);
    const firstWrite = Math.min(
      ...prisma.purchaseOrder.updateMany.mock.invocationCallOrder,
      ...prisma.supplier.update.mock.invocationCallOrder,
      ...prisma.purchaseOrderEvent.createMany.mock.invocationCallOrder,
    );
    expect(purchaseLock).toBeLessThan(firstWrite);
  });

  it('refuses merging a supplier into itself (400) before touching the database', async () => {
    const prisma = makePrisma();
    await expect(
      service(prisma).merge(KEPT, KEPT, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['the duplicate', [supplierRow(KEPT)]],
    ['the supplier that stays', [supplierRow(DUP)]],
  ])('404 when %s does not exist, with nothing written', async (_, rows) => {
    const prisma = makePrisma();
    given(prisma, rows);
    await expect(
      service(prisma).merge(KEPT, DUP, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.supplier.update).not.toHaveBeenCalled();
  });

  it('409 when the supplier that stays is archived', async () => {
    const prisma = makePrisma();
    given(prisma, [
      supplierRow(KEPT, { deletedAt: new Date() }),
      supplierRow(DUP),
    ]);
    await expect(
      service(prisma).merge(KEPT, DUP, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.supplier.update).not.toHaveBeenCalled();
  });

  it('a second merge of the same duplicate waits on the lock, then sees it archived and is refused (409)', async () => {
    const prisma = makePrisma();
    // What the second merge reads under the supplier lock once the first has committed.
    given(prisma, [
      supplierRow(KEPT),
      supplierRow(DUP, { deletedAt: new Date() }),
    ]);
    await expect(
      service(prisma).merge(KEPT, DUP, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    // Refused under the lock: the purchases were never selected, nothing moved, no event.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrderEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('SuppliersService.mergePreview (#1496)', () => {
  const findFirst = jest.fn();
  const count = jest.fn();
  const prisma = {
    supplier: { findFirst },
    purchaseOrder: { count },
  };
  const service = new SuppliersService(
    prisma as unknown as PrismaService,
    new ActorService(),
  );

  beforeEach(() => jest.clearAllMocks());

  it('counts the live and archived purchases that would move and plans the fill, writing nothing', async () => {
    findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === KEPT
          ? supplierRow(KEPT, { taxId: '30-1' })
          : supplierRow(DUP, { taxId: '30-2', website: 'compumundo.example' }),
      ),
    );
    count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    const preview = await service.mergePreview(KEPT, DUP);

    expect(preview.purchases).toEqual({ live: 3, archived: 1 });
    expect(preview.fill).toEqual([
      { field: 'website', value: 'compumundo.example' },
    ]);
    expect(preview.kept).toEqual([
      { field: 'taxId', value: '30-1', sourceValue: '30-2' },
    ]);
    expect(count).toHaveBeenNthCalledWith(1, {
      where: { supplierId: DUP },
    });
    expect(count).toHaveBeenNthCalledWith(2, {
      where: { supplierId: DUP, deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
  });

  it('refuses what the merge refuses: itself (400), missing (404), archived (409)', async () => {
    await expect(service.mergePreview(KEPT, KEPT)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    findFirst.mockResolvedValue(null);
    await expect(service.mergePreview(KEPT, DUP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        supplierRow(
          where.id,
          where.id === DUP ? { deletedAt: new Date() } : {},
        ),
      ),
    );
    await expect(service.mergePreview(KEPT, DUP)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
