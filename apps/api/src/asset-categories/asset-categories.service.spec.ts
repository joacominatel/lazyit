import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetCategoriesService } from './asset-categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { join: (values: unknown[]) => values },
}));

type UpdateCall = [{ where: { id: string }; data: { deletedAt: Date } }];

type PrismaCategoryMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

describe('AssetCategoriesService', () => {
  let service: AssetCategoriesService;
  let assetCategory: PrismaCategoryMock;
  let assetModel: {
    count: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  let asset: { count: jest.Mock; findMany: jest.Mock };
  // Live category ids: the row lock only returns these.
  let liveCategories: Set<string>;
  let readable: Set<string>;
  let inTransaction: boolean;
  let writesOutsideTx: number;

  beforeEach(async () => {
    assetCategory = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    liveCategories = new Set(['c1', 'c2']);
    readable = new Set(['assetModel:read', 'asset:read']);
    inTransaction = false;
    writesOutsideTx = 0;
    assetModel = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(() => {
        if (!inTransaction) writesOutsideTx++;
        return Promise.resolve({ count: 0 });
      }),
    };
    asset = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const prisma: Record<string, unknown> = {
      assetCategory,
      assetModel,
      asset,
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
        AssetCategoriesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PermissionResolverService,
          useValue: {
            principalHas: jest.fn((_p: unknown, perm: string) =>
              Promise.resolve(readable.has(perm)),
            ),
          },
        },
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

  // ADR-0007 amendment (#851): the advisory specs dictionary is a jsonb passthrough. The service
  // forwards a provided `specsSchema` to Prisma (validated upstream by the zod DTO) and omits the
  // key entirely when absent, so an unset category stores NULL (no governance) — the create path is
  // unchanged for callers that don't use it (asserted by the two "no findFirst / { data: dto }" tests
  // above, which pass a specsSchema-free dto).
  it('forwards a provided specsSchema dictionary on create', async () => {
    const specsSchema = [
      { key: 'cpu', label: 'CPU', type: 'string' as const, required: true },
    ];
    const dto = { name: 'Server', specsSchema };
    assetCategory.create.mockResolvedValue({ id: 'c1', ...dto });

    await service.create(dto);

    expect(assetCategory.create).toHaveBeenCalledWith({
      data: { name: 'Server', specsSchema },
    });
  });

  it('forwards a specsSchema replacement (incl. [] to clear) on update', async () => {
    assetCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    assetCategory.update.mockResolvedValue({ id: 'c1', specsSchema: [] });

    await service.update('c1', { specsSchema: [] });

    expect(assetCategory.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { specsSchema: [] },
    });
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

  // --- delete with one resolution (SEC-041) --------------------------------

  const softDeleted = () =>
    (assetCategory.update.mock.calls as UpdateCall[]).some(
      ([args]) => args.data.deletedAt instanceof Date,
    );

  it('soft-deletes an unused category without a strategy (never a hard delete)', async () => {
    assetCategory.update.mockResolvedValue({ id: 'c1', deletedAt: new Date() });

    await service.remove('c1');

    const calls = assetCategory.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'c1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(assetModel.updateMany).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing or archived category', async () => {
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetCategory.update).not.toHaveBeenCalled();
  });

  it('refuses (409) while live models are filed under it and no strategy is given, with the model and asset counts', async () => {
    assetModel.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    asset.count.mockResolvedValue(7);

    const err = await service.remove('c1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DELETE_RESOLUTION_REQUIRED',
      dependents: { assetModels: 2, assets: 7 },
    });
    expect(assetModel.findMany).toHaveBeenCalledWith({
      where: { categoryId: 'c1', deletedAt: null },
      select: { id: true },
    });
    expect(asset.count).toHaveBeenCalledWith({
      where: { deletedAt: null, model: { categoryId: 'c1', deletedAt: null } },
    });
    expect(softDeleted()).toBe(false);
  });

  it('detach clears the category of every live model, in the delete transaction', async () => {
    assetModel.findMany.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    assetCategory.update.mockResolvedValue({ id: 'c1', deletedAt: new Date() });

    await service.remove('c1', { strategy: 'detach' });

    expect(assetModel.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] }, categoryId: 'c1' },
      data: { categoryId: null },
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toBe(0);
  });

  it('move re-points every live model to the target category', async () => {
    assetModel.findMany.mockResolvedValue([{ id: 'm1' }]);
    assetCategory.update.mockResolvedValue({ id: 'c1', deletedAt: new Date() });

    await service.remove('c1', { strategy: 'move', targetId: 'c2' });

    expect(assetModel.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1'] }, categoryId: 'c1' },
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
      assetModel.findMany.mockResolvedValue([{ id: 'm1' }]);

      await expect(
        service.remove('c1', { strategy: 'move', targetId }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(assetModel.updateMany).not.toHaveBeenCalled();
      expect(softDeleted()).toBe(false);
    },
  );

  it('a failed soft delete after the move rejects the whole call (both writes share the transaction)', async () => {
    assetModel.findMany.mockResolvedValue([{ id: 'm1' }]);
    assetCategory.update.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.remove('c1', { strategy: 'move', targetId: 'c2' }),
    ).rejects.toThrow('connection lost');
    expect(writesOutsideTx).toBe(0);
  });

  it('the delete-impact preview counts live models and their live assets, listing each only for a reader', async () => {
    assetCategory.findFirst.mockResolvedValue({ id: 'c1', deletedAt: null });
    assetModel.count.mockResolvedValue(2);
    assetModel.findMany.mockResolvedValue([
      { id: 'm1', name: 'Latitude', manufacturer: 'Dell' },
    ]);
    asset.count.mockResolvedValue(5);
    asset.findMany.mockResolvedValue([
      { id: 'a1', name: 'LT-1', assetTag: 'IT-1' },
    ]);

    await expect(service.deleteImpact('c1')).resolves.toEqual({
      assetModels: {
        total: 2,
        items: [{ id: 'm1', name: 'Latitude', manufacturer: 'Dell' }],
      },
      assets: {
        total: 5,
        items: [{ id: 'a1', name: 'LT-1', assetTag: 'IT-1' }],
      },
    });
    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { categoryId: 'c1', deletedAt: null },
        take: 50,
      }),
    );

    readable = new Set(['asset:read']);
    await expect(service.deleteImpact('c1')).resolves.toEqual({
      assetModels: { total: 2, items: null },
      assets: {
        total: 5,
        items: [{ id: 'a1', name: 'LT-1', assetTag: 'IT-1' }],
      },
    });
    readable = new Set();
    await expect(service.deleteImpact('c1')).resolves.toEqual({
      assetModels: { total: 2, items: null },
      assets: { total: 5, items: null },
    });
  });

  it('the delete-impact preview 404s for an archived category', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(service.deleteImpact('old')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findAll excludes soft-deleted, ordered by name', async () => {
    assetCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(assetCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } }),
    );
  });

  // --- usageCount (#1540) --------------------------------------------------
  it('findAll counts live assets only through LIVE models (both deletedAt filters explicit)', async () => {
    assetCategory.findMany.mockResolvedValue([]);

    await service.findAll();

    // Nested relation reads are not rewritten by the ADR-0032 read filter, so the query itself must
    // exclude soft-deleted models AND soft-deleted assets.
    expect(assetCategory.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
      include: {
        models: {
          where: { deletedAt: null },
          select: {
            _count: { select: { assets: { where: { deletedAt: null } } } },
          },
        },
      },
    });
  });

  it("findAll sums the live-asset counts of a category's live models into usageCount", async () => {
    assetCategory.findMany.mockResolvedValue([
      {
        id: 'c1',
        name: 'Laptop',
        deletedAt: null,
        models: [{ _count: { assets: 3 } }, { _count: { assets: 2 } }],
      },
      { id: 'c2', name: 'Server', deletedAt: null, models: [] },
      {
        id: 'c3',
        name: 'Switch',
        deletedAt: null,
        models: [{ _count: { assets: 0 } }],
      },
    ]);

    const rows = await service.findAll();

    expect(rows).toEqual([
      { id: 'c1', name: 'Laptop', deletedAt: null, usageCount: 5 },
      { id: 'c2', name: 'Server', deletedAt: null, usageCount: 0 },
      { id: 'c3', name: 'Switch', deletedAt: null, usageCount: 0 },
    ]);
    // The relation projection never leaks into the response.
    expect(rows[0]).not.toHaveProperty('models');
  });

  it('findOne is unchanged: no relation include, no usageCount', async () => {
    const found = { id: 'c1', name: 'Laptop', deletedAt: null };
    assetCategory.findFirst.mockResolvedValue(found);

    const row = await service.findOne('c1');

    expect(assetCategory.findFirst).toHaveBeenCalledWith({
      where: { id: 'c1' },
    });
    expect(row).not.toHaveProperty('usageCount');
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
