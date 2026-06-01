import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AssetCategoriesService } from './asset-categories.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). `Prisma` is used
// only for a type cast (erased at runtime), so an empty object suffices.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type PrismaCategoryMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

describe('AssetCategoriesService', () => {
  let service: AssetCategoriesService;
  let assetCategory: PrismaCategoryMock;

  beforeEach(async () => {
    assetCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetCategoriesService,
        { provide: PrismaService, useValue: { assetCategory } },
      ],
    }).compile();

    service = moduleRef.get(AssetCategoriesService);
  });

  it('creates a category', async () => {
    const dto = { name: 'Server', icon: 'ServerStackIcon' };
    const created = { id: 'c1', ...dto, description: null, deletedAt: null };
    assetCategory.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(assetCategory.create).toHaveBeenCalledWith({ data: dto });
  });

  // ADR-0041 reuse contract: create carries NO uniqueness pre-check — it delegates straight to
  // `prisma.create`. Uniqueness is enforced solely by the PARTIAL unique index `WHERE deletedAt IS
  // NULL`, so once a name's owner is soft-deleted the index frees it and a recreate goes through with
  // no read/guard in the way (the index property itself is exercised at the DB level). This asserts
  // there is no findFirst look-ahead that would reject a name still held by a soft-deleted ghost row.
  it('create delegates uniqueness to the DB (no soft-delete-aware pre-check) — ADR-0041 reuse', async () => {
    const dto = { name: 'Server' };
    assetCategory.create.mockResolvedValue({ id: 'c2', ...dto });

    await service.create(dto);

    expect(assetCategory.findFirst).not.toHaveBeenCalled();
    expect(assetCategory.create).toHaveBeenCalledTimes(1);
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'Server', deletedAt: null };
    assetCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(assetCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies a partial update after confirming the category exists', async () => {
    assetCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    assetCategory.update.mockResolvedValue({ id: 'c1', name: 'Servers' });

    await service.update('c1', { name: 'Servers' });

    expect(assetCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Servers' },
    });
  });

  it('does not update a category that is missing', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assetCategory.update).not.toHaveBeenCalled();
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    assetCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    assetCategory.update.mockResolvedValue({ id: 'c1', deletedAt: new Date() });

    await service.remove('c1');

    expect(assetCategory.update).toHaveBeenCalledTimes(1);
    const calls = assetCategory.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete a category that is missing', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetCategory.update).not.toHaveBeenCalled();
  });

  it('findAll excludes soft-deleted, ordered by name', async () => {
    assetCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(assetCategory.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
    });
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt, finding the row via the includeSoftDeleted escape hatch', async () => {
    assetCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });
    assetCategory.update.mockResolvedValue({ id: 'c1', deletedAt: null });

    await service.restore('c1');

    // The lookup must bypass the soft-delete read filter to see the deleted row.
    expect(assetCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
      includeSoftDeleted: true,
    });
    const calls = assetCategory.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date | null } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeNull();
  });

  it('restore is idempotent on an already-live category (no update)', async () => {
    const live = { id: 'c1', deletedAt: null };
    assetCategory.findFirst.mockResolvedValue(live);

    await expect(service.restore('c1')).resolves.toEqual(live);
    expect(assetCategory.update).not.toHaveBeenCalled();
  });

  it('restore 404s when the category never existed', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetCategory.update).not.toHaveBeenCalled();
  });
});
