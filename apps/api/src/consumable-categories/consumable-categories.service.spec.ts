import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConsumableCategoriesService } from './consumable-categories.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type CategoryMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

type UpdateCall = [{ where: { id: string }; data: { deletedAt: Date } }];

describe('ConsumableCategoriesService', () => {
  let service: ConsumableCategoriesService;
  let consumableCategory: CategoryMock;

  beforeEach(async () => {
    consumableCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsumableCategoriesService,
        { provide: PrismaService, useValue: { consumableCategory } },
      ],
    }).compile();

    service = moduleRef.get(ConsumableCategoriesService);
  });

  it('creates a category', async () => {
    const dto = { name: 'Cables', icon: 'CpuChipIcon' };
    const created = { id: 'c1', ...dto, description: null, order: null };
    consumableCategory.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(consumableCategory.create).toHaveBeenCalledWith({ data: dto });
  });

  it('findAll excludes soft-deleted, ordered by order (nulls last) then name', async () => {
    consumableCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(consumableCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'Cables', deletedAt: null };
    consumableCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(consumableCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    consumableCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes a category (no 409 guard — the FK is SetNull)', async () => {
    consumableCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    consumableCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    const calls = consumableCategory.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete a missing category', async () => {
    consumableCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consumableCategory.update).not.toHaveBeenCalled();
  });

  it('applies a partial update after confirming the category exists', async () => {
    consumableCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    consumableCategory.update.mockResolvedValue({ id: 'c1', name: 'Adapters' });

    await service.update('c1', { name: 'Adapters' });

    expect(consumableCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Adapters' },
    });
  });
});
