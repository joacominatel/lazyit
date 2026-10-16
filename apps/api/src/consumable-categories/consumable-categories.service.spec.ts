import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConsumableCategoriesService } from './consumable-categories.service';
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

describe('ConsumableCategoriesService', () => {
  let service: ConsumableCategoriesService;
  let consumableCategory: CategoryMock;
  let consumable: {
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
    consumableCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    liveCategories = new Set(['c1', 'c2']);
    canRead = true;
    inTransaction = false;
    writesOutsideTx = 0;
    consumable = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(() => {
        if (!inTransaction) writesOutsideTx++;
        return Promise.resolve({ count: 0 });
      }),
    };
    const prisma: Record<string, unknown> = {
      consumableCategory,
      consumable,
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
        ConsumableCategoriesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PermissionResolverService,
          useValue: {
            principalHas: jest.fn((_p: unknown, perm: string) =>
              Promise.resolve(canRead && perm === 'consumable:read'),
            ),
          },
        },
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

    expect(consumableCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      }),
    );
  });

  // --- usageCount (#1540) --------------------------------------------------
  it('findAll counts only live consumables (the relation count carries deletedAt: null)', async () => {
    consumableCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(consumableCategory.findMany).toHaveBeenCalledWith({
      orderBy: [{ order: { sort: 'asc', nulls: 'last' } }, { name: 'asc' }],
      include: {
        _count: { select: { consumables: { where: { deletedAt: null } } } },
      },
    });
  });

  it('findAll maps the relation count to usageCount (zero when unused)', async () => {
    consumableCategory.findMany.mockResolvedValue([
      { id: 'c1', name: 'Cables', deletedAt: null, _count: { consumables: 4 } },
      { id: 'c2', name: 'Other', deletedAt: null, _count: { consumables: 0 } },
    ]);

    const rows = await service.findAll();

    expect(rows).toEqual([
      { id: 'c1', name: 'Cables', deletedAt: null, usageCount: 4 },
      { id: 'c2', name: 'Other', deletedAt: null, usageCount: 0 },
    ]);
    expect(rows[0]).not.toHaveProperty('_count');
  });

  it('findOne is unchanged: no relation count, no usageCount', async () => {
    const found = { id: 'c1', name: 'Cables', deletedAt: null };
    consumableCategory.findFirst.mockResolvedValue(found);

    const row = await service.findOne('c1');

    expect(consumableCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
    expect(row).not.toHaveProperty('usageCount');
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

  // --- delete with one resolution (AUD-085) --------------------------------

  const softDeleted = () =>
    (consumableCategory.update.mock.calls as UpdateCall[]).some(
      ([args]) => args.data.deletedAt instanceof Date,
    );

  it('soft-deletes an unused category without a strategy', async () => {
    consumableCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1');

    const calls = consumableCategory.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(consumable.updateMany).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing or archived category', async () => {
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consumableCategory.update).not.toHaveBeenCalled();
  });

  it('refuses (409) while live consumables are filed under it and no strategy is given', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);

    const err = await service.remove('c1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DELETE_RESOLUTION_REQUIRED',
      dependents: { consumables: 2 },
    });
    expect(consumable.findMany).toHaveBeenCalledWith({
      where: { categoryId: 'c1', deletedAt: null },
      select: { id: true },
    });
    expect(softDeleted()).toBe(false);
  });

  it('detach clears the category of every live consumable, in the delete transaction', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'i1' }, { id: 'i2' }]);
    consumableCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1', { strategy: 'detach' });

    expect(consumable.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['i1', 'i2'] }, categoryId: 'c1' },
      data: { categoryId: null },
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toBe(0);
  });

  it('move re-points every live consumable to the target category', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'i1' }]);
    consumableCategory.update.mockResolvedValue({
      id: 'c1',
      deletedAt: new Date(),
    });

    await service.remove('c1', { strategy: 'move', targetId: 'c2' });

    expect(consumable.updateMany).toHaveBeenCalledWith({
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
      consumable.findMany.mockResolvedValue([{ id: 'i1' }]);

      await expect(
        service.remove('c1', { strategy: 'move', targetId }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(consumable.updateMany).not.toHaveBeenCalled();
      expect(softDeleted()).toBe(false);
    },
  );

  it('a failed soft delete after the move rejects the whole call (both writes share the transaction)', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'i1' }]);
    consumableCategory.update.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.remove('c1', { strategy: 'move', targetId: 'c2' }),
    ).rejects.toThrow('connection lost');
    expect(writesOutsideTx).toBe(0);
  });

  it('the delete-impact preview counts live consumables and lists them only for a reader', async () => {
    consumableCategory.findFirst.mockResolvedValue({
      id: 'c1',
      deletedAt: null,
    });
    consumable.count.mockResolvedValue(3);
    consumable.findMany.mockResolvedValue([{ id: 'i1', name: 'One' }]);

    const impact = await service.deleteImpact('c1');
    expect(impact).toEqual({
      consumables: { total: 3, items: [{ id: 'i1', name: 'One' }] },
    });
    expect(consumable.count).toHaveBeenCalledWith({
      where: { categoryId: 'c1', deletedAt: null },
    });

    canRead = false;
    await expect(service.deleteImpact('c1')).resolves.toEqual({
      consumables: { total: 3, items: null },
    });
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
