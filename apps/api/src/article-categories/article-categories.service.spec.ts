import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ArticleCategoriesService } from './article-categories.service';
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

describe('ArticleCategoriesService', () => {
  let service: ArticleCategoriesService;
  let articleCategory: CategoryMock;
  let article: { count: jest.Mock };

  beforeEach(async () => {
    articleCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    article = { count: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArticleCategoriesService,
        { provide: PrismaService, useValue: { articleCategory, article } },
      ],
    }).compile();

    service = moduleRef.get(ArticleCategoriesService);
  });

  it('creates a category', async () => {
    const dto = { name: 'Networking', icon: 'GlobeAltIcon' };
    const created = { id: 'c1', ...dto, description: null, order: null };
    articleCategory.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(articleCategory.create).toHaveBeenCalledWith({ data: dto });
  });

  it('findAll excludes soft-deleted, ordered by order (nulls last) then name', async () => {
    articleCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(articleCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
    });
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'Networking', deletedAt: null };
    articleCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(articleCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    articleCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes a category that has no live articles', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    article.count.mockResolvedValue(0);
    articleCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    expect(article.count).toHaveBeenCalledWith({
      where: { categoryId: 'c1' },
    });
    const calls = articleCategory.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('refuses (409) to delete a category that still has live articles', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    article.count.mockResolvedValue(3);

    await expect(service.remove('c1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(articleCategory.update).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing category', async () => {
    articleCategory.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(article.count).not.toHaveBeenCalled();
  });

  it('applies a partial update after confirming the category exists', async () => {
    articleCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    articleCategory.update.mockResolvedValue({ id: 'c1', name: 'Networks' });

    await service.update('c1', { name: 'Networks' });

    expect(articleCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { name: 'Networks' },
    });
  });
});
