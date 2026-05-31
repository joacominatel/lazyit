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

// A well-formed UUID used as the X-User-Id actor where a resolved actor matters.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

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
      count: jest.fn().mockResolvedValue(0),
    };
    // The transaction client the writes go through; $transaction runs the callback with it.
    tx = { create: jest.fn(), update: jest.fn() };
    prisma = {
      asset,
      // Two transaction forms: the writes use the interactive (callback) form; the paginated list
      // (findPage) uses the array/batch form ([findMany, count]) — resolve those promises together.
      $transaction: jest.fn(
        (arg: ((client: { asset: TxAssetMock }) => unknown) | Promise<unknown>[]) =>
          Array.isArray(arg) ? Promise.all(arg) : arg({ asset: tx }),
      ),
    };
    // ActorService is mocked; the shim-validation details live in actor.service.spec.ts. Here we
    // just steer resolve() and assert the service delegates to it. Default: no actor (undefined).
    actor = { resolve: jest.fn().mockResolvedValue(undefined) };
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
    actor.resolve.mockResolvedValue(ACTOR_ID);
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto, ACTOR_ID);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_ID);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'CREATED', performedById: ACTOR_ID },
    );
  });

  it('propagates a BadRequest from the actor shim and never opens the transaction', async () => {
    actor.resolve.mockRejectedValue(new BadRequestException());

    await expect(
      service.create({ name: 'SRV-01', status: 'OPERATIONAL' }, 'bad'),
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

  // --- findPage (lean, paginated — ADR-0030) ------------------------------
  // A lean list row: the `specs` jsonb is omitted and the relations are trimmed; `assignments` is
  // still renamed to `activeAssignments` by the service. Default page (no offset/page) → skip 0.
  const DEFAULT_PAGE = { limit: 50, offset: undefined, page: undefined } as const;
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
      { id: 'as1', assetId: 'a1', userId: 'u1', assignedAt: new Date(), user: { id: 'u1' } },
    ],
    ...overrides,
  });

  it('findPage without filters: default window (take 50, skip 0), newest first, lean select', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, DEFAULT_PAGE);

    const calls = asset.findMany.mock.calls as Array<
      [{ where: unknown; orderBy: unknown; select: unknown; take: number; skip: number }]
    >;
    expect(calls[0][0].where).toEqual({});
    expect(calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    expect(calls[0][0].take).toBe(50);
    expect(calls[0][0].skip).toBe(0);
    // Lean select: no `specs`, and it is a `select` (not an `include`).
    expect(calls[0][0]).not.toHaveProperty('include');
    const select = calls[0][0].select as Record<string, unknown>;
    expect(select).not.toHaveProperty('specs');
    expect(select.id).toBe(true);
  });

  it('findPage returns a Page envelope: items mapped + the matching total', async () => {
    asset.findMany.mockResolvedValue([leanRow()]);
    asset.count.mockResolvedValue(7);

    const result = await service.findPage({}, { limit: 50, offset: 0, page: undefined });

    expect(result.total).toBe(7);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
    expect(result.items[0]).not.toHaveProperty('assignments');
    expect(result.items[0]).not.toHaveProperty('specs');
    expect(result.items[0].activeAssignments).toHaveLength(1);
  });

  it('findPage applies an explicit limit/offset window', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 10, offset: 20, page: undefined });

    const calls = asset.findMany.mock.calls as Array<[{ take: number; skip: number }]>;
    expect(calls[0][0].take).toBe(10);
    expect(calls[0][0].skip).toBe(20);
  });

  it('the assignments select filters to active (releasedAt null) so released owners are excluded', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findPage({}, DEFAULT_PAGE);

    const calls = asset.findMany.mock.calls as Array<
      [{ select: { assignments: { where: unknown } } }]
    >;
    expect(calls[0][0].select.assignments.where).toEqual({ releasedAt: null });
  });

  it('findPage filters by status and locationId (same where feeds findMany and count)', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findPage({ status: 'RETIRED', locationId: 'l1' }, DEFAULT_PAGE);

    const findManyWhere = (
      asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0].where;
    const countWhere = (
      asset.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0].where;
    expect(findManyWhere).toEqual({ locationId: 'l1', status: 'RETIRED' });
    expect(countWhere).toEqual(findManyWhere);
  });

  it('findPage filters by categoryId through the related model', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findPage({ categoryId: 'c1' }, DEFAULT_PAGE);

    const calls = asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>;
    expect(calls[0][0].where).toEqual({ model: { categoryId: 'c1' } });
  });

  it('findPage filters by q (case-insensitive OR over name/serial/assetTag)', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findPage({ q: 'srv' }, DEFAULT_PAGE);

    const calls = asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>;
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'srv', mode: 'insensitive' } },
        { serial: { contains: 'srv', mode: 'insensitive' } },
        { assetTag: { contains: 'srv', mode: 'insensitive' } },
      ],
    });
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
    actor.resolve.mockResolvedValue(ACTOR_ID);
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' }, ACTOR_ID);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_ID);
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

  it('does not emit SPECS_CHANGED when specs are deep-equal (compared by JSON)', async () => {
    const specs = { ram: '64GB' };
    asset.findFirst.mockResolvedValue(beforeRow({ specs }));
    tx.update.mockResolvedValue(beforeRow({ specs: { ram: '64GB' } }));

    await service.update('a1', { specs: { ram: '64GB' } });

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
    actor.resolve.mockResolvedValue(ACTOR_ID);
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    tx.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1', ACTOR_ID);

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
});
