import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { SearchService } from '../search/search.service';
import { AssetTagSchemeService } from '../asset-tag-scheme/asset-tag-scheme.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` mostly for types (erased at runtime), but `isUniqueTagCollision` (ADR-0063) does a real
// `instanceof Prisma.PrismaClientKnownRequestError` at runtime, so the factory provides that class
// (defined INSIDE the factory — jest.mock is hoisted, so an outer reference would hit the TDZ).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {
      constructor(
        public code: string,
        public meta?: { target?: string | string[] },
      ) {
        super(`prisma-${code}`);
      }
    },
  },
}));
// AssetsService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { Prisma } from '../../generated/prisma/client';
// The P2002 factory the collision-retry tests throw — a genuine instance of the mocked known-error
// class, so `isUniqueTagCollision`'s instanceof check matches it (ADR-0063 collision-retry). `meta.target`
// carries the offending index so the TARGET-AWARE guard is exercised for real: only an assetTag
// collision advances-and-retries; a serial collision must propagate without burning counter values.
const FakePrismaKnownError =
  Prisma.PrismaClientKnownRequestError as unknown as new (
    code: string,
    meta?: { target?: string | string[] },
  ) => Error & { code: string; meta?: { target?: string | string[] } };
// The raw partial-unique index names (migration 20260601130000). adapter-pg surfaces these by NAME on
// a P2002 (the indexes are raw SQL, unknown to Prisma's schema), so that is the real meta.target shape.
const ASSET_TAG_INDEX = 'assets_assetTag_active_key';
const SERIAL_INDEX = 'assets_serial_active_key';

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

type TxAssetModelMock = {
  findFirst: jest.Mock;
};

type TxClientMock = {
  asset: TxAssetMock;
  assetModel: TxAssetModelMock;
};

// Shapes the create/update calls are cast to, so assertions stay type-safe (no-unsafe-* lint).
type AssetData = Record<string, unknown>;
type CreateCall = [{ data: AssetData }];
type UpdateCall = [{ where: { id: string }; data: AssetData }];

