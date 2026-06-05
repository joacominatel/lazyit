import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AssetModelsService } from './asset-models.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type PrismaModelMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

/**
 * The normalized pagination window a controller hands `findPage` — the parsed `PageQuery` shape
 * (ADR-0030): `active` slice, first page, default order. Spread + override per test.
 */
const PAGE = { limit: 50, offset: 0, deleted: 'active' as const };

describe('AssetModelsService', () => {
  let service: AssetModelsService;
  let assetModel: PrismaModelMock;

  beforeEach(async () => {
    assetModel = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    // findPage runs findMany + count inside a $transaction; resolve the array of operations.
    const prisma = {
      assetModel,
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [AssetModelsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(AssetModelsService);
  });

  it('creates a model with specs (passes the specs jsonb through)', async () => {
    const dto = {
      name: 'PowerEdge R740',
      manufacturer: 'Dell',
      specs: { ru: 2 },
    };
    assetModel.create.mockResolvedValue({ id: 'm1', ...dto });

    await service.create(dto);

    expect(assetModel.create).toHaveBeenCalledWith({ data: dto });
  });

  it('creates a model without specs (no specs key sent to Prisma)', async () => {
    const dto = { name: 'Catalyst 9300', manufacturer: 'Cisco' };
    assetModel.create.mockResolvedValue({ id: 'm2', ...dto });

    await service.create(dto);

    expect(assetModel.create).toHaveBeenCalledWith({ data: dto });
    const calls = assetModel.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0][0].data).not.toHaveProperty('specs');
  });

  it('returns a model by id when it exists', async () => {
    const found = { id: 'm1', name: 'R740', deletedAt: null };
    assetModel.findFirst.mockResolvedValue(found);

    await expect(service.findOne('m1')).resolves.toEqual(found);
    expect(assetModel.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
  });

  it('throws NotFound when the model does not exist', async () => {
    assetModel.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies a partial update after confirming the model exists', async () => {
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    assetModel.update.mockResolvedValue({ id: 'm1', manufacturer: 'HP' });

    await service.update('m1', { manufacturer: 'HP' });

    expect(assetModel.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { manufacturer: 'HP' },
    });
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1');

    expect(assetModel.update).toHaveBeenCalledTimes(1);
    const calls = assetModel.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'm1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete a model that is missing', async () => {
    assetModel.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetModel.update).not.toHaveBeenCalled();
  });

  it('findPage without filters lists the active slice, newest first, and wraps a Page envelope', async () => {
    assetModel.findMany.mockResolvedValue([{ id: 'm1' }]);
    assetModel.count.mockResolvedValue(1);

    const result = await service.findPage({}, PAGE);

    expect(assetModel.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
    });
    expect(assetModel.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(result).toEqual({
      items: [{ id: 'm1' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('findPage filters by categoryId when provided', async () => {
    assetModel.findMany.mockResolvedValue([]);
    assetModel.count.mockResolvedValue(0);

    await service.findPage({ categoryId: 'cat1' }, PAGE);

    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { categoryId: 'cat1', deletedAt: null },
      }),
    );
  });

  it('findPage applies a case-insensitive OR search over name/manufacturer/sku', async () => {
    assetModel.findMany.mockResolvedValue([]);
    assetModel.count.mockResolvedValue(0);

    await service.findPage({ q: 'dell' }, PAGE);

    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { name: { contains: 'dell', mode: 'insensitive' } },
            { manufacturer: { contains: 'dell', mode: 'insensitive' } },
            { sku: { contains: 'dell', mode: 'insensitive' } },
          ],
          deletedAt: null,
        },
      }),
    );
  });

  it('findPage honors an allowlisted sort field', async () => {
    assetModel.findMany.mockResolvedValue([]);
    assetModel.count.mockResolvedValue(0);

    await service.findPage({}, { ...PAGE, sort: 'name', dir: 'asc' });

    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });

  it('findPage rejects an unknown sort field with a 400', async () => {
    await expect(
      service.findPage({}, { ...PAGE, sort: 'secret', dir: 'asc' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(assetModel.findMany).not.toHaveBeenCalled();
  });

  it('findPage(only) scopes to soft-deleted rows with the escape hatch', async () => {
    assetModel.findMany.mockResolvedValue([]);
    assetModel.count.mockResolvedValue(0);

    await service.findPage({}, { ...PAGE, deleted: 'only' });

    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: { not: null } },
        includeSoftDeleted: true,
      }),
    );
    expect(assetModel.count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
  });
});
