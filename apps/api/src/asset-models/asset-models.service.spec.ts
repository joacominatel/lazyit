import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetModelsService } from './asset-models.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => values,
    empty: { strings: [''], values: [] },
  },
}));

const ADMIN = {
  kind: 'human',
  user: { id: 'u-admin', role: 'ADMIN' },
} as unknown as Principal;

type UpdateCall = [{ where: { id: string }; data: { deletedAt: Date } }];
type RawCall = [TemplateStringsArray, ...unknown[]];

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
  let assetCategory: { findFirst: jest.Mock };
  let asset: { count: jest.Mock; findMany: jest.Mock; updateMany: jest.Mock };
  let purchaseOrderLine: { updateMany: jest.Mock };
  let purchaseOrderEvent: { create: jest.Mock };
  let history: { recordMany: jest.Mock };
  let queryRaw: jest.Mock;
  let transaction: jest.Mock;
  // Live model ids: the row lock only returns these.
  let liveModels: Set<string>;
  // What a model write's category `FOR SHARE` lock (#1604) finds live.
  let liveCategories: Set<string>;
  let readable: Set<string>;
  let inTransaction: boolean;
  let writesOutsideTx: number;

  function seedDependents(opts: {
    assets?: string[];
    lines?: { id: string; purchaseOrderId: string }[];
  }) {
    queryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "asset_categories"')) {
          const id = values[0] as string;
          return Promise.resolve(liveCategories.has(id) ? [{ id }] : []);
        }
        if (sql.includes('FROM "asset_models"')) {
          const ids = values[0] as string[];
          return Promise.resolve(
            ids.filter((id) => liveModels.has(id)).map((id) => ({ id })),
          );
        }
        if (sql.includes('FROM "assets"')) {
          return Promise.resolve((opts.assets ?? []).map((id) => ({ id })));
        }
        if (sql.includes('FROM "purchase_order_lines"')) {
          return Promise.resolve(
            (opts.lines ?? []).map((line) => ({
              ...line,
              reference: `PO-${line.purchaseOrderId}`,
              description: 'Laptops',
            })),
          );
        }
        return Promise.resolve([]);
      },
    );
  }

  const write = () =>
    jest.fn(() => {
      if (!inTransaction) writesOutsideTx++;
      return Promise.resolve({ count: 0 });
    });

  beforeEach(async () => {
    assetModel = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    assetCategory = {
      findFirst: jest.fn().mockResolvedValue({ id: 'cat-live' }),
    };
    liveModels = new Set(['m1', 'm2']);
    liveCategories = new Set(['cat-live']);
    readable = new Set(['asset:read', 'purchaseOrder:read']);
    inTransaction = false;
    writesOutsideTx = 0;
    asset = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: write(),
    };
    purchaseOrderLine = { updateMany: write() };
    purchaseOrderEvent = { create: write() };
    history = { recordMany: write() };
    queryRaw = jest.fn();
    seedDependents({});
    const prisma: Record<string, unknown> = {
      assetModel,
      assetCategory,
      asset,
      purchaseOrderLine,
      purchaseOrderEvent,
      $queryRaw: queryRaw,
    };
    // findPage runs findMany + count as an array; a delete runs an interactive transaction.
    transaction = jest.fn(
      async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        inTransaction = true;
        try {
          return await arg(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );
    prisma.$transaction = transaction;

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetModelsService,
        { provide: PrismaService, useValue: prisma },
        ActorService,
        { provide: AssetHistoryService, useValue: history },
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

  // The category ids a model write locked FOR SHARE (#1604), in call order.
  const lockedCategories = () =>
    (queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) => {
        const sql = strings.join('?');
        return (
          sql.includes('FROM "asset_categories"') && sql.includes('FOR SHARE')
        );
      })
      .map(([, id]) => id);

  it('creates a model under a live category (SEC-041)', async () => {
    const dto = {
      name: 'Latitude 5520',
      manufacturer: 'Dell',
      categoryId: 'cat-live',
    };
    assetModel.create.mockResolvedValue({ id: 'm3', ...dto });

    await service.create(dto);

    expect(lockedCategories()).toEqual(['cat-live']);
    expect(assetModel.create).toHaveBeenCalledWith({ data: dto });
  });

  it('refuses (400) to create a model under an archived or missing category (SEC-041)', async () => {
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ name: 'X', manufacturer: 'Y', categoryId: 'cat-old' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetModel.create).not.toHaveBeenCalled();
  });

  it('refuses (400) to move a model under an archived category (SEC-041)', async () => {
    assetModel.findFirst.mockResolvedValue({
      id: 'm1',
      categoryId: 'cat-live',
      deletedAt: null,
    });
    assetCategory.findFirst.mockResolvedValue(null);

    await expect(
      service.update('m1', { categoryId: 'cat-old' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetModel.update).not.toHaveBeenCalled();
  });

  it('still edits a model already filed under an archived category when the category is not changed', async () => {
    assetModel.findFirst.mockResolvedValue({
      id: 'm1',
      categoryId: 'cat-old',
      deletedAt: null,
    });
    assetCategory.findFirst.mockResolvedValue(null);
    assetModel.update.mockResolvedValue({ id: 'm1', name: 'Renamed' });

    await service.update('m1', { name: 'Renamed' });
    await service.update('m1', { categoryId: 'cat-old', name: 'Again' });

    expect(assetCategory.findFirst).not.toHaveBeenCalled();
    expect(assetModel.update).toHaveBeenCalledTimes(2);
  });

  // An asset category delete locks the category FOR UPDATE before it moves the models filed under it; a model
  // write holds it FOR SHARE until it commits (#1604, first comment).
  describe('the category a model write names is locked FOR SHARE (#1604)', () => {
    it('create locks the category, with its liveness in the locking statement, before inserting — in one transaction', async () => {
      assetModel.create.mockResolvedValue({ id: 'm3' });

      await service.create({
        name: 'X',
        manufacturer: 'Y',
        categoryId: 'cat-live',
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(strings.join('?')).toMatch(
        /FROM "asset_categories"[\s\S]*"deletedAt" IS NULL[\s\S]*FOR SHARE/,
      );
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        assetModel.create.mock.invocationCallOrder[0],
      );
      expect(writesOutsideTx).toBe(0);
    });

    it('create under a category a concurrent delete archived while it waited is a 400 — nothing written', async () => {
      liveCategories.delete('cat-live');

      await expect(
        service.create({
          name: 'X',
          manufacturer: 'Y',
          categoryId: 'cat-live',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(assetModel.create).not.toHaveBeenCalled();
    });

    it('a re-categorisation locks the target category before reading or writing the model', async () => {
      liveCategories.add('cat-2');
      assetModel.findFirst.mockResolvedValue({
        id: 'm1',
        categoryId: 'cat-live',
      });
      assetModel.update.mockResolvedValue({ id: 'm1' });

      await service.update('m1', { categoryId: 'cat-2' });

      expect(lockedCategories()).toEqual(['cat-2']);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        assetModel.findFirst.mock.invocationCallOrder[0],
      );
      expect(assetModel.update).toHaveBeenCalledTimes(1);
    });

    it('a re-categorisation into a category archived while it waited is a 400 — nothing written', async () => {
      assetModel.findFirst.mockResolvedValue({
        id: 'm1',
        categoryId: 'cat-live',
      });

      await expect(
        service.update('m1', { categoryId: 'cat-2' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(assetModel.update).not.toHaveBeenCalled();
    });

    it('an update of a model that is gone is a 404', async () => {
      assetModel.findFirst.mockResolvedValue(null);

      await expect(service.update('m9', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(lockedCategories()).toEqual([]);
    });
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

  it('clears the category: categoryId null is written through to Prisma (#1315)', async () => {
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    assetModel.update.mockResolvedValue({ id: 'm1', categoryId: null });

    await service.update('m1', { categoryId: null });

    expect(assetModel.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { categoryId: null },
    });
  });

  it('clears the SKU and the description: null is written through to Prisma (#1441)', async () => {
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    assetModel.update.mockResolvedValue({
      id: 'm1',
      sku: null,
      description: null,
    });

    await service.update('m1', { sku: null, description: null });

    expect(assetModel.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { sku: null, description: null },
    });
  });

  // --- delete with one resolution (SEC-041) --------------------------------

  const softDeleted = () =>
    (assetModel.update.mock.calls as UpdateCall[]).some(
      ([args]) => args.data.deletedAt instanceof Date,
    );

  const rawCalls = (table: string) =>
    (queryRaw.mock.calls as RawCall[]).filter(([strings]) =>
      strings.join('?').includes(`FROM "${table}"`),
    );

  it('soft-deletes an unused model without a strategy (never a hard delete)', async () => {
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1');

    const calls = assetModel.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'm1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(asset.updateMany).not.toHaveBeenCalled();
  });

  it('does not soft-delete a missing or archived model', async () => {
    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetModel.update).not.toHaveBeenCalled();
  });

  it('refuses (409) while live assets or open purchase lines use it and no strategy is given, with the counts', async () => {
    seedDependents({
      assets: ['a1', 'a2'],
      lines: [{ id: 'l1', purchaseOrderId: 'po1' }],
    });

    const err = await service.remove('m1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'DELETE_RESOLUTION_REQUIRED',
      dependents: { assets: 2, purchaseOrderLines: 1 },
    });
    expect(softDeleted()).toBe(false);
    expect(writesOutsideTx).toBe(0);
  });

  it('detach clears the model of every live asset and open line, with a MODEL_CHANGED row each and a LINE_UPDATED event', async () => {
    seedDependents({
      assets: ['a1', 'a2'],
      lines: [{ id: 'l1', purchaseOrderId: 'po1' }],
    });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1', { strategy: 'detach' }, ADMIN);

    expect(asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { modelId: null },
    });
    expect(history.recordMany).toHaveBeenCalledWith(expect.anything(), [
      {
        assetId: 'a1',
        eventType: 'MODEL_CHANGED',
        payload: { from: 'm1', to: null },
        actor: { userId: 'u-admin' },
      },
      {
        assetId: 'a2',
        eventType: 'MODEL_CHANGED',
        payload: { from: 'm1', to: null },
        actor: { userId: 'u-admin' },
      },
    ]);
    expect(purchaseOrderLine.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1'] } },
      data: { assetModelId: null },
    });
    expect(purchaseOrderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseOrderId: 'po1',
        eventType: 'LINE_UPDATED',
        performedById: 'u-admin',
        payload: {
          lineId: 'l1',
          changes: { assetModelId: { from: 'm1', to: null } },
        },
      }) as unknown,
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toBe(0);
  });

  it('move re-points every live asset and open line to the target model, even one in another category', async () => {
    // The target's category is never read: an asset's category follows its new model.
    seedDependents({
      assets: ['a1'],
      lines: [{ id: 'l1', purchaseOrderId: 'po1' }],
    });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1', { strategy: 'move', targetId: 'm2' }, ADMIN);

    expect(asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] } },
      data: { modelId: 'm2' },
    });
    expect(history.recordMany).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        assetId: 'a1',
        eventType: 'MODEL_CHANGED',
        payload: { from: 'm1', to: 'm2' },
      }),
    ]);
    expect(purchaseOrderLine.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1'] } },
      data: { assetModelId: 'm2' },
    });
    expect(assetCategory.findFirst).not.toHaveBeenCalled();
    expect(softDeleted()).toBe(true);
  });

  it.each([
    ['itself', 'm1'],
    ['an archived or missing model', 'm9'],
  ])(
    'refuses (400) to move to %s, and writes nothing',
    async (_what, targetId) => {
      seedDependents({ assets: ['a1'] });

      await expect(
        service.remove('m1', { strategy: 'move', targetId }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(asset.updateMany).not.toHaveBeenCalled();
      expect(history.recordMany).not.toHaveBeenCalled();
      expect(softDeleted()).toBe(false);
    },
  );

  it('locks both models in id order, the assets, and the open lines it re-points', async () => {
    seedDependents({
      assets: ['a1'],
      lines: [{ id: 'l1', purchaseOrderId: 'po1' }],
    });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1', { strategy: 'move', targetId: 'm2' }, ADMIN);
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    await service.deleteImpact('m1', ADMIN);

    const [modelLock] = rawCalls('asset_models');
    expect(modelLock[0].join('?')).toContain('ORDER BY "id" FOR UPDATE');
    expect(modelLock[1]).toEqual(['m1', 'm2']);
    expect(rawCalls('assets')[0][0].join('?')).toContain('FOR UPDATE');
    const lineQueries = (queryRaw.mock.calls as RawCall[]).filter(([strings]) =>
      strings.join('?').includes('FROM "purchase_order_lines" l'),
    );
    const lockOf = (values: unknown[]) =>
      values.some(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          'strings' in v &&
          (v as { strings: string[] }).strings
            .join('')
            .includes('FOR UPDATE OF l'),
      );
    expect(lineQueries).toHaveLength(2);
    // The delete locks them; the read-only preview does not.
    expect(lockOf(lineQueries[0].slice(1))).toBe(true);
    expect(lockOf(lineQueries[1].slice(1))).toBe(false);
    expect(lineQueries[0].slice(1)).toContainEqual(['DRAFT', 'ORDERED']);
  });

  it('locks the purchases of the mapped lines, in id order, after the assets and before the lines', async () => {
    seedDependents({
      assets: ['a1'],
      lines: [{ id: 'l1', purchaseOrderId: 'po1' }],
    });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1', { strategy: 'detach' }, ADMIN);

    const sqls = (queryRaw.mock.calls as RawCall[]).map(([strings]) =>
      strings.join('?'),
    );
    const purchaseLock = sqls.findIndex((sql) =>
      sql.includes('SELECT "id" FROM "purchase_orders"'),
    );
    const lineLock = sqls.findIndex((sql) =>
      sql.includes('FROM "purchase_order_lines" l'),
    );
    const assetLock = sqls.findIndex((sql) => sql.includes('FROM "assets"'));
    expect(sqls[purchaseLock]).toContain('ORDER BY "id" FOR SHARE');
    expect(sqls[purchaseLock]).toContain('"assetModelId" = ?');
    expect(assetLock).toBeLessThan(purchaseLock);
    expect(purchaseLock).toBeLessThan(lineLock);
  });

  it('gives the delete transaction more than the 5 s default, so a model with many assets can still be deleted', async () => {
    seedDependents({ assets: Array.from({ length: 3000 }, (_, i) => `a${i}`) });
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: new Date() });

    await service.remove('m1', { strategy: 'detach' }, ADMIN);

    expect(asset.updateMany).toHaveBeenCalledTimes(1);
    expect(history.recordMany).toHaveBeenCalledTimes(1);
    expect(
      (history.recordMany.mock.calls[0] as [unknown, unknown[]])[1],
    ).toHaveLength(3000);
    const txCalls = (transaction.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'function',
    );
    expect(txCalls[0][1]).toEqual({ timeout: 30_000 });
  });

  it('the delete-impact preview counts live assets and open lines, listing each only for a reader', async () => {
    assetModel.findFirst.mockResolvedValue({ id: 'm1', deletedAt: null });
    asset.count.mockResolvedValue(4);
    asset.findMany.mockResolvedValue([
      { id: 'a1', name: 'LT-1', assetTag: 'IT-1' },
    ]);
    seedDependents({ lines: [{ id: 'l1', purchaseOrderId: 'po1' }] });
    const line = {
      id: 'l1',
      purchaseOrderId: 'po1',
      reference: 'PO-po1',
      description: 'Laptops',
    };

    await expect(service.deleteImpact('m1', ADMIN)).resolves.toEqual({
      assets: {
        total: 4,
        items: [{ id: 'a1', name: 'LT-1', assetTag: 'IT-1' }],
      },
      purchaseOrderLines: { total: 1, items: [line] },
    });
    expect(asset.count).toHaveBeenCalledWith({
      where: { modelId: 'm1', deletedAt: null },
    });
    expect(asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );

    readable = new Set();
    await expect(service.deleteImpact('m1', ADMIN)).resolves.toEqual({
      assets: { total: 4, items: null },
      purchaseOrderLines: { total: 1, items: null },
    });
  });

  // --- restore needs a live category (SEC-041) -------------------------------

  const archivedModel = (categoryId: string | null) => ({
    id: 'm1',
    categoryId,
    deletedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
  const categoryLockReturns = (live: boolean) =>
    queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('FROM "asset_categories"') && live
          ? [{ id: 'cat-1' }]
          : [],
      ),
    );

  it('refuses (409) to restore a model while its category is archived, and writes nothing', async () => {
    assetModel.findFirst.mockResolvedValue(archivedModel('cat-1'));
    categoryLockReturns(false);

    const err = await service.restore('m1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toContain(
      'Restore the category first',
    );
    expect(assetModel.update).not.toHaveBeenCalled();
  });

  it('restores a model whose category is live, locking the category FOR SHARE', async () => {
    assetModel.findFirst.mockResolvedValue(archivedModel('cat-1'));
    categoryLockReturns(true);
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: null });

    await service.restore('m1');

    const [sql, categoryId] = (queryRaw.mock.calls as RawCall[])[0];
    expect(sql.join('?')).toContain('FOR SHARE');
    expect(categoryId).toBe('cat-1');
    expect(assetModel.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { deletedAt: null },
    });
  });

  it('restores an uncategorized model without reading any category', async () => {
    assetModel.findFirst.mockResolvedValue(archivedModel(null));
    assetModel.update.mockResolvedValue({ id: 'm1', deletedAt: null });

    await service.restore('m1');

    expect(queryRaw).not.toHaveBeenCalled();
    expect(assetModel.update).toHaveBeenCalledTimes(1);
  });

  it('the delete-impact preview 404s for an archived model', async () => {
    assetModel.findFirst.mockResolvedValue(null);

    await expect(service.deleteImpact('old', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findPage without filters lists the active slice, newest first, and wraps a Page envelope', async () => {
    assetModel.findMany.mockResolvedValue([
      { id: 'm1', _count: { assets: 2 } },
    ]);
    assetModel.count.mockResolvedValue(1);

    const result = await service.findPage({}, PAGE);

    expect(assetModel.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      skip: 0,
      include: {
        _count: { select: { assets: { where: { deletedAt: null } } } },
      },
    });
    expect(assetModel.count).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
    expect(result).toEqual({
      items: [{ id: 'm1', usageCount: 2 }],
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
      expect.objectContaining({ orderBy: [{ name: 'asc' }, { id: 'desc' }] }),
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

  // --- usageCount (#1540) --------------------------------------------------
  it("findPage maps each row's live-asset count to usageCount (zero when unused), dropping _count", async () => {
    assetModel.findMany.mockResolvedValue([
      { id: 'm1', name: 'R740', _count: { assets: 7 } },
      { id: 'm2', name: 'X1', _count: { assets: 0 } },
    ]);
    assetModel.count.mockResolvedValue(2);

    const result = await service.findPage({}, PAGE);

    expect(result.items).toEqual([
      { id: 'm1', name: 'R740', usageCount: 7 },
      { id: 'm2', name: 'X1', usageCount: 0 },
    ]);
    expect(result.items[0]).not.toHaveProperty('_count');
  });

  it('findPage(only) still counts live assets of an archived model (the relation count is explicit)', async () => {
    assetModel.findMany.mockResolvedValue([
      { id: 'm1', deletedAt: new Date(), _count: { assets: 1 } },
    ]);
    assetModel.count.mockResolvedValue(1);

    const result = await service.findPage({}, { ...PAGE, deleted: 'only' });

    // The escape hatch widens the MODEL slice only; the asset count keeps deletedAt: null.
    expect(assetModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          _count: { select: { assets: { where: { deletedAt: null } } } },
        },
      }),
    );
    expect(result.items[0]).toMatchObject({ id: 'm1', usageCount: 1 });
  });

  it('findOne is unchanged: no relation count, no usageCount', async () => {
    const found = { id: 'm1', name: 'R740', deletedAt: null };
    assetModel.findFirst.mockResolvedValue(found);

    const row = await service.findOne('m1');

    expect(assetModel.findFirst).toHaveBeenCalledWith({ where: { id: 'm1' } });
    expect(row).not.toHaveProperty('usageCount');
  });
});