// A well-formed UUID used as the human actor, and a service-account id (ADR-0048).
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
const SA_ID = 'sa_abcdefghijklmnopqrstuvwx';
// The unified principals passed to the service (the guard builds these at runtime). Cast through
// `never` so the test needn't shape the full User/ServiceAccount — only the actor id drives attribution.
const HUMAN_PRINCIPAL = { kind: 'human', user: { id: ACTOR_ID } } as never;
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(),
} as never;

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
  let txAssetModel: TxAssetModelMock;
  let txClient: TxClientMock;
  let prisma: {
    asset: PrismaAssetMock;
    $transaction: jest.Mock;
  };
  let actor: ActorService;
  let history: { record: jest.Mock; list: jest.Mock };
  let search: { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };
  let tagScheme: { allocateTag: jest.Mock };

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
    txAssetModel = { findFirst: jest.fn() };
    txClient = { asset: tx } as TxClientMock;
    // keep existing transaction assertions focused on the asset delegate
    Object.defineProperty(txClient, 'assetModel', { value: txAssetModel });
    prisma = {
      asset,
      // create/update/remove pass a CALLBACK (interactive tx); findPage passes an ARRAY of two
      // promises (findMany + count). Support both forms.
      $transaction: jest.fn(
        (arg: ((client: TxClientMock) => unknown) | Array<Promise<unknown>>) =>
          Array.isArray(arg) ? Promise.all(arg) : arg(txClient),
      ),
    };
    // ActorService is a pure, dependency-free resolver (the guard already validated the principal), so
    // the real instance is used — it produces the genuine ActorAttribution from the principal we pass.
    actor = new ActorService();
    history = { record: jest.fn(), list: jest.fn() };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // OFF by default (ADR-0063): allocateTag returns undefined, so the create path is unchanged for
    // every existing test. Allocation tests override this per-case.
    tagScheme = { allocateTag: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
        { provide: AssetHistoryService, useValue: history },
        { provide: SearchService, useValue: search },
        { provide: AssetTagSchemeService, useValue: tagScheme },
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

  it('copies model specs into a new asset when modelId is provided without asset specs', async () => {
    const dto = {
      name: 'LAT-01',
      status: 'OPERATIONAL' as const,
      modelId: 'm1',
    };
    txAssetModel.findFirst.mockResolvedValue({
      specs: { ram: '16GB', screen: '14', touch: false },
    });
    tx.create.mockResolvedValue({ id: 'a3', ...dto });

    await service.create(dto);

    expect(txAssetModel.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1' },
      select: { specs: true },
    });
    expect(tx.create).toHaveBeenCalledWith({
      data: {
        ...dto,
        specs: { ram: '16GB', screen: '14', touch: false },
      },
    });
  });

  it('merges model specs with explicit asset specs, with the asset winning conflicts', async () => {
    const dto = {
      name: 'LAT-02',
      status: 'OPERATIONAL' as const,
      modelId: 'm1',
      specs: { ram: '32GB', assetOnly: 'yes' },
    };
    txAssetModel.findFirst.mockResolvedValue({
      specs: { ram: '16GB', screen: '14', cpu: 'i5' },
    });
    tx.create.mockResolvedValue({ id: 'a4', ...dto });

    await service.create(dto);

    expect(tx.create).toHaveBeenCalledWith({
      data: {
        ...dto,
        specs: {
          ram: '32GB',
          screen: '14',
          cpu: 'i5',
          assetOnly: 'yes',
        },
      },
    });
  });

  it('rejects asset creation when the selected model is missing or soft-deleted', async () => {
    const dto = {
      name: 'LAT-03',
      status: 'OPERATIONAL' as const,
      modelId: 'missing-model',
    };
    txAssetModel.findFirst.mockResolvedValue(null);

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(tx.create).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
    expect(search.upsert).not.toHaveBeenCalled();
  });

  it('records a CREATED history event for the new asset in the same transaction', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'CREATED', actor: {} },
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

  it('resolves a HUMAN principal and stamps userId onto the CREATED event', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto, HUMAN_PRINCIPAL);

    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'CREATED', actor: { userId: ACTOR_ID } },
    );
  });

  it('resolves a SERVICE-ACCOUNT principal and stamps serviceAccountId onto the CREATED event — ADR-0048', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto, SA_PRINCIPAL);

    // The history row carries the SA attribution; AssetHistoryService maps it to serviceAccountId (and
    // never performedById), so the at-most-one-actor CHECK holds.
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'CREATED',
        actor: { serviceAccountId: SA_ID },
      },
    );
  });

  // --- asset-tag scheme allocation (ADR-0063 / #363) ----------------------

  it('OFF by default: allocateTag returns undefined → no assetTag key sent to Prisma', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    // allocateTag was asked (with the absent explicit tag) and declined → the data has no assetTag.
    expect(tagScheme.allocateTag).toHaveBeenCalledWith(undefined);
    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).not.toHaveProperty('assetTag');
  });

  it('enabled scheme auto-assigns the rendered tag when no explicit tag is supplied', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tagScheme.allocateTag.mockResolvedValueOnce('LAZY-00042');
    tx.create.mockResolvedValue({ id: 'a1', assetTag: 'LAZY-00042', ...dto });

    await service.create(dto);

    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.assetTag).toBe('LAZY-00042');
    expect(tx.create).toHaveBeenCalledTimes(1);
  });

  it('explicit assetTag ALWAYS wins — allocateTag is told the explicit tag and the explicit value is used', async () => {
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      assetTag: 'MANUAL-1',
    };
    // Even if the scheme would render something, allocateTag returns undefined for an explicit tag.
    tagScheme.allocateTag.mockResolvedValueOnce(undefined);
    tx.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(tagScheme.allocateTag).toHaveBeenCalledWith('MANUAL-1');
    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.assetTag).toBe('MANUAL-1');
  });

  it('retries with the NEXT counter value when the rendered tag collides on the ASSETTAG index (P2002)', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    // First allocation renders a colliding tag; the asset insert hits the live-tag partial unique
    // index (P2002 scoped to the assetTag index); the create advances to the next number and succeeds.
    tagScheme.allocateTag
      .mockResolvedValueOnce('LAZY-00042')
      .mockResolvedValueOnce('LAZY-00043');
    tx.create
      .mockRejectedValueOnce(
        new FakePrismaKnownError('P2002', { target: ASSET_TAG_INDEX }),
      )
      .mockResolvedValueOnce({ id: 'a1', assetTag: 'LAZY-00043', ...dto });

    const result = (await service.create(dto)) as { assetTag: string };

    expect(tagScheme.allocateTag).toHaveBeenCalledTimes(2);
    expect(tx.create).toHaveBeenCalledTimes(2);
    expect(result.assetTag).toBe('LAZY-00043');
  });

  it('does NOT retry when an auto-tag create hits the SERIAL index (P2002) — propagates, no extra counter burn', async () => {
    // Scheme enabled (auto-tag in play), but the conflict is a DUPLICATE SERIAL, not the tag. The
    // target-aware guard must NOT misclassify this as a tag collision: a single attempt, the P2002
    // propagates (→ 409 via the global filter), and allocateTag is called exactly ONCE (no counter waste).
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      serial: 'SN-1',
    };
    tagScheme.allocateTag.mockResolvedValue('LAZY-00042');
    tx.create.mockRejectedValue(
      new FakePrismaKnownError('P2002', { target: SERIAL_INDEX }),
    );

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      FakePrismaKnownError,
    );
    expect(tx.create).toHaveBeenCalledTimes(1);
    expect(tagScheme.allocateTag).toHaveBeenCalledTimes(1); // exactly one number consumed
  });

  it('an EXPLICIT-tag P2002 is NOT retried — it propagates (the caller picked a duplicate)', async () => {
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      assetTag: 'DUP-1',
    };
    tagScheme.allocateTag.mockResolvedValue(undefined);
    // An explicit tag took a value already in use → P2002 on the assetTag index, but it must still
    // propagate (the retry-only-on-auto-tag guard in create() short-circuits before the predicate).
    tx.create.mockRejectedValue(
      new FakePrismaKnownError('P2002', { target: ASSET_TAG_INDEX }),
    );

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      FakePrismaKnownError,
    );
    // No advance-and-retry for an explicit tag: a single attempt, then the P2002 propagates.
    expect(tx.create).toHaveBeenCalledTimes(1);
  });

  it('throws 409 after exhausting the bounded retry budget on persistent ASSETTAG collisions', async () => {
    const dto = { name: 'SRV-01', status: 'OPERATIONAL' as const };
    tagScheme.allocateTag.mockResolvedValue('LAZY-00042'); // always renders a colliding tag
    tx.create.mockRejectedValue(
      new FakePrismaKnownError('P2002', { target: ASSET_TAG_INDEX }),
    ); // always collides on the assetTag index

    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.create).toHaveBeenCalledTimes(
      AssetTagSchemeService.MAX_ALLOCATION_ATTEMPTS,
    );
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

    await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

    expect(asset.findMany).toHaveBeenCalledWith({
      // The default `active` slice scopes the list to live assets (ADR-0041).
      where: { deletedAt: null },
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
      { limit: 10, offset: 20, deleted: 'active' },
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
    // Identical where feeds both queries (incl. the live-rows scope); take/skip come from the window.
    expect(findManyArgs.where).toEqual({
      locationId: 'l1',
      status: 'RETIRED',
      deletedAt: null,
    });
    expect(findManyArgs.take).toBe(10);
    expect(findManyArgs.skip).toBe(20);
    expect(countArgs.where).toEqual({
      locationId: 'l1',
      status: 'RETIRED',
      deletedAt: null,
    });
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

    const result = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(result.items[0]).not.toHaveProperty('assignments');
    expect(result.items[0]).not.toHaveProperty('specs');
    expect(result.items[0].activeAssignments).toHaveLength(2);
  });

  it('the lean assignments select filters to active (releasedAt null) so released owners are excluded', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

    const calls = asset.findMany.mock.calls as Array<
      [{ select: { assignments: { where: unknown } } }]
    >;
    expect(calls[0][0].select.assignments.where).toEqual({ releasedAt: null });
  });

  it('findPage filters by categoryId through the related model', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage(
      { categoryId: 'c1' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const findManyArgs = (
      asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(findManyArgs.where).toEqual({
      model: { categoryId: 'c1' },
      deletedAt: null,
    });
  });

  it('findPage filters by assignedToUserId: only assets with a LIVE assignment to that user', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage(
      { assignedToUserId: 'u-uuid-1' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const findManyArgs = (
      asset.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    // Owner = a live assignment (releasedAt null) to the user; released owners are excluded.
    expect(findManyArgs.where).toEqual({
      assignments: { some: { userId: 'u-uuid-1', releasedAt: null } },
      deletedAt: null,
    });
    // The count query must filter on the SAME where so total matches the page.
    const countArgs = (
      asset.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(countArgs.where).toEqual({
      assignments: { some: { userId: 'u-uuid-1', releasedAt: null } },
      deletedAt: null,
    });
  });

  it('findPage filters by q (case-insensitive OR over name/serial/assetTag)', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage(
      { q: 'srv' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const calls = asset.findMany.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'srv', mode: 'insensitive' } },
        { serial: { contains: 'srv', mode: 'insensitive' } },
        { assetTag: { contains: 'srv', mode: 'insensitive' } },
      ],
      deletedAt: null,
    });
  });

  it('findPage deleted=only returns soft-deleted assets via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0, deleted: 'only' });

    const findManyArgs = (
      asset.findMany.mock.calls as Array<
        [{ where: unknown; includeSoftDeleted?: boolean }]
      >
    )[0][0];
    expect(findManyArgs.where).toEqual({ deletedAt: { not: null } });
    expect(findManyArgs.includeSoftDeleted).toBe(true);
    const countArgs = (
      asset.count.mock.calls as Array<
        [{ where: unknown; includeSoftDeleted?: boolean }]
      >
    )[0][0];
    expect(countArgs.where).toEqual({ deletedAt: { not: null } });
    expect(countArgs.includeSoftDeleted).toBe(true);
  });

  // --- findPage server-side sort (ADR-0030 amendment) ---------------------
  it('findPage with no sort keeps the default createdAt desc order', async () => {
    asset.findMany.mockResolvedValue([]);
    asset.count.mockResolvedValue(0);

    await service.findPage({}, { limit: 50, offset: 0, deleted: 'active' });

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
      { limit: 50, offset: 0, sort: 'name', dir: 'asc', deleted: 'active' },
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
      { limit: 50, offset: 0, sort: 'status', dir: 'desc', deleted: 'active' },
    );
    const args = (
      asset.findMany.mock.calls as Array<[{ orderBy: unknown }]>
    )[0][0];
    expect(args.orderBy).toEqual({ status: 'desc' });
  });

  it('findPage REJECTS an unknown sort field with 400 (never silently ignored)', async () => {
    await expect(
      service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'specs', dir: 'asc', deleted: 'active' },
      ),
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
      { assetId: 'a1', eventType: 'DELETED', actor: {} },
    );
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a2', eventType: 'DELETED', actor: {} },
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
    asset.findMany
      .mockResolvedValueOnce([
        { id: 'a1', deletedAt: new Date() },
        { id: 'a2', deletedAt: null },
      ])
      .mockResolvedValueOnce([{ id: 'a1' }]); // single batched re-index read after commit (#596)
    tx.update.mockResolvedValue({});

    const result = await service.batchRestore(['a1', 'a2', 'a3']);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'RESTORED', actor: {} },
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

  it('batchRestore gathers re-index rows in ONE findMany regardless of batch size — #596 N+1 collapse', async () => {
    // 3 soft-deleted ids all restore. The re-index must be a SINGLE findMany({ id: { in } }), not 1/id.
    const deleted = [
      { id: 'a1', deletedAt: new Date() },
      { id: 'a2', deletedAt: new Date() },
      { id: 'a3', deletedAt: new Date() },
    ];
    asset.findMany
      .mockResolvedValueOnce(deleted) // gather pass (with includeSoftDeleted)
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]); // ONE batched re-index read
    tx.update.mockResolvedValue({});

    await service.batchRestore(['a1', 'a2', 'a3']);

    // Exactly two findMany: the gather + ONE re-index read (never one per succeeded id).
    expect(asset.findMany).toHaveBeenCalledTimes(2);
    expect(asset.findFirst).not.toHaveBeenCalled();
    const reindexArgs = (
      asset.findMany.mock.calls as Array<[{ where?: Record<string, unknown> }]>
    )[1][0];
    expect(reindexArgs.where).toEqual({ id: { in: ['a1', 'a2', 'a3'] } });
    // Search doc upserted once per mutated row (3 rows → 3 upserts).
    expect(search.upsert).toHaveBeenCalledTimes(3);
  });

  it('batchSetStatus changes only differing ids, skips same-status, emits PER-ITEM STATUS_CHANGED', async () => {
    // a1 OPERATIONAL → RETIRED (changes), a2 already RETIRED (skipped), a3 missing (skipped).
    asset.findMany
      .mockResolvedValueOnce([
        { id: 'a1', status: 'OPERATIONAL' },
        { id: 'a2', status: 'RETIRED' },
      ])
      .mockResolvedValueOnce([{ id: 'a1' }]); // single batched re-index read after commit (#596)
    tx.update.mockResolvedValue({});

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
        actor: {},
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

  it('batchSetStatus gathers re-index rows in ONE findMany regardless of batch size — #596 N+1 collapse', async () => {
    // 3 ids all change status. The re-index must be a SINGLE findMany({ id: { in } }), not 1/id.
    asset.findMany
      .mockResolvedValueOnce([
        { id: 'a1', status: 'OPERATIONAL' },
        { id: 'a2', status: 'OPERATIONAL' },
        { id: 'a3', status: 'OPERATIONAL' },
      ]) // gather pass
      .mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]); // ONE batched re-index read
    tx.update.mockResolvedValue({});

    await service.batchSetStatus(['a1', 'a2', 'a3'], 'RETIRED');

    // Exactly two findMany: the gather + ONE re-index read (never one per succeeded id).
    expect(asset.findMany).toHaveBeenCalledTimes(2);
    expect(asset.findFirst).not.toHaveBeenCalled();
    const reindexArgs = (
      asset.findMany.mock.calls as Array<[{ where?: Record<string, unknown> }]>
    )[1][0];
    expect(reindexArgs.where).toEqual({ id: { in: ['a1', 'a2', 'a3'] } });
    // Search doc upserted once per mutated row (3 rows → 3 upserts).
    expect(search.upsert).toHaveBeenCalledTimes(3);
  });

  it('batch actions stamp a HUMAN principal onto every per-item event', async () => {
    asset.findMany.mockResolvedValue([{ id: 'a1' }]);
    tx.update.mockResolvedValue({});

    await service.batchRemove(['a1'], HUMAN_PRINCIPAL);

    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'DELETED', actor: { userId: ACTOR_ID } },
    );
  });

  it('batch actions stamp a SERVICE-ACCOUNT principal onto every per-item event — ADR-0048', async () => {
    asset.findMany.mockResolvedValue([{ id: 'a1' }]);
    tx.update.mockResolvedValue({});

    await service.batchRemove(['a1'], SA_PRINCIPAL);

    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      {
        assetId: 'a1',
        eventType: 'DELETED',
        actor: { serviceAccountId: SA_ID },
      },
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

  it('update resolves a HUMAN principal and stamps userId onto every change event', async () => {
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' }, HUMAN_PRINCIPAL);

    const calls = history.record.mock.calls as Array<
      [unknown, { actor?: { userId?: string; serviceAccountId?: string } }]
    >;
    expect(calls.every(([, event]) => event.actor?.userId === ACTOR_ID)).toBe(
      true,
    );
  });

  it('update resolves a SERVICE-ACCOUNT principal and stamps serviceAccountId onto every change event — ADR-0048', async () => {
    asset.findFirst.mockResolvedValue(beforeRow());
    tx.update.mockResolvedValue(beforeRow({ status: 'RETIRED' }));

    await service.update('a1', { status: 'RETIRED' }, SA_PRINCIPAL);

    const calls = history.record.mock.calls as Array<
      [unknown, { actor?: { userId?: string; serviceAccountId?: string } }]
    >;
    expect(
      calls.every(
        ([, event]) =>
          event.actor?.serviceAccountId === SA_ID &&
          event.actor?.userId === undefined,
      ),
    ).toBe(true);
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
        actor: {},
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
        actor: {},
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
        actor: {},
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
      { assetId: 'a1', eventType: 'SPECS_CHANGED', actor: {} },
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

  it('records a DELETED history event on soft delete, attributed to the HUMAN', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    tx.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1', HUMAN_PRINCIPAL);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'DELETED', actor: { userId: ACTOR_ID } },
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

    await service.restore('a1', HUMAN_PRINCIPAL);

    // The first lookup uses the includeSoftDeleted escape hatch (so a soft-deleted asset is visible).
    const lookups = asset.findFirst.mock.calls as Array<
      [{ includeSoftDeleted?: boolean }]
    >;
    expect(lookups[0][0].includeSoftDeleted).toBe(true);
    // deletedAt is cleared inside a transaction (never a plain update).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'a1' });
    expect(calls[0][0].data.deletedAt).toBeNull();
    // RESTORED is emitted atomically (ADR-0033/0041), attributed to the human actor.
    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { asset: tx },
      { assetId: 'a1', eventType: 'RESTORED', actor: { userId: ACTOR_ID } },
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
