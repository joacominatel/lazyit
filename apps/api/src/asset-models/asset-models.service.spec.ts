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
  create: jest.Mock;
  update: jest.Mock;
};

describe('AssetModelsService', () => {
  let service: AssetModelsService;
  let assetModel: PrismaModelMock;

  beforeEach(async () => {
    assetModel = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetModelsService,
        { provide: PrismaService, useValue: { assetModel } },
      ],
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
      where: { id: 'm1', deletedAt: null },
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

  it('findAll without filter excludes soft-deleted, newest first', async () => {
    assetModel.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(assetModel.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findAll filters by categoryId when provided', async () => {
    assetModel.findMany.mockResolvedValue([]);

    await service.findAll('cat1');

    expect(assetModel.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, categoryId: 'cat1' },
      orderBy: { createdAt: 'desc' },
    });
  });
});
