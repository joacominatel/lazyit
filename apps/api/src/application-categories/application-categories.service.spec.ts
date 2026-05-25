import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ApplicationCategoriesService } from './application-categories.service';
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

describe('ApplicationCategoriesService', () => {
  let service: ApplicationCategoriesService;
  let applicationCategory: CategoryMock;

  beforeEach(async () => {
    applicationCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApplicationCategoriesService,
        { provide: PrismaService, useValue: { applicationCategory } },
      ],
    }).compile();

    service = moduleRef.get(ApplicationCategoriesService);
  });

  it('creates a category', async () => {
    const dto = { name: 'SaaS', icon: 'CloudIcon' };
    const created = { id: 'c1', ...dto, description: null, order: null };
    applicationCategory.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(applicationCategory.create).toHaveBeenCalledWith({ data: dto });
  });

  it('findAll excludes soft-deleted, ordered by order (nulls last) then name', async () => {
    applicationCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(applicationCategory.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'SaaS', deletedAt: null };
    applicationCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(applicationCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1', deletedAt: null },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    applicationCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes a category (no 409 guard — the FK is SetNull)', async () => {
    applicationCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    applicationCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    const calls = applicationCategory.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete a missing category', async () => {
    applicationCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(applicationCategory.update).not.toHaveBeenCalled();
  });

  it('applies a partial update after confirming the category exists', async () => {
    applicationCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    applicationCategory.update.mockResolvedValue({ id: 'c1', name: 'Cloud' });

    await service.update('c1', { name: 'Cloud' });

    expect(applicationCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Cloud' },
    });
  });
});
