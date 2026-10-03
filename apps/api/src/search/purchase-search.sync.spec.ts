// SearchService (the DI type) imports the ESM `meilisearch` package and PrismaService the generated client;
// both are replaced by doubles below, so stub the modules jest cannot load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

import type { PrismaService } from '../prisma/prisma.service';
import { PurchaseSearchSync } from './purchase-search.sync';
import type { SearchService } from './search.service';

const PURCHASE = {
  id: 'po1',
  reference: 'OC-4512',
  status: 'ORDERED',
  orderDate: null,
  invoiceNumbers: 'A-0001',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  supplier: { name: 'Compumundo' },
  lines: [{ description: 'ThinkPad T14' }],
};
const SUPPLIER = {
  id: 's1',
  name: 'Compumundo',
  taxId: '30-1',
  salesContactName: 'Ana',
  supportContactName: null,
  salesContactEmail: 'ana@example.com',
};

function setup(enabled = true) {
  const search = {
    enabled,
    upsert: jest.fn(),
    upsertMany: jest.fn(),
    remove: jest.fn(),
  };
  const prisma = {
    purchaseOrder: { findFirst: jest.fn(), findMany: jest.fn() },
    supplier: { findFirst: jest.fn() },
  };
  const sync = new PurchaseSearchSync(
    prisma as unknown as PrismaService,
    search as unknown as SearchService,
  );
  return { sync, search, prisma };
}

/** Let the fire-and-forget pass settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('PurchaseSearchSync (#1499)', () => {
  it('upserts a live purchase, re-read from the database with its supplier name and live lines', async () => {
    const { sync, search, prisma } = setup();
    prisma.purchaseOrder.findFirst.mockResolvedValue(PURCHASE);

    await sync.syncPurchase('po1');

    const [args] = prisma.purchaseOrder.findFirst.mock.calls[0] as [
      { where: unknown; select: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ id: 'po1', deletedAt: null });
    expect(args.select.supplier).toEqual({ select: { name: true } });
    expect(args.select.lines).toEqual({
      where: { deletedAt: null },
      select: { description: true },
    });
    expect(search.upsert).toHaveBeenCalledWith('purchases', {
      id: 'po1',
      reference: 'OC-4512',
      supplierName: 'Compumundo',
      invoiceNumbers: 'A-0001',
      status: 'ORDERED',
      orderDate: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      lineDescriptions: ['ThinkPad T14'],
    });
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('removes an archived (or missing) purchase from the index', async () => {
    const { sync, search, prisma } = setup();
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);

    await sync.syncPurchase('po1');

    expect(search.remove).toHaveBeenCalledWith('purchases', 'po1');
    expect(search.upsert).not.toHaveBeenCalled();
  });

  it('upserts a live supplier — without contact emails — and re-projects its purchases for a rename', async () => {
    const { sync, search, prisma } = setup();
    prisma.supplier.findFirst.mockResolvedValue(SUPPLIER);
    prisma.purchaseOrder.findMany.mockResolvedValue([PURCHASE]);

    await sync.syncSupplier('s1');

    expect(search.upsert).toHaveBeenCalledWith('suppliers', {
      id: 's1',
      name: 'Compumundo',
      taxId: '30-1',
      salesContactName: 'Ana',
      supportContactName: null,
    });
    expect(prisma.purchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { supplierId: 's1', deletedAt: null } }),
    );
    expect(search.upsertMany).toHaveBeenCalledWith('purchases', [
      expect.objectContaining({ id: 'po1', supplierName: 'Compumundo' }),
    ]);
  });

  it('removes an archived supplier but keeps its purchases indexed under its name', async () => {
    const { sync, search, prisma } = setup();
    prisma.supplier.findFirst.mockResolvedValue(null);
    prisma.purchaseOrder.findMany.mockResolvedValue([PURCHASE]);

    await sync.syncSupplier('s1');

    expect(search.remove).toHaveBeenCalledWith('suppliers', 's1');
    expect(search.upsertMany).toHaveBeenCalledWith('purchases', [
      expect.objectContaining({ id: 'po1' }),
    ]);
  });

  it('skips the purchases fan-out when the write cannot change a purchase document', async () => {
    const { sync, search, prisma } = setup();
    prisma.supplier.findFirst.mockResolvedValue(SUPPLIER);

    await sync.syncSupplier('s1', { purchases: false });

    expect(search.upsert).toHaveBeenCalledWith(
      'suppliers',
      expect.objectContaining({ id: 's1' }),
    );
    expect(prisma.purchaseOrder.findMany).not.toHaveBeenCalled();
    expect(search.upsertMany).not.toHaveBeenCalled();
  });

  it('the fire-and-forget entry points never throw on a failed read', async () => {
    const { sync, search, prisma } = setup();
    prisma.purchaseOrder.findFirst.mockRejectedValue(new Error('db down'));
    prisma.supplier.findFirst.mockRejectedValue(new Error('db down'));

    expect(() => sync.purchase('po1')).not.toThrow();
    expect(() => sync.supplier('s1')).not.toThrow();
    await settle();

    expect(search.upsert).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('is a no-op — no database read — when search is disabled', async () => {
    const { sync, prisma } = setup(false);

    sync.purchase('po1');
    sync.supplier('s1');
    await settle();

    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.supplier.findFirst).not.toHaveBeenCalled();
  });
});
