import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type PrismaAssetMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

describe('AssetsService', () => {
  let service: AssetsService;
  let asset: PrismaAssetMock;

  beforeEach(async () => {
    asset = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetsService,
        { provide: PrismaService, useValue: { asset } },
      ],
    }).compile();

    service = moduleRef.get(AssetsService);
  });

  it('creates an asset with specs and a purchase date (passed through)', async () => {
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      specs: { ram: '128GB' },
      purchaseDate: '2026-01-15T00:00:00.000Z',
    };
    asset.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(asset.create).toHaveBeenCalledWith({ data: dto });
  });

  it('creates an asset without specs (no specs key sent to Prisma)', async () => {
    const dto = { name: 'SW-01', status: 'IN_STORAGE' as const };
    asset.create.mockResolvedValue({ id: 'a2', ...dto });

    await service.create(dto);

    const calls = asset.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0][0].data).not.toHaveProperty('specs');
    expect(calls[0][0].data).toEqual(dto);
  });

  it('returns an asset by id when it exists', async () => {
    const found = { id: 'a1', name: 'SRV-01', deletedAt: null };
    asset.findFirst.mockResolvedValue(found);

    await expect(service.findOne('a1')).resolves.toEqual(found);
    expect(asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1', deletedAt: null },
    });
  });

  it('throws NotFound when the asset does not exist', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies a partial update after confirming the asset exists', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1', deletedAt: null });
    asset.update.mockResolvedValue({ id: 'a1', status: 'RETIRED' });

    await service.update('a1', { status: 'RETIRED' });

    expect(asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED' },
    });
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1', deletedAt: null });
    asset.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1');

    expect(asset.update).toHaveBeenCalledTimes(1);
    const calls = asset.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'a1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete an asset that is missing', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(asset.update).not.toHaveBeenCalled();
  });

  it('findAll without filters excludes soft-deleted, newest first', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(asset.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findAll filters by status and locationId', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll({ status: 'RETIRED', locationId: 'l1' });

    expect(asset.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, locationId: 'l1', status: 'RETIRED' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findAll filters by categoryId through the related model', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll({ categoryId: 'c1' });

    expect(asset.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, model: { categoryId: 'c1' } },
      orderBy: { createdAt: 'desc' },
    });
  });
});
