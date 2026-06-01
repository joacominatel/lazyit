import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for types (erased at runtime), so an empty object is enough.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// AssetsService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaAssetMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

// The transaction client the service writes through. $transaction is mocked to invoke the callback
// with this `tx`, so create/update/remove run against these delegates and the history mock.
type TxAssetMock = {
  create: jest.Mock;
  update: jest.Mock;
};

// Shapes the create/update calls are cast to, so assertions stay type-safe (no-unsafe-* lint).
type AssetData = Record<string, unknown>;
type CreateCall = [{ data: AssetData }];
type UpdateCall = [{ where: { id: string }; data: AssetData }];

// A well-formed UUID used as the actor where a resolved actor matters.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
// Minimal User shape for tests — the full Prisma User type, but only id matters here.
type MinimalUser = { id: string };
const ACTOR_USER: MinimalUser = { id: ACTOR_ID };

// The nested relations the expanded reads request. Mirrors ASSET_RELATIONS in the service: model
// (+category), location, and the active owners (releasedAt null) each with their user.
const EXPECTED_INCLUDE = {
  model: { include: { category: true } },
  location: true,
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    include: { user: true },
  },
};

// The lean projection the paginated LIST (findPage) requests. Mirrors ASSET_LIST_SELECT in the
// service: every column EXCEPT the `specs` jsonb, plus trimmed joins (model+category, location,
// active owners). This is what asserts the lean select (no specs, trimmed relations).
const EXPECTED_LIST_SELECT = {
  id: true,
  name: true,
  serial: true,
  assetTag: true,
  status: true,
  notes: true,
  purchaseDate: true,
  warrantyEnd: true,
  modelId: true,
  locationId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  model: {
    select: {
      id: true,
      name: true,
      manufacturer: true,
      category: { select: { id: true, name: true } },
    },
  },
  location: { select: { id: true, name: true, type: true } },
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    select: {
      id: true,
      userId: true,
      user: {
        // `deletedAt` re-added so the list can dim a departed owner (ADR-0030 amendment).
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          deletedAt: true,
        },
      },
    },
  },
};

// A lean row as the LIST query returns it (no `specs`; trimmed joins) before the service renames
// `assignments` -> `activeAssignments`. Overridable per test.
const leanRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'SRV-01',
  serial: null,
  assetTag: null,
  status: 'OPERATIONAL',
  notes: null,
  purchaseDate: null,
  warrantyEnd: null,
  modelId: 'm1',
  locationId: 'l1',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  model: { id: 'm1', name: 'Latitude', manufacturer: 'Dell', category: null },
  location: { id: 'l1', name: 'HQ', type: 'OFFICE' },
  assignments: [
    {
      id: 'as1',
      userId: 'u1',
      user: {
        id: 'u1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.co',
        deletedAt: null,
      },
    },
  ],
  ...overrides,
});

// A raw Prisma row as returned by findMany/findFirst with the include (before the service maps
// `assignments` -> `activeAssignments`). Overridable per test.
const rawRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'SRV-01',
  serial: null,
  assetTag: null,
  status: 'OPERATIONAL',
  specs: null,
  notes: null,
  purchaseDate: null,
  warrantyEnd: null,
  modelId: 'm1',
  locationId: 'l1',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  model: { id: 'm1', name: 'Latitude', category: { id: 'c1', name: 'Laptop' } },
  location: { id: 'l1', name: 'HQ' },
  assignments: [
    {
      id: 'as1',
      assetId: 'a1',
      userId: 'u1',
      releasedAt: null,
      user: { id: 'u1' },
    },
  ],
  ...overrides,
});

// The `before` snapshot the service loads in update() (select of the change-tracked fields).
const beforeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  status: 'OPERATIONAL',
  locationId: 'l1',
  modelId: 'm1',
  specs: null,
  ...overrides,
});

