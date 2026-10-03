// SearchService (behind the optional PurchaseSearchSync) imports the ESM `meilisearch` package jest cannot load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { PurchaseSearchSync } from '../search/purchase-search.sync';
import { SuppliersService } from './suppliers.service';

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
  const service = new SuppliersService(prisma as unknown as PrismaService);

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

  describe('global search sync (#1499)', () => {
    const searchSync = { supplier: jest.fn() };
    const synced = new SuppliersService(
      prisma as unknown as PrismaService,
      searchSync as unknown as PurchaseSearchSync,
    );

    it('re-indexes the supplier after create, update, archive and restore', async () => {
      supplier.create.mockResolvedValue({ id: ID, name: 'Compumundo' });
      supplier.findFirst.mockResolvedValue({
        id: ID,
        name: 'Compumundo',
        deletedAt: null,
      });
      supplier.update.mockResolvedValue({ id: ID, name: 'Compumundo SA' });

      await synced.create({ name: 'Compumundo' });
      await synced.update(ID, { name: 'Compumundo SA' });
      await synced.remove(ID);
      supplier.findFirst.mockResolvedValue({
        id: ID,
        name: 'Compumundo SA',
        deletedAt: new Date(),
      });
      await synced.restore(ID);

      expect(searchSync.supplier.mock.calls).toEqual([[ID], [ID], [ID], [ID]]);
    });

    it('never touches the index when the supplier does not exist (404)', async () => {
      supplier.findFirst.mockResolvedValue(null);
      await expect(synced.update(ID, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(searchSync.supplier).not.toHaveBeenCalled();
    });
  });
});
