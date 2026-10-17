import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationCategoriesService } from './application-categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { join: (values: unknown[]) => values },
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
  let application: {
    count: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  // Live category ids: the row lock only returns these.
  let liveCategories: Set<string>;
  let canRead: boolean;
  let inTransaction: boolean;
  let writesOutsideTx: number;

  beforeEach(async () => {
    applicationCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    liveCategories = new Set(['c1', 'c2']);
    canRead = true;
    inTransaction = false;
    writesOutsideTx = 0;
    application = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(() => {
        if (!inTransaction) writesOutsideTx++;
        return Promise.resolve({ count: 0 });
      }),
    };
    const prisma: Record<string, unknown> = {
      applicationCategory,
      application,
      $queryRaw: jest.fn((_sql: TemplateStringsArray, ids: string[]) =>
        Promise.resolve(
          ids.filter((id) => liveCategories.has(id)).map((id) => ({ id })),
        ),
      ),
    };
    prisma.$transaction = jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await fn(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApplicationCategoriesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PermissionResolverService,
          useValue: {
            principalHas: jest.fn((_p: unknown, perm: string) =>
              Promise.resolve(canRead && perm === 'application:read'),
            ),
          },
        },
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

    expect(applicationCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      }),
    );
  });

  // --- usageCount (#1540) --------------------------------------------------
  it('findAll counts only live applications (the relation count carries deletedAt: null)', async () => {
    applicationCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(applicationCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: {
        _count: { select: { applications: { where: { deletedAt: null } } } },
      },
    });
  });

  it('findAll maps the relation count to usageCount (zero when unused)', async () => {
    applicationCategory.findMany.mockResolvedValue([
      { id: 'c1', name: 'SaaS', deletedAt: null, _count: { applications: 4 } },
      { id: 'c2', name: 'Other', deletedAt: null, _count: { applications: 0 } },
    ]);

    const rows = await service.findAll();

    expect(rows).toEqual([
      { id: 'c1', name: 'SaaS', deletedAt: null, usageCount: 4 },
      { id: 'c2', name: 'Other', deletedAt: null, usageCount: 0 },
    ]);
    expect(rows[0]).not.toHaveProperty('_count');
  });

  it('findOne is unchanged: no relation count, no usageCount', async () => {
    const found = { id: 'c1', name: 'SaaS', deletedAt: null };
    applicationCategory.findFirst.mockResolvedValue(found);

    const row = await service.findOne('c1');

    expect(applicationCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
    expect(row).not.toHaveProperty('usageCount');
  });

  it('returns a category by id when it exists', async () => {
    const found = { id: 'c1', name: 'SaaS', deletedAt: null };
    applicationCategory.findFirst.mockResolvedValue(found);

    await expect(service.findOne('c1')).resolves.toEqual(found);
    expect(applicationCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
  });

  it('throws NotFound when the category does not exist', async () => {
    applicationCategory.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- delete with one resolution (AUD-085) --------------------------------

  const softDeleted = () =>
    (applicationCategory.update.mock.calls as UpdateCall[]).some(
      ([args]) => args.data.deletedAt instanceof Date,
    );

  it('soft-deletes an unused category without a strategy', async () => {
    applicationCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    const calls = applicationCategory.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(application.updateMany).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing or archived category', async () => {
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(applicationCategory.update).not.toHaveBeenCalled();
  });

  it('refuses (409) while live applications are filed under it and no strategy is given', async () => {
    application.findMany.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);

    const err = await service.remove('c1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DELETE_RESOLUTION_REQUIRED',
      dependents: { applications: 2 },
    });
    expect(application.findMany).toHaveBeenCalledWith({
      where: { categoryId: 'c1', deletedAt: null },
      select: { id: true },
    });
    expect(softDeleted()).toBe(false);
  });

  it('detach clears the category of every live application, in the delete transaction', async () => {
    application.findMany.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);
    applicationCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1', { strategy: 'detach' });

    expect(application.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['i1', 'i2'] }, categoryId: 'c1' },
      data: { categoryId: null },
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toBe(0);
  });

  it('move re-points every live application to the target category', async () => {
    application.findMany.mockResolvedValue([{ id: 'i1' }]);
    applicationCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1', { strategy: 'move', targetId: 'c2' });

    expect(application.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['i1'] }, categoryId: 'c1' },
      data: { categoryId: 'c2' },
    });
    expect(softDeleted()).toBe(true);
  });

  it.each([
    ['itself', 'c1'],
    ['an archived or missing category', 'c9'],
  ])(
    'refuses (400) to move to %s, and writes nothing',
    async (_what, targetId) => {
      application.findMany.mockResolvedValue([{ id: 'i1' }]);

      await expect(
        service.remove('c1', { strategy: 'move', targetId }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(application.updateMany).not.toHaveBeenCalled();
      expect(softDeleted()).toBe(false);
    },
  );

  it('a failed soft delete after the move rejects the whole call (both writes share the transaction)', async () => {
    application.findMany.mockResolvedValue([{ id: 'i1' }]);
    applicationCategory.update.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.remove('c1', { strategy: 'move', targetId: 'c2' }),
    ).rejects.toThrow('connection lost');
    expect(writesOutsideTx).toBe(0);
  });

  it('the delete-impact preview counts live applications and lists them only for a reader', async () => {
    applicationCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    application.count.mockResolvedValue(3);
    application.findMany.mockResolvedValue([{ id: 'i1', name: 'One' }]);

    const impact = await service.deleteImpact('c1');
    expect(impact).toEqual({
      applications: { total: 3, items: [{ id: 'i1', name: 'One' }] },
    });
    expect(application.count).toHaveBeenCalledWith({
      where: { categoryId: 'c1', deletedAt: null },
    });

    canRead = false;
    await expect(service.deleteImpact('c1')).resolves.toEqual({
      applications: { total: 3, items: null },
    });
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