describe('AssetsService', () => {
  let service: AssetsService;
  let asset: PrismaAssetMock;
  let tx: TxAssetMock;
  let prisma: {
    asset: PrismaAssetMock;
    $transaction: jest.Mock;
  };
  let actor: { resolve: jest.Mock };
  let history: { record: jest.Mock; list: jest.Mock };
  let search: { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

  beforeEach(async () => {
    asset = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    // The transaction client the writes go through; $transaction runs the callback with it.
    tx = { create: jest.fn(), update: jest.fn() };
    prisma = {
      asset,
      // create/update/remove pass a CALLBACK (interactive tx); findPage passes an ARRAY of two
      // promises (findMany + count). Support both forms.
      $transaction: jest.fn(
        (
          arg:
            | ((client: { asset: TxAssetMock }) => unknown)
            | Array<Promise<unknown>>,
        ) => (Array.isArray(arg) ? Promise.all(arg) : arg({ asset: tx })),
      ),
    };
    // ActorService is mocked; the guard validation detail lives in jwt-auth.guard.spec.ts. Here we
    // just steer resolve() and assert the service delegates to it. Default: no actor (undefined).
    // resolve() is now synchronous — mockReturnValue, not mockResolvedValue.
    actor = { resolve: jest.fn().mockReturnValue(undefined) };
    history = { record: jest.fn(), list: jest.fn() };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
        { provide: AssetHistoryService, useValue: history },
        { provide: SearchService, useValue: search },
      ],
    }).compile();

    service = moduleRef.get(AssetsService);
  });

  // --- create -------------------------------------------------------------
  it('creates an asset with specs and a purchase date (passed through, inside a transaction)', async () => {
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      specs: { ram: '128GB' },
      purchaseDate: '2026-01-15T00:00:00.000Z',
    };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.create).toHaveBeenCalledWith({ data: dto });
  });

  it('creates an asset without specs (no specs key sent to Prisma)', async () => {
    const dto = { name: 'SW-01', status: 'IN_STORAGE' as const };
    tx.create.mockResolvedValue({ id: 'a2', ...dto });

    await service.create(dto);

    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).not.toHaveProperty('specs');
    expect(calls[0][0].data).toEqual(dto);
  });

  it('records a CREATED history event for the new asset in the same transaction', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'CREATED', performedById: undefined },
    );
    // Fire-and-forget search sync after the commit (ADR-0035): the new asset is upserted.
    expect(search.upsert).toHaveBeenCalledWith('assets', {
      id: 'a1',
      name: 'SRV-01',
      serial: undefined,
      assetTag: undefined,
      status: 'OPERATIONAL',
      notes: undefined,
    });
  });

  it('resolves the actor via ActorService and stamps it onto the CREATED event', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto, ACTOR_USER as never);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_USER);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'CREATED', performedById: ACTOR_ID },
    );
  });

  it('propagates a thrown error from the actor resolver and never opens the transaction', async () => {
    actor.resolve.mockImplementation(() => {
      throw new BadRequestException();
    });

    await expect(
      service.create(
        { name: 'SRV-01', status: 'OPERATIONAL' },
        ACTOR_USER as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
  });

  // --- findOne (expanded) -------------------------------------------------
  it('findOne queries with the relations include + soft-delete filter', async () => {
    asset.findFirst.mockResolvedValue(rawRow());

    await service.findOne('a1');

    expect(asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1' },
      include: EXPECTED_INCLUDE,
    });
  });

  it('findOne maps assignments -> activeAssignments and inlines model/category/location', async () => {
    asset.findFirst.mockResolvedValue(rawRow());

    const result = await service.findOne('a1');

    expect(result).not.toHaveProperty('assignments');
    expect(result.activeAssignments).toEqual([
      {
        id: 'as1',
        assetId: 'a1',
        userId: 'u1',
        releasedAt: null,
        user: { id: 'u1' },
      },
    ]);
    expect(result.model).toEqual({
      id: 'm1',
      name: 'Latitude',
      category: { id: 'c1', name: 'Laptop' },
    });
    expect(result.location).toEqual({ id: 'l1', name: 'HQ' });
  });

  it('findOne passes nulls/empties through: model null, location null, no active assignments', async () => {
    asset.findFirst.mockResolvedValue(
      rawRow({ model: null, location: null, assignments: [] }),
    );

    const result = await service.findOne('a1');

    expect(result.model).toBeNull();
    expect(result.location).toBeNull();
    expect(result.activeAssignments).toEqual([]);
  });

  it('findOne returns model.category = null when the model has no category', async () => {
    asset.findFirst.mockResolvedValue(
      rawRow({ model: { id: 'm1', name: 'Generic', category: null } }),
    );

    const result = await service.findOne('a1');

    expect(result.model).toEqual({ id: 'm1', name: 'Generic', category: null });
  });

  it('findOne throws NotFound when the asset does not exist', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- findPage (paginated, lean) -----------------------------------------
  it('findPage uses the LEAN select (no specs; trimmed joins), newest first, with take/skip', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0 });

    expect(asset.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
      select: EXPECTED_LIST_SELECT,
    });
    // The lean select must NOT request the specs jsonb (the whole point of the projection).
    const selectArg = (
      asset.findMany.mock.calls as Array<[{ select: Record<string, unknown> }]>
    )[0][0].select;
    expect(selectArg).not.toHaveProperty('specs');
  });

  it('findPage runs findMany + count over the SAME where inside one $transaction', async () => {
    asset.findMany.mockResolvedValue([leanRow()]);
    asset.count.mockResolvedValue(7);

    const result = await service.findPage(
      { status: 'RETIRED', locationId: 'l1' },
      { limit: 10, offset: 20 },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const findManyArgs = (
      asset.findMany.mock.calls as Array<
        [{ where: unknown; take: number; skip: number }]
      >
    )[0][0];
    const countArgs = (
      asset.count.mock.calls as Array<[{ where: unknown }]>
    )[0][0];
    // Identical where feeds both queries; take/skip come from the window.
    expect(findManyArgs.where).toEqual({ locationId: 'l1', status: 'RETIRED' });
    expect(findManyArgs.take).toBe(10);
    expect(findManyArgs.skip).toBe(20);
    expect(countArgs.where).toEqual({ locationId: 'l1', status: 'RETIRED' });
    // The envelope echoes the window and carries the total.
    expect(result.total).toBe(7);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(20);
  });

  it('findPage maps each lean row assignments -> activeAssignments (no `assignments` key leaks)', async () => {
    asset.findMany.mockResolvedValue([
      leanRow({
        assignments: [
          { id: 'as1', userId: 'u1', user: { id: 'u1' } },
          { id: 'as2', userId: 'u2', user: { id: 'u2' } },
        ],
      }),
    ]);
    asset.count.mockResolvedValue(1);

    const result = await service.findPage({}, { limit: 50, offset: 0 });

    expect(result.items[0]).not.toHaveProperty('assignments');
    expect(result.items[0]).not.toHaveProperty('specs');
    expect(result.items[0].activeAssignments).toHaveLength(2);
  });

  it('the lean assignments select filters to active (releasedAt null) so released owners are excluded', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0 });

    const calls = asset.findMany.mock.calls as Array<
      [{ select: { assignments: { where: unknown } } }]
    >;
    expect(calls[0][0].select.assignments.where).toEqual({ releasedAt: null });
  });

  it('findPage filters by categoryId through the related model', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({ categoryId: 'c1' }, { limit: 50, offset: 0 });

    const findManyArgs = (
      asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(findManyArgs.where).toEqual({ model: { categoryId: 'c1' } });
  });

  it('findPage filters by q (case-insensitive OR over name/serial/assetTag)', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({ q: 'srv' }, { limit: 50, offset: 0 });

    const calls = asset.findMany.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'srv', mode: 'insensitive' } },
        { serial: { contains: 'srv', mode: 'insensitive' } },
        { assetTag: { contains: 'srv', mode: 'insensitive' } },
      ],
    });
  });

  // --- findPage server-side sort (ADR-0030 amendment) ---------------------
  it('findPage with no sort keeps the default createdAt desc order', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0 });

    const args = (
      asset.findMany.mock.calls as Array<[{ orderBy: unknown }]>
    )[0][0];
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('findPage honors an allowlisted sort field + direction (server-side, full set)', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'name', dir: 'asc' },
    );

    const args = (
      asset.findMany.mock.calls as Array<[{ orderBy: unknown }]>
    )[0][0];
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('findPage maps each sortable field (assetTag/status/updatedAt) to its column', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'status', dir: 'desc' },
    );
    const args = (
      asset.findMany.mock.calls as Array<[{ orderBy: unknown }]>
    )[0][0];
    expect(args.orderBy).toEqual({ status: 'desc' });
  });

  it('findPage REJECTS an unknown sort field with 400 (never silently ignored)', async () => {
    await expect(
      service.findPage({}, { limit: 50, offset: 0, sort: 'specs', dir: 'asc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The 400 is raised before any DB work.
    expect(asset.findMany).not.toHaveBeenCalled();
  });

  // --- batch (bulk) actions (ADR-0030 amendment) -------------------------
  it('batchRemove soft-deletes each live id with a PER-ITEM DELETED event in one transaction', async () => {
    // a1, a2 are live; a3 is not found.
    asset.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    tx.update.mockResolvedValue({});

    const result = await service.batchRemove(['a1', 'a2', 'a3']);

    // One transaction wraps the whole batch.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Per-item: one update + one DELETED history event per succeeded id (NOT one per batch).
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'DELETED', performedById: undefined },
    );
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a2', eventType: 'DELETED', performedById: undefined },
    );
    // Per-id outcome: a1/a2 succeeded, a3 skipped (not_found).
    expect(result).toEqual({
      requested: 3,
      succeeded: ['a1', 'a2'],
      skipped: [{ id: 'a3', reason: 'not_found' }],
    });
    // Each mutated id is dropped from the search index after the commit.
    expect(search.remove).toHaveBeenCalledWith('assets', 'a1');
    expect(search.remove).toHaveBeenCalledWith('assets', 'a2');
  });

  it('batchRemove with no live ids opens no transaction and reports all skipped', async () => {
    asset.findMany.mockResolvedValue([]);

    const result = await service.batchRemove(['x1', 'x2']);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.succeeded).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'x1', reason: 'not_found' },
      { id: 'x2', reason: 'not_found' },
    ]);
  });

  it('batchRestore restores soft-deleted ids, skips already-live, emits a PER-ITEM RESTORED event', async () => {
    // a1 soft-deleted (restored), a2 already live (skipped), a3 missing (skipped).
    asset.findMany.mockResolvedValue([
      { id: 'a1', deletedAt: new Date() },
      { id: 'a2', deletedAt: null },
    ]);
    tx.update.mockResolvedValue({});
    asset.findFirst.mockResolvedValue({ id: 'a1' }); // re-index read after commit

    const result = await service.batchRestore(['a1', 'a2', 'a3']);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'RESTORED', performedById: undefined },
    );
    expect(result).toEqual({
      requested: 3,
      succeeded: ['a1'],
      skipped: [
        { id: 'a2', reason: 'already_in_state' },
        { id: 'a3', reason: 'not_found' },
      ],
    });
  });

  it('batchSetStatus changes only differing ids, skips same-status, emits PER-ITEM STATUS_CHANGED', async () => {
    // a1 OPERATIONAL → RETIRED (changes), a2 already RETIRED (skipped), a3 missing (skipped).
    asset.findMany.mockResolvedValue([
      { id: 'a1', status: 'OPERATIONAL' },
      { id: 'a2', status: 'RETIRED' },
    ]);
    tx.update.mockResolvedValue({});
    asset.findFirst.mockResolvedValue({ id: 'a1' }); // re-index read after commit

    const result = await service.batchSetStatus(['a1', 'a2', 'a3'], 'RETIRED');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED' },
    });
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'STATUS_CHANGED',
        payload: { from: 'OPERATIONAL', to: 'RETIRED' },
        performedById: undefined,
      },
    );
    expect(result).toEqual({
      requested: 3,
      succeeded: ['a1'],
      skipped: [
        { id: 'a2', reason: 'already_in_state' },
        { id: 'a3', reason: 'not_found' },
      ],
    });
  });

  it('batch actions stamp the resolved actor onto every per-item event', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    asset.findMany.mockResolvedValue([{ id: 'a1' }]);
    tx.update.mockResolvedValue({});

    await service.batchRemove(['a1'], ACTOR_USER as never);

    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'DELETED', performedById: ACTOR_ID },
    );
  });

  // --- update -------------------------------------------------------------
  it('applies a partial update inside a transaction after loading the before snapshot', async () => {
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' });

    expect(asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1' },
      select: {
        id: true,
        status: true,
        locationId: true,
        modelId: true,
        specs: true,
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED' },
    });
    // Re-index the updated asset after the commit (ADR-0035); projects the returned row.
    expect(search.upsert).toHaveBeenCalledWith(
      'assets',
      expect.objectContaining({ id: 'a1', status: 'RETIRED' }),
    );
  });

  it('update throws NotFound (and never opens a transaction) when the asset is missing', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { status: 'RETIRED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('update resolves the actor via ActorService before opening the transaction', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' }, ACTOR_USER as never);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_USER);
    const calls = history.record.mock.calls as Array<
      [unknown, { performedById?: string }]
    >;
    expect(calls.every(([, event]) => event.performedById === ACTOR_ID)).toBe(
      true,
    );
  });

  it('emits STATUS_CHANGED with {from,to} when only the status changes', async () => {
    asset.findFirst.mockResolvedValue(beforeRow({ status: 'OPERATIONAL' }));
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' });

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'STATUS_CHANGED',
        payload: { from: 'OPERATIONAL', to: 'RETIRED' },
        performedById: undefined,
      },
    );
  });

  it('emits LOCATION_CHANGED with {from,to} when only the location changes', async () => {
    asset.findFirst.mockResolvedValue(beforeRow({ locationId: 'l1' }));
    tx.update.mockResolvedValue(beforeRow({ locationId: 'l2' }));

    await service.update('a1', { locationId: 'l2' });

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'LOCATION_CHANGED',
        payload: { from: 'l1', to: 'l2' },
        performedById: undefined,
      },
    );
  });

  it('emits MODEL_CHANGED with {from,to} when only the model changes', async () => {
    asset.findFirst.mockResolvedValue(beforeRow({ modelId: 'm1' }));
    tx.update.mockResolvedValue(beforeRow({ modelId: 'm2' }));

    await service.update('a1', { modelId: 'm2' });

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'MODEL_CHANGED',
        payload: { from: 'm1', to: 'm2' },
        performedById: undefined,
      },
    );
  });

  it('emits SPECS_CHANGED (no payload) when the specs change', async () => {
    asset.findFirst.mockResolvedValue(beforeRow({ specs: { ram: '64GB' } }));
    tx.update.mockResolvedValue(beforeRow({ specs: { ram: '128GB' } }));

    await service.update('a1', { specs: { ram: '128GB' } });

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'SPECS_CHANGED', performedById: undefined },
    );
  });

  it('emits a discrete event per changed field when several change at once', async () => {
    asset.findFirst.mockResolvedValue(
      beforeRow({ status: 'OPERATIONAL', locationId: 'l1' }),
    );
    tx.update.mockResolvedValue(
      beforeRow({ status: 'RETIRED', locationId: 'l2' }),
    );

    await service.update('a1', { status: 'RETIRED', locationId: 'l2' });

    const types = (
      history.record.mock.calls as Array<[unknown, { eventType: string }]>
    ).map(([, event]) => event.eventType);
    expect(types).toEqual(['STATUS_CHANGED', 'LOCATION_CHANGED']);
  });

  it('emits no history when an update changes none of the tracked fields', async () => {
    // notes is not a tracked dimension; the before/after of status/location/model/specs match.
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ notes: 'touch' }));

    await service.update('a1', { notes: 'touch' });

    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(history.record).not.toHaveBeenCalled();
  });

  it('treats an unchanged status (same value sent) as no STATUS_CHANGED event', async () => {
    asset.findFirst.mockResolvedValue(beforeRow({ status: 'OPERATIONAL' }));
    tx.update.mockResolvedValue(beforeRow({ status: 'OPERATIONAL' }));

    await service.update('a1', { status: 'OPERATIONAL' });

    expect(history.record).not.toHaveBeenCalled();
  });

  it('does not emit SPECS_CHANGED when the specs are structurally equal', async () => {
    const specs = { ram: '64GB' };
    asset.findFirst.mockResolvedValue(beforeRow({ specs }));
    tx.update.mockResolvedValue(beforeRow({ specs: { ram: '64GB' } }));

    await service.update('a1', { specs: { ram: '64GB' } });

    expect(history.record).not.toHaveBeenCalled();
  });

  it('does not emit a spurious SPECS_CHANGED when only the jsonb key ORDER differs', async () => {
    // jsonb does not preserve key order, so a re-save can come back with keys reordered. The deep
    // compare must treat this as no change (the false-positive this fix removes — see deep-equal.ts).
    asset.findFirst.mockResolvedValue(
      beforeRow({ specs: { cpu: 'i7', ram: '64GB' } }),
    );
    tx.update.mockResolvedValue(
      beforeRow({ specs: { ram: '64GB', cpu: 'i7' } }),
    );

    await service.update('a1', { specs: { ram: '64GB', cpu: 'i7' } });

    expect(history.record).not.toHaveBeenCalled();
  });

  // --- remove -------------------------------------------------------------
  it('soft-deletes by setting deletedAt inside a transaction (never hard delete)', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    tx.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'a1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    // Soft-delete drops the asset from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('assets', 'a1');
    expect(search.upsert).not.toHaveBeenCalled();
  });

  it('records a DELETED history event on soft delete', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    tx.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1', ACTOR_USER as never);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'DELETED', performedById: ACTOR_ID },
    );
  });

  it('does not soft-delete (or open a transaction) for an asset that is missing', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt and emits a RESTORED history event in the transaction', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    // 1st findFirst: the soft-deleted lookup (includeSoftDeleted). 2nd: findOne after restore.
    asset.findFirst
      .mockResolvedValueOnce({ id: 'a1', deletedAt: new Date() })
      .mockResolvedValueOnce({
        id: 'a1',
        deletedAt: null,
        assignments: [],
        model: null,
        location: null,
      });
    tx.update.mockResolvedValue({ id: 'a1', deletedAt: null });

    await service.restore('a1', ACTOR_USER as never);

    // The first lookup uses the includeSoftDeleted escape hatch (so a soft-deleted asset is visible).
    const firstLookup = asset.findFirst.mock.calls[0][0] as {
      includeSoftDeleted?: boolean;
    };
    expect(firstLookup.includeSoftDeleted).toBe(true);
    // deletedAt is cleared inside a transaction (never a plain update).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'a1' });
    expect(calls[0][0].data.deletedAt).toBeNull();
    // RESTORED is emitted atomically (ADR-0033/0041), attributed to the actor.
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'RESTORED', performedById: ACTOR_ID },
    );
    // Re-indexed after restore (ADR-0035).
    expect(search.upsert).toHaveBeenCalledWith(
      'assets',
      expect.objectContaining({ id: 'a1' }),
    );
  });

  it('restore is idempotent on an already-live asset: no transaction, no RESTORED event', async () => {
    asset.findFirst
      // The includeSoftDeleted lookup returns a live row (deletedAt null)...
      .mockResolvedValueOnce({ id: 'a1', deletedAt: null })
      // ...then findOne returns the expanded live row.
      .mockResolvedValueOnce({
        id: 'a1',
        deletedAt: null,
        assignments: [],
        model: null,
        location: null,
      });

    await service.restore('a1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('restore 404s (no transaction) when the asset never existed', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
  });
});
